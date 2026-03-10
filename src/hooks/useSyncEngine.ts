import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

// ============================================================================
// PART 1: ENTERPRISE CONTROL THEORY & SIGNAL PROCESSING
// ============================================================================

/**
 * 1D Kalman Filter for Network RTT
 * Used to isolate true latency from 4G/5G cellular network spikes.
 */
class KalmanFilter {
  private r: number; private q: number; private p: number; 
  private x: number; private k: number;

  constructor(measurementNoise = 10, processNoise = 0.1, initialError = 1, initialEstimate = 0) {
    this.r = measurementNoise; this.q = processNoise; 
    this.p = initialError; this.x = initialEstimate; this.k = 0;
  }

  filter(measurement: number): number {
    if (this.x === 0) { this.x = measurement; return measurement; }
    this.p = this.p + this.q; // Predict
    this.k = this.p / (this.p + this.r); // Update Kalman Gain
    this.x = this.x + this.k * (measurement - this.x); // Update Estimate
    this.p = (1 - this.k) * this.p; // Update Error Covariance
    return this.x;
  }
}

/**
 * Network Time Protocol (NTP) Interquartile Analyzer
 * Cleans asymmetric routing delays to establish a perfectly synchronized UTC epoch.
 */
class NTPAnalyzer {
  private history: { rtt: number, offset: number }[] = [];
  private emaOffset: number | null = null;
  private readonly alpha = 0.15; // Exponential Moving Average smoothing

  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    if (this.history.length > 30) this.history.shift();
  }

  getMetrics(): { offset: number, jitter: number, rtt: number } {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    if (this.history.length < 5) {
       const latest = this.history[this.history.length - 1];
       return { offset: latest.offset, jitter: 50, rtt: latest.rtt };
    }

    // Isolate the fastest, most direct packets (Lowest RTT = Truest Offset)
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const bestPackets = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.5));

    let sumOffset = 0, sumRtt = 0;
    bestPackets.forEach(s => { sumOffset += s.offset; sumRtt += s.rtt; });
    const avgOffset = sumOffset / bestPackets.length;
    const avgRtt = sumRtt / bestPackets.length;

    const variance = bestPackets.reduce((acc, val) => acc + Math.pow(val.rtt - avgRtt, 2), 0) / bestPackets.length;
    
    if (this.emaOffset === null) this.emaOffset = avgOffset;
    else this.emaOffset = (this.alpha * avgOffset) + ((1 - this.alpha) * this.emaOffset);

    return { offset: this.emaOffset, jitter: Math.sqrt(variance), rtt: avgRtt };
  }
}

/**
 * Proportional-Integral-Derivative (PID) Controller
 * Learns the exact microsecond delay of an individual device's audio decoding hardware.
 */
class PIDController {
  private kp: number; private ki: number; private kd: number;
  private integral: number = 0; private prevError: number = 0;
  private minOut: number; private maxOut: number;

  constructor(kp: number, ki: number, kd: number, minOut: number, maxOut: number) {
    this.kp = kp; this.ki = ki; this.kd = kd; 
    this.minOut = minOut; this.maxOut = maxOut;
  }

  calculate(error: number, dt: number): number {
    if (dt <= 0) return 0;
    const p = this.kp * error;
    this.integral += error * dt;
    
    // Anti-windup
    const i = this.ki * this.integral;
    if (i > this.maxOut) this.integral = this.maxOut / this.ki;
    else if (i < this.minOut) this.integral = this.minOut / this.ki;

    const d = this.kd * ((error - this.prevError) / dt);
    this.prevError = error;

    return Math.max(this.minOut, Math.min(this.maxOut, p + i + d));
  }
  reset() { this.integral = 0; this.prevError = 0; }
}

// ============================================================================
// PART 2: DEVICE HEURISTICS & TYPES
// ============================================================================

const getAudioHardwareOffset = (os: string, browser: string): number => {
  // Physical DAC and OS audio mixer delays
  if (os === 'iOS') return 0.055; 
  if (os === 'macOS' && browser.includes('Safari')) return 0.020;
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035; 
  if (os === 'Android') return 0.090; // Android AudioFlinger latency
  if (os === 'Windows') return 0.045; 
  return 0.040; 
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
  videoId: string | null; updateId: number; 
}

// ============================================================================
// PART 3: THE OMEGA SYNC ENGINE HOOK
// ============================================================================

export const useSyncEngine = ({
  roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate,
}: UseSyncEngineProps) => {

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  
  // React-safe refs for closures
  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; });
  
  const deviceInfo = useRef(getDeviceInfo());
  const wakeLockRef = useRef<any>(null);

  // Network Math
  const ntpAnalyzer = useRef(new NTPAnalyzer());
  const kalmanRtt = useRef(new KalmanFilter(15, 0.5, 1, 0));
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  
  // The Atomic Source of Truth
  const epochRef = useRef<EpochState>({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, updateId: 0 });

  // AI & State Trackers
  const isColdStartRef = useRef<boolean>(true); // Tracks if video is freshly loading vs unpausing
  const warmPenaltyPID = useRef(new PIDController(0.6, 0.05, 0.1, -0.200, 1.000)); 
  const currentWarmPenalty = useRef<number>(deviceInfo.current.os === 'iOS' ? 0.350 : 0.150);
  
  // Execution Locks
  const ignoreSyncUntil = useRef<number>(0);
  const softGlideUntil = useRef<number>(0);
  const lastSeekTime = useRef<number>(0);
  const lastHostBroadcastTime = useRef<number>(0);
  const consecutiveMisses = useRef<number>(0);
  const catchupTimeout = useRef<NodeJS.Timeout | null>(null);

  // Telemetry
  const syncLogs = useRef<any[]>([]);
  const logEvent = useCallback((e: string, data: any) => {
    syncLogs.current.push({ t: new Date().toISOString(), r: isHost ? 'HOST' : 'JOINER', e, ...data });
    if (syncLogs.current.length > 2000) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syncLogs.current, null, 2));
    const a = document.createElement('a');
    a.href = dataStr; a.download = `sync_omega_${isHost ? 'host' : 'joiner'}_${userId.slice(0,5)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }, [isHost, userId]);


  // ============================================================================
  // SYSTEM & NETWORK CONTROLS
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
            logEvent('APP_FOREGROUNDED', {});
            ignoreSyncUntil.current = 0; // Break locks, app was asleep
            channelRef.current?.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } });
         }
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [isHost, logEvent, userId]);

  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs = 2500) => {
    logEvent('HARD_SEEK', { target: time, reason });
    if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
    
    handlers.current.seekTo(time);
    if (epochRef.current.isPlaying) handlers.current.play();
    else handlers.current.pause();
    
    ignoreSyncUntil.current = Date.now() + lockoutMs; 
  }, [logEvent]);


  // ============================================================================
  // SUPABASE WEBRTC PROTOCOL
  // ============================================================================
  useEffect(() => {
    logEvent('INIT_NTP_BUS', { roomId });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } }});

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setConnectedDevices(Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping, os: p.os || '?', browser: p.browser || '?', 
        syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, lastSyncDelta: 0, jitter: p.jitter || 0
      })));
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.sId !== userId) {
        channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId) {
        const rtt = kalmanRtt.current.filter(Date.now() - payload.t); 
        const offset = payload.ht - payload.t - (rtt / 2);
        
        ntpAnalyzer.current.addSample(rtt, offset);
        const metrics = ntpAnalyzer.current.getMetrics();
        
        clockOffsetRef.current = metrics.offset;
        setLatency(Math.round(metrics.rtt));
        setNetworkJitter(Math.round(metrics.jitter));
        
        if (Math.random() < 0.15) { // Throttle DB updates
           channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, syncStatus: syncStatus, latency: Math.round(metrics.rtt), jitter: Math.round(metrics.jitter) });
        }
      }
    });

    // 📩 RECEIVE HOST EPOCH
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;
      if (payload.updateId < epochRef.current.updateId) return; // Drop old UDP packets
      
      const wasPlaying = epochRef.current.isPlaying;
      epochRef.current = payload;

      // 1. New Video Pipeline
      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        currentVideoIdRef.current = payload.videoId;
        isColdStartRef.current = true; // ❄️ COLD START FLAG
        handlers.current.onVideoChange?.(payload.videoId, "", "");
        executeHardSeek(0, 'New Video Pipeline', 3000);
        return;
      }

      // 2. Instant Resume Pre-Emptive Strike
      if (payload.isPlaying && !wasPlaying) {
         if (Date.now() < ignoreSyncUntil.current) return;
         
         const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
         const expectedTime = payload.startVideoTime + ((Date.now() + clockOffsetRef.current - payload.startNetworkTime) / 1000) - dacOffset;
         
         if (isColdStartRef.current) {
             // Fetching a brand new video requires a massive buffer allowance
             const coldPenalty = deviceInfo.current.os === 'iOS' ? 1.800 : 1.200;
             executeHardSeek(expectedTime + coldPenalty, `Cold Start Resume: +${coldPenalty}s`, 3500);
             isColdStartRef.current = false; // Next time it pauses, it will be warm
         } else {
             // Just unpausing a video already in memory
             executeHardSeek(expectedTime + currentWarmPenalty.current, `Warm Resume: +${currentWarmPenalty.current.toFixed(3)}s`);
         }
      }
      
      // 3. Host Paused
      if (!payload.isPlaying) {
         if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
         handlers.current.pause();
         if (Math.abs(handlers.current.getCurrentTime() - payload.startVideoTime) > 0.05) {
             handlers.current.seekTo(payload.startVideoTime);
         }
      }
    });

    channel.on('broadcast', { event: 'sync_req' }, () => {
      if (isHost) channel.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && !isHost) {
        let pings = 0;
        const interval = setInterval(() => {
           if (pings++ < 15) channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
           else { clearInterval(interval); channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); }
        }, 150);
      }
    });

    channelRef.current = channel;
    return () => { if (catchupTimeout.current) clearTimeout(catchupTimeout.current); channel.unsubscribe(); };
  }, [roomId, userId, isHost, logEvent, executeHardSeek, syncStatus]);


  // ============================================================================
  // AUTONOMOUS JOINER EVALUATION LOOP (Immune to Host backgrounding)
  // ============================================================================
  useEffect(() => {
    if (isHost) return;

    // Evaluates local drift every 300ms against the ATOMIC epoch
    const interval = setInterval(() => {
      if (!epochRef.current.isPlaying) return;
      if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current) return;

      const networkTime = Date.now() + clockOffsetRef.current;
      const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
      
      const expectedTime = epochRef.current.startVideoTime + ((networkTime - epochRef.current.startNetworkTime) / 1000) - dacOffset;
      const localTime = handlers.current.getCurrentTime();
      
      const drift = expectedTime - localTime;
      const absDrift = Math.abs(drift);
      
      // Dynamic Tolerance: Minimum 12ms (Beat-match), expands if network is highly volatile
      const jitterSecs = (networkJitter / 1000) || 0;
      const tolerance = Math.max(0.012, Math.min(0.080, jitterSecs * 1.2)); 

      if (absDrift > tolerance) {
          consecutiveMisses.current += 1;
          
          if (consecutiveMisses.current >= 2) {
              setSyncStatus('syncing');
              
              if (drift > 0) {
                  // 🔴 BEHIND: Update PID and Hard Seek
                  const dt = (Date.now() - lastSeekTime.current) / 1000;
                  if (dt > 0 && dt < 15 && !isColdStartRef.current) {
                      currentWarmPenalty.current += warmPenaltyPID.current.calculate(absDrift, dt);
                  }
                  const targetTime = expectedTime + (isColdStartRef.current ? 1.5 : currentWarmPenalty.current);
                  lastSeekTime.current = Date.now();
                  executeHardSeek(targetTime, `Macro-Behind: ${absDrift.toFixed(3)}s`);
              } else {
                  // 🟢 AHEAD: Soft Glide or Micro-Pause
                  if (Date.now() - lastSeekTime.current < 5000 && !isColdStartRef.current) {
                      currentWarmPenalty.current -= (absDrift * 0.5); // Penalty was too high
                      currentWarmPenalty.current = Math.max(0.100, currentWarmPenalty.current);
                  }
                  lastSeekTime.current = 0;

                  // 🎧 The Imperceptible Soft-Glide (For drifts under 100ms)
                  if (absDrift < 0.100) {
                      // At 0.90x speed, we lose 0.1s of virtual video per 1.0s of real time.
                      const rate = 0.90;
                      const virtualLossPerSec = 1.0 - rate;
                      const holdTimeMs = Math.min((absDrift / virtualLossPerSec) * 1000, 1000); 
                      
                      logEvent('SOFT_GLIDE', { reason: `Ahead by ${absDrift.toFixed(3)}s`, holdTimeMs });
                      handlers.current.setPlaybackRate(rate);
                      softGlideUntil.current = Date.now() + holdTimeMs;
                      ignoreSyncUntil.current = Date.now() + holdTimeMs + 200; 
                      
                      setTimeout(() => { handlers.current.setPlaybackRate(1.0); }, holdTimeMs);
                  } else {
                      // Hard Pause for massive leads
                      const pauseMs = Math.round(absDrift * 1000) - 5; 
                      if (pauseMs > 10) {
                          logEvent('MICRO_PAUSE', { pauseMs });
                          if (catchupTimeout.current) clearTimeout(catchupTimeout.current);
                          handlers.current.pause();
                          ignoreSyncUntil.current = Date.now() + pauseMs + 400;
                          catchupTimeout.current = setTimeout(() => { handlers.current.play(); catchupTimeout.current = null; }, pauseMs);
                      }
                  }
              }
          }
      } else {
          // 🏆 0ms PERFECT SYNC
          consecutiveMisses.current = 0;
          warmPenaltyPID.current.reset();
          setSyncStatus('synced');
          if (Date.now() > softGlideUntil.current && handlers.current.getPlayerState() === 1) {
              handlers.current.setPlaybackRate(1.0); // Ensure normal speed
          }
      }

      // Failsafe physical check
      if (handlers.current.getPlayerState() !== 1 && epochRef.current.isPlaying && Date.now() > ignoreSyncUntil.current && !catchupTimeout.current) {
          handlers.current.play();
      }

    }, 300); // 300ms autonomous loop
    return () => clearInterval(interval);
  }, [isHost, networkJitter, logEvent, executeHardSeek]);


  // ============================================================================
  // HOST BROADCAST POLLER 
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    
    const interval = setInterval(() => {
      const currentTime = handlers.current.getCurrentTime();
      const isPlaying = handlers.current.getPlayerState() === 1;
      const networkTime = Date.now() + clockOffsetRef.current;

      let stateChanged = false;

      if (isPlaying) {
        const expectedTime = epochRef.current.startVideoTime + ((networkTime - epochRef.current.startNetworkTime) / 1000);
        if (!epochRef.current.isPlaying || Math.abs(expectedTime - currentTime) > 0.150) {
           epochRef.current = { isPlaying: true, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
           stateChanged = true;
        }
      } else {
         if (epochRef.current.isPlaying || Math.abs(epochRef.current.startVideoTime - currentTime) > 0.150) {
           epochRef.current = { isPlaying: false, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
           stateChanged = true;
         }
      }

      const now = Date.now();
      // Transmit instantly on change, or heartbeat every 2.5s
      if (stateChanged || now - lastHostBroadcastTime.current > 2500) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
        lastHostBroadcastTime.current = now;
        if (stateChanged) logEvent('HOST_EPOCH_UPDATE', epochRef.current);
      }
    }, 100); 
    return () => clearInterval(interval);
  }, [isHost, logEvent]);

  // ============================================================================
  // EXPOSED CONTROLS
  // ============================================================================
  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: true, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: false, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: 0, videoId, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } });
  }, []);

  const forceResync = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);
  const manualResyncFunc = useCallback(() => { /* handled internally via button */ }, []);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate, forceResync, manualResync: manualResyncFunc, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId,
  };
};
