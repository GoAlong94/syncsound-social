import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

export const ENGINE_VERSION = "v7.1-Absolute-Precision";

// ============================================================================
// PART 1: ENTERPRISE CONTROL THEORY & SIGNAL PROCESSING
// ============================================================================

/**
 * 1D Kalman Filter for Network RTT
 * Isolates true latency from 4G/5G cellular network spikes.
 */
class KalmanFilter {
  private r: number; 
  private q: number; 
  private p: number; 
  private x: number; 
  private k: number;

  constructor(measurementNoise = 10, processNoise = 0.1, initialError = 1, initialEstimate = 0) {
    this.r = measurementNoise; 
    this.q = processNoise; 
    this.p = initialError; 
    this.x = initialEstimate; 
    this.k = 0;
  }

  filter(measurement: number, dynamicQ: number = this.q): number {
    // Initialization step
    if (this.x === 0) { 
        this.x = measurement; 
        return measurement; 
    }
    
    // Prediction Update
    this.p = this.p + dynamicQ; 
    
    // Measurement Update (Kalman Gain)
    this.k = this.p / (this.p + this.r); 
    this.x = this.x + this.k * (measurement - this.x); 
    this.p = (1 - this.k) * this.p; 
    
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
  private readonly alpha = 0.15; 

  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    
    if (this.history.length > 30) {
        this.history.shift();
    }
  }

  getMetrics(): { offset: number, jitter: number, rtt: number } {
    if (this.history.length === 0) {
        return { offset: 0, jitter: 0, rtt: 0 };
    }
    
    if (this.history.length < 5) {
       const latest = this.history[this.history.length - 1];
       return { offset: latest.offset, jitter: 50, rtt: latest.rtt };
    }

    // Interquartile Range: Isolate the fastest, most direct packets
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const bestPackets = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.5));

    let sumOffset = 0;
    let sumRtt = 0;
    
    bestPackets.forEach(sample => { 
        sumOffset += sample.offset; 
        sumRtt += sample.rtt; 
    });
    
    const avgOffset = sumOffset / bestPackets.length;
    const avgRtt = sumRtt / bestPackets.length;

    // Calculate Network Variance (Jitter)
    const variance = bestPackets.reduce((acc, val) => acc + Math.pow(val.rtt - avgRtt, 2), 0) / bestPackets.length;
    
    // Apply Exponential Moving Average (EMA)
    if (this.emaOffset === null) {
        this.emaOffset = avgOffset;
    } else {
        this.emaOffset = (this.alpha * avgOffset) + ((1 - this.alpha) * this.emaOffset);
    }

    return { 
        offset: this.emaOffset, 
        jitter: Math.sqrt(variance), 
        rtt: avgRtt 
    };
  }
}

/**
 * Proportional-Integral-Derivative (PID) Controller
 * Learns the exact microsecond delay of an individual device's audio hardware.
 */
class PIDController {
  private kp: number; 
  private ki: number; 
  private kd: number;
  private integral: number = 0; 
  private prevError: number = 0;
  private minOut: number; 
  private maxOut: number;
  private derivative: number = 0;

  constructor(kp: number, ki: number, kd: number, minOut: number, maxOut: number) {
    this.kp = kp; 
    this.ki = ki; 
    this.kd = kd; 
    this.minOut = minOut; 
    this.maxOut = maxOut;
  }

  calculate(error: number, dt: number, isAggressive: boolean = false): number {
    if (dt <= 0) {
        return 0;
    }
    
    // Dampened Aggressive Gear (0.15) to prevent Ringing
    const activeKi = isAggressive ? 0.15 : this.ki;
    
    const p = this.kp * error;
    this.integral += error * dt;
    
    // Anti-Windup Protocol
    if (this.integral * activeKi > this.maxOut) {
        this.integral = this.maxOut / activeKi;
    } else if (this.integral * activeKi < this.minOut) {
        this.integral = this.minOut / activeKi;
    }

    // Low-Pass Filter on Derivative
    const rawD = (error - this.prevError) / dt;
    this.derivative = (0.7 * rawD) + (0.3 * this.derivative); 
    const d = this.kd * this.derivative;
    this.prevError = error;

    return Math.max(this.minOut, Math.min(this.maxOut, p + (activeKi * this.integral) + d));
  }
  
  reset() { 
      this.integral = 0; 
      this.prevError = 0; 
      this.derivative = 0; 
  }
}

// ============================================================================
// PART 2: DEVICE HEURISTICS & TYPES
// ============================================================================

const getAudioHardwareOffset = (os: string, browser: string): number => {
  // Deep Hardware Check: iPads disguise themselves as MacBooks on modern iOS.
  // We check for touch points to strip the disguise and apply true iOS latency.
  const isIPad = navigator.maxTouchPoints > 1 && navigator.userAgent.includes("Mac");
  
  if (os === 'iOS' || isIPad) return 0.055; 
  if (os === 'macOS' && browser.includes('Safari')) return 0.020;
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035; 
  if (os === 'Android') return 0.090; 
  if (os === 'Windows') return 0.045; 
  return 0.040; 
};

interface UseSyncEngineProps {
  roomId: string; 
  isHost: boolean; 
  userId: string;
  getCurrentTime: () => number; 
  seekTo: (time: number) => void;
  setPlaybackRate: (rate: number) => void; 
  play: () => void; 
  pause: () => void;
  getPlayerState: () => number;
  onVideoChange?: (videoId: string, title: string, thumbnail: string) => void;
  onQueueUpdate?: (queue: QueueState) => void;
}

interface EpochState {
  isPlaying: boolean; 
  startNetworkTime: number; 
  startVideoTime: number;
  videoId: string | null; 
  updateId: number; 
}

// ============================================================================
// PART 3: THE DECOUPLED SYNC ENGINE
// ============================================================================

export const useSyncEngine = ({
  roomId, 
  isHost, 
  userId, 
  getCurrentTime, 
  seekTo, 
  setPlaybackRate, 
  play, 
  pause, 
  getPlayerState, 
  onVideoChange, 
  onQueueUpdate,
}: UseSyncEngineProps) => {

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  
  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);
  const lastSyncDeltaRef = useRef<number>(0); 
  
  // React-safe refs for closures
  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { 
      handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; 
  });
  
  const deviceInfo = useRef(getDeviceInfo());
  const wakeLockRef = useRef<any>(null);

  // Decoupled Network Refs (NEVER put in a dependency array)
  const ntpAnalyzer = useRef(new NTPAnalyzer());
  const kalmanRtt = useRef(new KalmanFilter(15, 0.5, 1, 0));
  const clockOffsetRef = useRef<number>(0); 
  const networkJitterRef = useRef<number>(0);
  const currentVideoIdRef = useRef<string | null>(null);
  
  // The Atomic Source of Truth
  const epochRef = useRef<EpochState>({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, updateId: 0 });

  // AI & State Trackers
  const isColdStartRef = useRef<boolean>(true);
  const playheadStartTimeRef = useRef<number>(0); 
  
  const warmPenaltyPID = useRef(new PIDController(0.6, 0.05, 0.1, -0.200, 1.000)); 
  const currentWarmPenalty = useRef<number>(deviceInfo.current.os === 'iOS' || getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser) === 0.055 ? 0.350 : 0.150);
  
  // Execution Locks
  const ignoreSyncUntil = useRef<number>(0);
  const softGlideUntil = useRef<number>(0);
  const postBufferGracePeriodUntil = useRef<number>(0); 
  const lastSeekTime = useRef<number>(0);
  const lastHostBroadcastTime = useRef<number>(0);
  const consecutiveMisses = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const catchupTimeout = useRef<NodeJS.Timeout | null>(null);

  // V4 Network Survival State
  const pingCountRef = useRef<number>(0);
  const isNtpFrozenRef = useRef<boolean>(false);
  const cachedVideoIdRef = useRef<string | null>(null);

  // Hardware Timer Refs
  const requestRef = useRef<number>();
  const lastEvalTime = useRef<number>(0);

  // Massive Array Limit (15,000) for continuous data
  const syncLogs = useRef<any[]>([]);
  const collectedLogsRef = useRef<Record<string, any[]>>({});

  const logEvent = useCallback((e: string, data: any = {}) => {
    const currentState = handlers.current.getPlayerState();
    
    syncLogs.current.push({ 
      t: new Date().toISOString(), 
      r: isHost ? 'HOST' : 'JOINER', 
      e, 
      ctx: { 
          state: currentState, 
          locTime: handlers.current.getCurrentTime(), 
          jitter: networkJitterRef.current 
      }, 
      ...data 
    });
    
    if (syncLogs.current.length > 15000) {
        syncLogs.current.shift();
    }
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    if (isHost && channelRef.current) {
      collectedLogsRef.current = { [`HOST_${deviceInfo.current.os}_${userId.slice(0,5)}`]: syncLogs.current };
      logEvent('BROADCAST_LOG_REQUEST', {});
      channelRef.current.send({ type: 'broadcast', event: 'request_logs', payload: {} });
      
      // Wait 3.5s for the massive 15k arrays to upload
      setTimeout(() => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectedLogsRef.current, null, 2));
        const a = document.createElement('a'); 
        a.href = dataStr; 
        a.download = `sync_v7.1_SESSION_${Date.now()}.json`;
        document.body.appendChild(a); 
        a.click(); 
        a.remove();
      }, 3500);
    }
  }, [isHost, userId, logEvent]);

  // THE DEATH RATTLE: Upload logs if user violently kills the app
  useEffect(() => {
    const handleUnload = () => {
      if (!isHost && channelRef.current) {
         logEvent('DEATH_RATTLE_UNLOAD');
         channelRef.current.send({ 
             type: 'broadcast', 
             event: 'submit_logs', 
             payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } 
         });
      }
    };
    
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    
    return () => {
       window.removeEventListener('beforeunload', handleUnload);
       window.removeEventListener('pagehide', handleUnload);
    };
  }, [isHost, userId, logEvent]);

  // ============================================================================
  // SYSTEM & BACKGROUND MANAGEMENT
  // ============================================================================
  useEffect(() => {
    const acquireWakeLock = async () => { 
        if ('wakeLock' in navigator && !wakeLockRef.current) { 
            try { 
                wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); 
            } catch (e) {} 
        } 
    };
    
    acquireWakeLock();
    
    const handleVis = () => { 
        if (document.visibilityState === 'visible') { 
            acquireWakeLock(); 
            if (!isHost) { 
                logEvent('APP_FOREGROUNDED', {}); 
                ignoreSyncUntil.current = 0; 
                channelRef.current?.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); 
            } 
        } 
    };
    
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [isHost, logEvent, userId]);

  // ============================================================================
  // MEDIA MANIPULATORS
  // ============================================================================
  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs = 2500) => {
    logEvent('HARD_SEEK', { target: time, reason });
    
    if (catchupTimeout.current) { 
        clearTimeout(catchupTimeout.current); 
        catchupTimeout.current = null; 
    }
    
    handlers.current.seekTo(time);
    
    if (epochRef.current.isPlaying) {
        handlers.current.play(); 
    } else {
        handlers.current.pause();
    }
    
    ignoreSyncUntil.current = Date.now() + lockoutMs; 
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number) => {
      const rate = 0.90;
      const virtualLossPerSec = 1.0 - rate; 
      const holdTimeMs = Math.min((driftSeconds / virtualLossPerSec) * 1000, 1500); 
      
      logEvent('SOFT_GLIDE', { driftSeconds, holdTimeMs, rate });
      handlers.current.setPlaybackRate(rate);
      
      softGlideUntil.current = Date.now() + holdTimeMs;
      ignoreSyncUntil.current = Date.now() + holdTimeMs + 200; 
      
      setTimeout(() => { 
          handlers.current.setPlaybackRate(1.0); 
      }, holdTimeMs);
  }, [logEvent]);

  const requestSync = useCallback(() => { 
      if (!channelRef.current || isHost) return; 
      channelRef.current.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); 
  }, [isHost, userId]);
  
  const measureLatency = useCallback(() => { 
      if (!channelRef.current) return; 
      channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } }); 
  }, [userId]);

  // ============================================================================
  // LAYER 1: SUPABASE WEBRTC NETWORK DEMUXER
  // ============================================================================
  useEffect(() => {
    logEvent('INIT_NTP_BUS', { roomId, version: ENGINE_VERSION });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } }});

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setConnectedDevices(Object.values(state).flat().map((p: any) => ({
        id: p.id, 
        isHost: p.isHost, 
        joinedAt: p.joinedAt, 
        ping: p.ping, 
        os: p.os || '?', 
        browser: p.browser || '?', 
        syncStatus: p.syncStatus || 'unsynced', 
        latency: p.latency || 0, 
        jitter: p.jitter || 0, 
        cachedVideoId: p.cachedVideoId
      })));
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => { 
        if (isHost && payload.sId !== userId) {
            channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } }); 
        }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId && !isNtpFrozenRef.current) {
        pingCountRef.current += 1;
        
        // Fast-Convergence Kalman Noise
        const dynamicQ = pingCountRef.current < 15 ? 0.5 : 0.01;
        const rtt = kalmanRtt.current.filter(Date.now() - payload.t, dynamicQ); 
        
        // ABSOLUTE TRUTH: Exact (rtt / 2) symmetrical split. No hallucinatory biases.
        const offset = payload.ht - payload.t - (rtt / 2);
        
        ntpAnalyzer.current.addSample(rtt, offset);
        const metrics = ntpAnalyzer.current.getMetrics();
        
        clockOffsetRef.current = metrics.offset; 
        networkJitterRef.current = metrics.jitter;
        
        setLatency(Math.round(metrics.rtt)); 
        setNetworkJitter(Math.round(metrics.jitter));

        if (pingCountRef.current > 45) {
            isNtpFrozenRef.current = true;
            logEvent('NTP_FROZEN_LOCKED', { finalOffset: metrics.offset, finalJitter: metrics.jitter });
        }
        
        if (Math.random() < 0.15) { 
            channel.track({ 
                id: userId, 
                isHost, 
                joinedAt: Date.now(), 
                os: deviceInfo.current.os, 
                syncStatus: 'synced', 
                latency: Math.round(metrics.rtt), 
                jitter: Math.round(metrics.jitter), 
                cachedVideoId: cachedVideoIdRef.current 
            }); 
        }
      }
    });

    channel.on('broadcast', { event: 'request_logs' }, () => { 
        if (isHost) return; 
        logEvent('UPLOADING_LOGS_MANUAL'); 
        channel.send({ type: 'broadcast', event: 'submit_logs', payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } }); 
    });
    
    channel.on('broadcast', { event: 'submit_logs' }, ({ payload }) => { 
        if (!isHost) return; 
        collectedLogsRef.current[`JOINER_${payload.os}_${payload.uId.slice(0,5)}`] = payload.logs; 
    });

    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;
      if (payload.updateId < epochRef.current.updateId) return; 
      
      const wasPlaying = epochRef.current.isPlaying;
      epochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        currentVideoIdRef.current = payload.videoId; 
        isColdStartRef.current = true; 
        handlers.current.onVideoChange?.(payload.videoId, "", ""); 
        executeHardSeek(0, 'Video Changed', 2500); 
        return;
      }

      if (payload.isPlaying && !wasPlaying) {
         if (Date.now() < ignoreSyncUntil.current) return;
         
         const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
         const expectedTime = payload.startVideoTime + ((Date.now() + clockOffsetRef.current - payload.startNetworkTime) / 1000) - dacOffset;
         
         playheadStartTimeRef.current = Date.now(); 
         
         if (isColdStartRef.current) {
             const coldPenalty = deviceInfo.current.os === 'iOS' ? 1.800 : 1.200;
             executeHardSeek(expectedTime + coldPenalty, `Cold Start Resume: +${coldPenalty}s`, 3500);
             isColdStartRef.current = false; 
         } else { 
             executeHardSeek(expectedTime + currentWarmPenalty.current, `Warm Resume: +${currentWarmPenalty.current.toFixed(3)}s`); 
         }
      }
      
      if (!payload.isPlaying) {
         if (catchupTimeout.current) { 
             clearTimeout(catchupTimeout.current); 
             catchupTimeout.current = null; 
         }
         
         handlers.current.pause();
         
         if (Math.abs(handlers.current.getCurrentTime() - payload.startVideoTime) > 0.05) {
             handlers.current.seekTo(payload.startVideoTime);
         }
      }
    });

    channel.on('broadcast', { event: 'sync_req' }, () => { 
        if (isHost) {
            channel.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
        }
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ 
            id: userId, 
            isHost, 
            joinedAt: Date.now(), 
            os: deviceInfo.current.os, 
            browser: deviceInfo.current.browser,
            syncStatus: isHost ? 'synced' : 'unsynced', 
            latency: 0, 
            jitter: 0, 
            cachedVideoId: cachedVideoIdRef.current 
        });

        if (!isHost) {
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 45) {
                 channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
             } else { 
                 clearInterval(interval); 
                 channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); 
             }
          }, 150);
        }
      }
    });

    channelRef.current = channel;
    
    return () => { 
        if (catchupTimeout.current) {
            clearTimeout(catchupTimeout.current); 
        }
        channel.unsubscribe(); 
    };
  }, [roomId, userId, isHost, logEvent, executeHardSeek]);

  // ============================================================================
  // LAYER 2: AUTONOMOUS HARDWARE-BOUND LOOP (requestAnimationFrame)
  // ============================================================================
  const runHardwareEvaluationLoop = useCallback((timestamp: number) => {
      // Throttle evaluations to roughly ~200ms, but synchronized with hardware paints
      if (timestamp - lastEvalTime.current >= 200) {
          lastEvalTime.current = timestamp;

          if (isHost) return;

          const epoch = epochRef.current;
          if (!epoch.videoId) return;

          const playerState = handlers.current.getPlayerState();
          
          // State 3 Recovery Smoothing: 500ms blackout post-buffering to avoid YouTube API garbage frames
          if (playerState === 3 || playerState === -1) {
              postBufferGracePeriodUntil.current = Date.now() + 500;
              return;
          }

          if (!epoch.isPlaying) {
              wasPlayingRef.current = false;
              
              if (catchupTimeout.current) { 
                  clearTimeout(catchupTimeout.current); 
                  catchupTimeout.current = null; 
              }
              
              if (playerState === 1) { 
                  handlers.current.pause(); 
              }
              
              const localTime = handlers.current.getCurrentTime();
              const drift = Math.abs(localTime - epoch.startVideoTime);
              
              setLastSyncDelta(Math.round(drift * 1000)); 
              lastSyncDeltaRef.current = Math.round(drift * 1000);
              
              if (drift > 0.020) { 
                  handlers.current.seekTo(epoch.startVideoTime); 
              }
              
              setSyncStatus('synced'); 
              return;
          }

          if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current || Date.now() < postBufferGracePeriodUntil.current) {
              return;
          }

          const networkTime = Date.now() + clockOffsetRef.current;
          const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
          const expectedTime = epoch.startVideoTime + ((networkTime - epoch.startNetworkTime) / 1000) - dacOffset;
          const localTime = handlers.current.getCurrentTime();
          
          const drift = expectedTime - localTime;
          const absDrift = Math.abs(drift);
          
          setLastSyncDelta(Math.round(absDrift * 1000));
          lastSyncDeltaRef.current = Math.round(absDrift * 1000);
          
          // STRICT 10ms LAW: Absolute perfection standard. No dynamic compromises.
          const tolerance = 0.010;

          const justResumed = !wasPlayingRef.current;
          wasPlayingRef.current = true;

          if (justResumed && absDrift > tolerance) {
              const penalty = isColdStartRef.current ? (deviceInfo.current.os === 'iOS' ? 1.8 : 1.2) : currentWarmPenalty.current;
              executeHardSeek(expectedTime + penalty, `Resume Strike. Pen: ${penalty.toFixed(3)}s`, 3500);
              if (isColdStartRef.current) isColdStartRef.current = false;
              return;
          }

          if (absDrift > tolerance) {
              consecutiveMisses.current += 1;
              
              if (consecutiveMisses.current >= 2) {
                  setSyncStatus('syncing');
                  
                  if (drift > 0) {
                      // 🔴 BEHIND
                      const dt = (Date.now() - lastSeekTime.current) / 1000;
                      
                      if (dt > 0 && dt < 15 && !isColdStartRef.current) {
                          const timeSincePlay = Date.now() - playheadStartTimeRef.current;
                          // Engage Aggressive Gear (Ki=0.15) during first 10 seconds to rapidly consume drift
                          const isAggressive = (timeSincePlay < 10000) && (absDrift > 0.020);
                          
                          currentWarmPenalty.current += warmPenaltyPID.current.calculate(absDrift, dt, isAggressive);
                          currentWarmPenalty.current = Math.min(1.2, currentWarmPenalty.current);
                      }
                      
                      const penalty = isColdStartRef.current ? 1.5 : currentWarmPenalty.current;
                      executeHardSeek(expectedTime + penalty, `Macro-Behind: ${absDrift.toFixed(3)}s`, 2500);
                      
                      lastSeekTime.current = Date.now();
                      isColdStartRef.current = false;
                  } else {
                      // 🟢 AHEAD
                      if (Date.now() - lastSeekTime.current < 5000 && !isColdStartRef.current) {
                          currentWarmPenalty.current -= (absDrift * 0.4);
                          currentWarmPenalty.current = Math.max(0.100, currentWarmPenalty.current);
                      }
                      
                      lastSeekTime.current = 0;

                      // Use Micro-pause for anything under 60ms to prevent glide warping
                      if (absDrift > 0.010 && absDrift <= 0.060) {
                          executeSoftGlide(absDrift);
                      } else {
                          const rawPauseMs = Math.round(absDrift * 1000) - 5;
                          // 150ms Shock Absorber to prevent violent ringing
                          const cappedPauseMs = Math.min(rawPauseMs, 150); 
                          
                          if (cappedPauseMs > 10) {
                              logEvent('MICRO_PAUSE_CAPPED', { rawPauseMs, cappedPauseMs });
                              
                              if (catchupTimeout.current) { 
                                  clearTimeout(catchupTimeout.current); 
                              }
                              
                              handlers.current.pause();
                              ignoreSyncUntil.current = Date.now() + cappedPauseMs + 400;
                              
                              catchupTimeout.current = setTimeout(() => { 
                                  handlers.current.play(); 
                                  catchupTimeout.current = null; 
                              }, cappedPauseMs);
                          }
                      }
                  }
              }
          } else {
              consecutiveMisses.current = 0;
              warmPenaltyPID.current.reset();
              setSyncStatus('synced');
              if (handlers.current.getPlayerState() !== 1) handlers.current.play();
          }
      }
      
      requestRef.current = requestAnimationFrame(runHardwareEvaluationLoop);
  }, [isHost, executeHardSeek, executeSoftGlide, logEvent]);

  // Mount the Hardware Loop
  useEffect(() => {
      requestRef.current = requestAnimationFrame(runHardwareEvaluationLoop);
      return () => {
          if (requestRef.current) {
              cancelAnimationFrame(requestRef.current);
          }
      };
  }, [runHardwareEvaluationLoop]);


  // ============================================================================
  // LAYER 3: HOST BROADCAST POLLER 
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    
    const interval = setInterval(() => {
      const currentTime = handlers.current.getCurrentTime();
      const isPlaying = handlers.current.getPlayerState() === 1;
      const networkTime = Date.now();

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
      
      if (stateChanged || now - lastHostBroadcastTime.current > 2500) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
        lastHostBroadcastTime.current = now;
        
        if (stateChanged) { 
            logEvent('HOST_EPOCH_UPDATE', epochRef.current); 
        }
      }
    }, 100); 
    
    return () => clearInterval(interval);
  }, [isHost, logEvent]);

  // ============================================================================
  // EXPOSED CONTROLS
  // ============================================================================
  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: true, startNetworkTime: Date.now(), startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: false, startNetworkTime: Date.now(), startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now(), startVideoTime: 0, videoId, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } });
  }, []);

  const forceResync = useCallback(() => { 
    if (!isHost) return;
    epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now(), startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); 
  }, [isHost]);

  const manualResyncFunc = useCallback(() => {
    if (isHost) return;
    
    setSyncStatus('syncing');
    ntpAnalyzer.current = new NTPAnalyzer();
    kalmanRtt.current = new KalmanFilter(15, 0.5, 1, 0);
    isNtpFrozenRef.current = false;
    pingCountRef.current = 0;
    
    requestSync();
    
    for(let i=0; i<5; i++) { 
        setTimeout(measureLatency, i*100); 
    }
  }, [isHost, requestSync, measureLatency]);

  return {
    connectedDevices, 
    latency, 
    syncStatus, 
    lastSyncDelta, 
    networkJitter, 
    broadcastPlay, 
    broadcastPause, 
    broadcastVideoChange, 
    broadcastQueueUpdate: () => {}, 
    forceResync, 
    manualResync: manualResyncFunc, 
    measureLatency, 
    downloadLogs, 
    engineVersion: ENGINE_VERSION,
    deviceInfo: deviceInfo.current, 
    setCurrentVideoId: (id: string) => { currentVideoIdRef.current = id; },
    reportPreloadReady: (vid: string) => { 
        cachedVideoIdRef.current = vid; 
        if (!isHost) channelRef.current?.track({ id: userId, isHost: false, cachedVideoId: vid }); 
    }
  };
};
