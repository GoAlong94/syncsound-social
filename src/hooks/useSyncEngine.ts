import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

// ============================================================================
// PART 1: ADVANCED MATH, CONTROL THEORY & STATISTICAL FILTERS
// ============================================================================

/**
 * 1D Kalman Filter for Network RTT
 * Filters out extreme 4G/5G mobile network spikes to find the "true" latency.
 */
class KalmanFilter {
  private r: number; // Measurement noise covariance
  private q: number; // Process noise covariance
  private p: number; // Estimation error covariance
  private x: number; // Value estimate
  private k: number; // Kalman gain

  constructor(r: number = 10, q: number = 0.1, initial_p: number = 1, initial_x: number = 0) {
    this.r = r; this.q = q; this.p = initial_p; this.x = initial_x; this.k = 0;
  }

  filter(measurement: number): number {
    if (this.x === 0) { this.x = measurement; return measurement; }
    // Prediction update
    this.p = this.p + this.q;
    // Measurement update
    this.k = this.p / (this.p + this.r);
    this.x = this.x + this.k * (measurement - this.x);
    this.p = (1 - this.k) * this.p;
    return this.x;
  }
}

/**
 * Interquartile Range (IQR) & Exponential Moving Average (EMA) Analyzer
 * Used for establishing precise UTC offsets bypassing asymmetric routing.
 */
class NetworkTimeAnalyzer {
  private history: { rtt: number, offset: number }[] = [];
  private maxSize = 30;
  private emaOffset: number | null = null;
  private alpha = 0.15; // EMA smoothing factor

  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    if (this.history.length > this.maxSize) this.history.shift();
  }

  getFilteredMetrics(): { offset: number, jitter: number, rtt: number } {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    if (this.history.length < 5) {
       const latest = this.history[this.history.length - 1];
       return { offset: latest.offset, jitter: 50, rtt: latest.rtt };
    }

    // Sort by RTT to isolate the most direct network paths (no congestion)
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const q1 = Math.floor(sorted.length * 0.20);
    const q3 = Math.floor(sorted.length * 0.50); // Heavily bias towards faster packets
    const bestPackets = sorted.slice(q1, q3 + 1);

    let sumOffset = 0, sumRtt = 0;
    bestPackets.forEach(sample => { sumOffset += sample.offset; sumRtt += sample.rtt; });
    const avgOffset = sumOffset / bestPackets.length;
    const avgRtt = sumRtt / bestPackets.length;

    // Jitter calculation (Standard Deviation of RTTs)
    const variance = bestPackets.reduce((acc, val) => acc + Math.pow(val.rtt - avgRtt, 2), 0) / bestPackets.length;
    const jitter = Math.sqrt(variance);

    // Apply EMA to offset for smooth Phase-Locked Loop integration
    if (this.emaOffset === null) this.emaOffset = avgOffset;
    else this.emaOffset = (this.alpha * avgOffset) + ((1 - this.alpha) * this.emaOffset);

    return { offset: this.emaOffset, jitter, rtt: avgRtt };
  }
}

/**
 * Advanced PID Controller with Anti-Windup & Derivative Low-Pass Filter
 * Learns the exact hardware decoding delay of specific phones.
 */
class AdvancedPID {
  private kp: number; private ki: number; private kd: number;
  private integral: number = 0; private prevError: number = 0;
  private minOut: number; private maxOut: number;
  private lastDerivative: number = 0;

  constructor(kp: number, ki: number, kd: number, minOut: number, maxOut: number) {
    this.kp = kp; this.ki = ki; this.kd = kd; this.minOut = minOut; this.maxOut = maxOut;
  }

  calculate(error: number, dt: number): number {
    if (dt <= 0) return 0;

    // Proportional
    const p = this.kp * error;

    // Integral with Anti-Windup (Stops integral from exploding during massive lag)
    this.integral += error * dt;
    const i = this.ki * this.integral;
    if (i > this.maxOut) this.integral = this.maxOut / this.ki;
    else if (i < this.minOut) this.integral = this.minOut / this.ki;

    // Derivative with Low-Pass Filter (Prevents violent reactions to single stutters)
    let rawDerivative = (error - this.prevError) / dt;
    const derivative = (0.7 * rawDerivative) + (0.3 * this.lastDerivative);
    this.lastDerivative = derivative;
    const d = this.kd * derivative;

    this.prevError = error;

    let output = p + i + d;
    return Math.max(this.minOut, Math.min(this.maxOut, output));
  }

  reset() { this.integral = 0; this.prevError = 0; this.lastDerivative = 0; }
}

// ============================================================================
// PART 2: DEVICE HEURISTICS & SYSTEM CONSTANTS
// ============================================================================

const getDeviceAudioPipelineOffset = (os: string, browser: string): number => {
  // Physical delays in audio stacks (DAC + OS Mixer + Browser Media Pipeline)
  if (os === 'iOS') return 0.055; // CoreAudio mobile pipeline
  if (os === 'macOS' && browser.includes('Safari')) return 0.025; // CoreAudio desktop optimized
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035; 
  if (os === 'Android') return 0.090; // Android AudioFlinger has notorious physical latency
  if (os === 'Windows') return 0.045; // WASAPI / DirectSound
  return 0.040; // Fallback
};

interface UseSyncEngineProps {
  roomId: string; isHost: boolean; userId: string;
  getCurrentTime: () => number; seekTo: (time: number) => void;
  setPlaybackRate: (rate: number) => void; play: () => void; pause: () => void;
  getPlayerState: () => number;
  onVideoChange?: (videoId: string, title: string, thumbnail: string) => void;
  onQueueUpdate?: (queue: QueueState) => void;
}

interface EpochState {
  isPlaying: boolean; startNetworkTime: number; startVideoTime: number;
  videoId: string | null; hostUpdateId: number; stateSequence: number;
}

// ============================================================================
// PART 3: THE OMEGA SYNC ENGINE
// ============================================================================

export const useSyncEngine = ({
  roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate,
}: UseSyncEngineProps) => {

  // --- External Connections ---
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  
  // --- UI Metrics ---
  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);

  // --- Immutable Ref Handlers (Stops React Re-renders from destroying timing) ---
  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; });

  // --- Network & Mathematical State ---
  const rttKalman = useRef(new KalmanFilter(15, 0.5, 1, 0)); // Highly responsive Kalman for RTT
  const timeAnalyzer = useRef(new NetworkTimeAnalyzer());
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const deviceInfo = useRef(getDeviceInfo());
  
  // The Master Sync Protocol State
  const playbackEpochRef = useRef<EpochState>({
    isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, hostUpdateId: 0, stateSequence: 0
  });

  // --- Execution Locks & AI Trackers ---
  const ignoreSyncUntilRef = useRef<number>(0);
  const softGlideUntilRef = useRef<number>(0);
  const catchupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wakeLockRef = useRef<any>(null);

  // AI Hardware Penalty Controller
  const deviceBasePenalty = deviceInfo.current.os === 'iOS' ? 0.350 : (deviceInfo.current.os === 'Android' ? 0.450 : 0.150);
  const currentPenaltyRef = useRef<number>(deviceBasePenalty);
  const hardwarePidRef = useRef(new AdvancedPID(0.5, 0.05, 0.1, -0.200, 1.500)); 
  const consecutiveMissesRef = useRef<number>(0);
  const lastSeekTimeRef = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const epochSequenceCounterRef = useRef<number>(0);

  // --- Telemetry Subsystem ---
  const syncLogs = useRef<any[]>([]);
  const logEvent = useCallback((event: string, data: any) => {
    syncLogs.current.push({ t: new Date().toISOString(), role: isHost ? 'HOST' : 'JOINER', e: event, ...data });
    if (syncLogs.current.length > 2500) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syncLogs.current, null, 2));
    const a = document.createElement('a');
    a.href = dataStr; a.download = `sync_omega_log_${isHost ? 'host' : 'joiner'}_${userId.slice(0,5)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }, [isHost, userId]);

  // ============================================================================
  // SYSTEM WAKE & BACKGROUND MANAGEMENT
  // ============================================================================
  useEffect(() => {
    const acquireWakeLock = async () => {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        try { wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); } catch (e) {}
      }
    };
    acquireWakeLock();
    const handleVis = () => { 
      if (document.visibilityState === 'visible') {
         acquireWakeLock();
         if (!isHost) {
            logEvent('APP_FOREGROUNDED', { action: 'Force Resync Protocol' });
            ignoreSyncUntilRef.current = 0; // Break all locks
            requestSync(); 
            measureLatency();
         }
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [isHost]);

  // ============================================================================
  // NETWORK TOPOLOGY & NTP PING ENGINE
  // ============================================================================
  const measureLatency = useCallback(() => {
    if (!channelRef.current) return;
    channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
  }, [userId]);

  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    channelRef.current.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } });
  }, [isHost, userId]);

  const manualResync = useCallback(() => {
    if (isHost) return;
    setSyncStatus('syncing');
    timeAnalyzer.current = new NetworkTimeAnalyzer(); // Purge old data
    rttKalman.current = new KalmanFilter(15, 0.5, 1, 0);
    requestSync();
    // Burst pings to rebuild statistics
    for(let i=0; i<5; i++) setTimeout(measureLatency, i*100);
  }, [isHost, requestSync, measureLatency]);

  // ============================================================================
  // MEDIA MANIPULATORS (HARD SEEK & SOFT GLIDE)
  // ============================================================================
  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs: number = 2000) => {
    logEvent('HARD_SEEK', { target: time, reason });
    if (catchupTimeoutRef.current) { clearTimeout(catchupTimeoutRef.current); catchupTimeoutRef.current = null; }
    
    handlers.current.seekTo(time);
    if (playbackEpochRef.current.isPlaying) handlers.current.play();
    else handlers.current.pause();
    
    ignoreSyncUntilRef.current = Date.now() + lockoutMs; 
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number) => {
      // YouTube Iframe allows 0.25, 0.5, 0.75, 1.0, 1.25, 1.5. 
      // To catch up smoothly, we use 0.75x speed. 
      // At 0.75x, we lose 0.25s of virtual time for every 1.00s of real time.
      const rate = 0.75;
      const virtualLossPerSec = 1.0 - rate;
      const holdTimeMs = Math.min((driftSeconds / virtualLossPerSec) * 1000, 1500); // Max 1.5s glide
      
      logEvent('SOFT_GLIDE_INIT', { driftSeconds, holdTimeMs, rate });
      handlers.current.setPlaybackRate(rate);
      
      softGlideUntilRef.current = Date.now() + holdTimeMs;
      ignoreSyncUntilRef.current = Date.now() + holdTimeMs + 200; // Lock evaluator

      setTimeout(() => {
          handlers.current.setPlaybackRate(1.0);
          logEvent('SOFT_GLIDE_END', { rate: 1.0 });
      }, holdTimeMs);
  }, [logEvent]);


  // ============================================================================
  // SUPABASE WEBRTC BUS & CORE LOGIC
  // ============================================================================
  useEffect(() => {
    logEvent('BOOT_NTP_BUS', { roomId, userId });
    
    const channel = supabase.channel(`room:${roomId}`, {
      config: { presence: { key: userId }, broadcast: { self: false } },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const devices: PresenceState[] = Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping, os: p.os || '?', browser: p.browser || '?', 
        syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, lastSyncDelta: p.lastSyncDelta || 0, jitter: p.jitter || 0
      }));
      setConnectedDevices(devices);
    });

    // --- NTP CLOCK SYNC PROTOCOL ---
    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.sId !== userId) {
        channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId) {
        const now = Date.now();
        const rawRtt = now - payload.t;
        const filteredRtt = rttKalman.current.filter(rawRtt); // Kalman denoise
        
        // Calculate asymmetric offset
        const rawOffset = payload.ht - payload.t - (filteredRtt / 2);
        
        // Push to statistical analyzer
        timeAnalyzer.current.addSample(filteredRtt, rawOffset);
        const { offset, jitter, rtt } = timeAnalyzer.current.getFilteredMetrics();
        
        clockOffsetRef.current = offset;
        setLatency(Math.round(rtt));
        setNetworkJitter(Math.round(jitter));
        
        // Only update presence track occasionally to save DB limits
        if (Math.random() < 0.2) {
           channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: syncStatusRef.current, latency: Math.round(rtt), lastSyncDelta: lastSyncDelta, jitter: Math.round(jitter) });
        }
      }
    });

    // ============================================================================
    // THE AI PLAYBACK EVALUATOR (JOINER)
    // ============================================================================
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;
      
      // UDP Sequence enforcement (Ignore old packets arriving late)
      if (payload.hostUpdateId < playbackEpochRef.current.hostUpdateId) return;
      playbackEpochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync(); return;
      }

      const networkTime = Date.now() + clockOffsetRef.current;
      let newStatus: SyncStatus = 'synced';

      const isPlayingNow = payload.isPlaying;
      const justResumed = isPlayingNow && !wasPlayingRef.current;
      wasPlayingRef.current = isPlayingNow;

      if (isPlayingNow) {
        // --- BYPASS LOCKS ---
        if (Date.now() < ignoreSyncUntilRef.current) return;
        if (Date.now() < softGlideUntilRef.current) return;

        // --- PIPELINE DELAYS ---
        const dacOffset = getDeviceAudioPipelineOffset(deviceInfo.current.os, deviceInfo.current.browser);
        
        // Calculate true mathematical expected position of the video frame
        const expectedVideoTime = payload.startVideoTime + ((networkTime - payload.startNetworkTime) / 1000) - dacOffset;
        const localTime = handlers.current.getCurrentTime();
        
        const drift = expectedVideoTime - localTime;
        const absDrift = Math.abs(drift);
        setLastSyncDelta(Math.round(absDrift * 1000));

        // --- NETWORK JITTER TOLERANCE ---
        // If network jitter is 40ms, tolerance must expand to 40ms to prevent endless seeking.
        // Minimum tolerance is 0.010s (10ms) for Psytrance/Rhythm zero-echo sync.
        const currentJitterSecs = (networkJitter / 1000) || 0;
        const dynamicTolerance = Math.max(0.010, Math.min(0.080, currentJitterSecs * 1.2)); 

        logEvent('SYNC_EVAL', { localTime, expectedVideoTime, drift, absDrift, penalty: currentPenaltyRef.current, tolerance: dynamicTolerance });

        // 🚀 SCENARIO 1: INSTANT RESUME (PRE-EMPTIVE STRIKE)
        if (justResumed && absDrift > dynamicTolerance) {
             const targetTime = expectedVideoTime + currentPenaltyRef.current;
             executeHardSeek(targetTime, `Instant Resume. Penalty: ${currentPenaltyRef.current.toFixed(3)}s`);
             return; 
        }

        // 🎯 SCENARIO 2: OUT OF TOLERANCE
        if (absDrift > dynamicTolerance) { 
          consecutiveMissesRef.current += 1;

          if (consecutiveMissesRef.current >= 2) {
              if (drift > 0) {
                 // 🔴 BEHIND: Apply PID Error Correction
                 const dt = (Date.now() - lastSeekTimeRef.current) / 1000;
                 if (dt > 0 && dt < 15) {
                     const correction = hardwarePidRef.current.calculate(absDrift, dt);
                     currentPenaltyRef.current += correction;
                 }
                 const targetTime = expectedVideoTime + currentPenaltyRef.current;
                 lastSeekTimeRef.current = Date.now();
                 executeHardSeek(targetTime, `Behind by ${absDrift.toFixed(3)}s. PID Penalty: ${currentPenaltyRef.current.toFixed(3)}s`);
              } else {
                 // 🟢 AHEAD: The Catchup Dilemma
                 if (Date.now() - lastSeekTimeRef.current < 5000) {
                     currentPenaltyRef.current -= (absDrift * 0.4); // Reduce penalty smoothly
                     currentPenaltyRef.current = Math.max(0.100, currentPenaltyRef.current);
                 }
                 lastSeekTimeRef.current = 0; 
    
                 // TIER 1: Micro-Lead (< 50ms) -> Use Iframe Playback Rate Manipulation (Soft Glide)
                 if (absDrift <= 0.050) {
                     executeSoftGlide(absDrift);
                 } 
                 // TIER 2: Macro-Lead (> 50ms) -> Micro-Pause Execution
                 else {
                     const pauseTimeMs = Math.round(absDrift * 1000) - 5; // Deduct 5ms for execution time
                     if (pauseTimeMs >= 10) {
                         logEvent('MICRO_PAUSE', { reason: `Ahead by ${absDrift.toFixed(3)}s`, pauseTimeMs });
                         if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
                         handlers.current.pause();
                         ignoreSyncUntilRef.current = Date.now() + pauseTimeMs + 400; 
                         catchupTimeoutRef.current = setTimeout(() => {
                            handlers.current.play();
                            catchupTimeoutRef.current = null;
                         }, pauseTimeMs);
                     }
                 }
              }
          }
          newStatus = 'syncing';
        } else {
          // 🏆 0ms ZERO-ECHO SYNC MAINTAINED
          consecutiveMissesRef.current = 0;
          hardwarePidRef.current.reset(); // Clear integral windup
          
          if (Date.now() > softGlideUntilRef.current) {
              handlers.current.setPlaybackRate(1); // Ensure rate is normal
          }
        }

        // Failsafe physical check
        if (handlers.current.getPlayerState() !== 1 && newStatus !== 'syncing' && !catchupTimeoutRef.current) {
          handlers.current.play();
        }

      } else {
        // ⏸️ SCENARIO 3: HOST IS PAUSED
        if (catchupTimeoutRef.current) { clearTimeout(catchupTimeoutRef.current); catchupTimeoutRef.current = null; }
        if (handlers.current.getPlayerState() === 1) handlers.current.pause();
        
        const localTime = handlers.current.getCurrentTime();
        if (Math.abs(localTime - payload.startVideoTime) > 0.010) {
          handlers.current.seekTo(payload.startVideoTime); 
        }
        setLastSyncDelta(0);
      }

      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;
    });

    // --- SECONDARY EVENT HANDLERS ---
    channel.on('broadcast', { event: 'sync_req' }, () => {
      if (!isHost) return;
      channel.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => { if (!isHost && payload) handlers.current.onQueueUpdate?.(payload as QueueState); });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: any }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlers.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        // Penalty persists to next song! Do not reset currentPenaltyRef.
        executeHardSeek(0, 'New Video Pipeline Reset');
        setSyncStatus('syncing');
      }
    });

    // --- CONNECTION SUBSCRIPTION ---
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, lastSyncDelta: 0 });
        if (!isHost) {
          // Burst 15 rapid pings to immediately calculate NTP offsets on load
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 15) channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
             else { clearInterval(interval); channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); }
          }, 150);
        }
      }
    });

    channelRef.current = channel;
    return () => { if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current); channel.unsubscribe(); };
  }, [roomId, userId, isHost, logEvent, executeHardSeek, executeSoftGlide]);


  // ============================================================================
  // HOST BROADCAST POLLER (Hyper-responsive 100ms cycle)
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    
    const interval = setInterval(() => {
      const currentTime = handlers.current.getCurrentTime();
      const playerState = handlers.current.getPlayerState();
      const networkTime = Date.now() + clockOffsetRef.current;
      const isPlaying = playerState === 1;

      let stateChanged = false;

      if (isPlaying) {
        const expectedTime = playbackEpochRef.current.startVideoTime + ((networkTime - playbackEpochRef.current.startNetworkTime) / 1000);
        // Strict 150ms drift detection for Host scrubbing
        if (!playbackEpochRef.current.isPlaying || Math.abs(expectedTime - currentTime) > 0.150) {
           epochSequenceCounterRef.current += 1;
           playbackEpochRef.current = { isPlaying: true, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, hostUpdateId: epochSequenceCounterRef.current, stateSequence: 1 };
           stateChanged = true;
        }
      } else {
         if (playbackEpochRef.current.isPlaying || Math.abs(playbackEpochRef.current.startVideoTime - currentTime) > 0.150) {
           epochSequenceCounterRef.current += 1;
           playbackEpochRef.current = { isPlaying: false, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, hostUpdateId: epochSequenceCounterRef.current, stateSequence: 0 };
           stateChanged = true;
         }
      }

      const now = Date.now();
      // Instantly transmit physical changes, otherwise transmit a keep-alive heartbeat every 2000ms
      if (stateChanged || now - lastBroadcastTimeRef.current > 2000) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
        lastBroadcastTimeRef.current = now;
        if (stateChanged) logEvent('HOST_STATE_UPDATE', playbackEpochRef.current);
      }
    }, 100); // 100ms cycle makes the Host buttons feel instantaneous globally
    return () => clearInterval(interval);
  }, [isHost, logEvent]);


  // ============================================================================
  // EXPOSED CONTROLS
  // ============================================================================
  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    epochSequenceCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: true, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochSequenceCounterRef.current, stateSequence: 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    epochSequenceCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: false, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochSequenceCounterRef.current, stateSequence: 0 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    const isCurrentlyPlaying = handlers.current.getPlayerState() === 1;
    epochSequenceCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: isCurrentlyPlaying, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: 0, videoId, hostUpdateId: epochSequenceCounterRef.current, stateSequence: isCurrentlyPlaying ? 1 : 0 };
    channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } });
  }, []);

  const forceResync = useCallback(() => { 
    if (!isHost || !channelRef.current) return;
    epochSequenceCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochSequenceCounterRef.current, stateSequence: 3 };
    channelRef.current.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate, forceResync, manualResync, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId,
  };
};
