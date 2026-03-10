import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

// ============================================================================
// PART 1: ADVANCED MATH, AI, AND STATISTICAL UTILITIES
// ============================================================================

/**
 * Proportional-Integral-Derivative (PID) Controller
 * AI logic to dynamically calculate hardware buffer penalties.
 * Learns the exact microsecond delay of a specific phone over time.
 */
class PIDController {
  kp: number; // Proportional: Reacts to current error
  ki: number; // Integral: Reacts to accumulated past errors
  kd: number; // Derivative: Reacts to rate of change
  integral: number = 0;
  prevError: number = 0;
  minOutput: number;
  maxOutput: number;

  constructor(kp: number, ki: number, kd: number, minOutput: number, maxOutput: number) {
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.minOutput = minOutput;
    this.maxOutput = maxOutput;
  }

  calculate(target: number, current: number, dt: number): number {
    const error = target - current;
    this.integral += error * dt;
    const derivative = dt > 0 ? (error - this.prevError) / dt : 0;
    this.prevError = error;

    let output = (this.kp * error) + (this.ki * this.integral) + (this.kd * derivative);
    return Math.max(this.minOutput, Math.min(this.maxOutput, output));
  }

  reset() {
    this.integral = 0;
    this.prevError = 0;
  }
}

/**
 * Statistical Filter for Network Analytics (IQR Method)
 * Cleans out random lag spikes from mobile networks (4G/5G) to calculate true latency.
 */
class NetworkAnalyzer {
  private history: { rtt: number, offset: number }[] = [];
  private maxSize = 20;

  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    if (this.history.length > this.maxSize) this.history.shift();
  }

  getFilteredOffset(): { offset: number, jitter: number, rtt: number } {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    if (this.history.length < 4) {
       const latest = this.history[this.history.length - 1];
       return { offset: latest.offset, jitter: 50, rtt: latest.rtt };
    }

    // Sort by RTT to find the cleanest network packets
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    
    // Discard bottom 25% (impossible fast packets) and top 25% (lag spikes)
    const q1 = Math.floor(sorted.length * 0.25);
    const q3 = Math.floor(sorted.length * 0.75);
    const interQuartileRange = sorted.slice(q1, q3 + 1);

    let sumOffset = 0, sumRtt = 0;
    interQuartileRange.forEach(sample => {
      sumOffset += sample.offset;
      sumRtt += sample.rtt;
    });

    const avgOffset = sumOffset / interQuartileRange.length;
    const avgRtt = sumRtt / interQuartileRange.length;

    // Jitter is the standard deviation of the IQR offsets
    const variance = interQuartileRange.reduce((acc, val) => acc + Math.pow(val.offset - avgOffset, 2), 0) / interQuartileRange.length;
    const jitter = Math.sqrt(variance);

    return { offset: avgOffset, jitter, rtt: avgRtt };
  }
}

// ============================================================================
// PART 2: TYPES & INTERFACES
// ============================================================================

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
  hostUpdateId: number; // Incrementing ID to drop out-of-order packets
}

// ============================================================================
// PART 3: THE MEGA SYNC ENGINE HOOK
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

  // --- Core State ---
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);
  
  // --- Mutable Refs for Performance (Bypassing React Lifecycle) ---
  const handlersRef = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const deviceInfo = useRef(getDeviceInfo());
  const wakeLockRef = useRef<any>(null);

  // --- Analytics & AI Refs ---
  const networkAnalyzer = useRef(new NetworkAnalyzer());
  const bufferPidRef = useRef(new PIDController(0.6, 0.1, 0.05, 0.150, 1.200)); 
  const consecutiveMissesRef = useRef<number>(0); 
  const currentPlaybackRateRef = useRef<number>(1); 
  
  // --- Timing Locks ---
  const ignoreSyncUntilRef = useRef<number>(0);
  const softCatchupLockRef = useRef<number>(0);
  const lastSeekTimeRef = useRef<number>(0);
  const lastBroadcastTimeRef = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const epochIdCounterRef = useRef<number>(0);
  const catchupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Default initial penalty based on device class
  const initialPenalty = deviceInfo.current.os === 'iOS' ? 0.450 : deviceInfo.current.os === 'Android' ? 0.350 : 0.150;
  const currentPenaltyRef = useRef<number>(initialPenalty);

  // Master Epoch
  const playbackEpochRef = useRef<EpochState>({
    isPlaying: false,
    startNetworkTime: 0,
    startVideoTime: 0,
    videoId: null,
    hostUpdateId: 0
  });

  // Keep handlers updated
  useEffect(() => { 
      handlersRef.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; 
  });

  // ============================================================================
  // DEBUG LOGGER (Memory Safe)
  // ============================================================================
  const syncLogs = useRef<any[]>([]);
  const logDebug = useCallback((event: string, data: any) => {
    syncLogs.current.push({
      logTime: new Date().toISOString(),
      role: isHost ? 'HOST' : 'JOINER',
      event,
      ...data
    });
    if (syncLogs.current.length > 2500) syncLogs.current.shift(); // Prevent memory leaks on mobile
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syncLogs.current, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `sync_mega_log_${isHost ? 'host' : 'joiner'}_${userId.slice(0,5)}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }, [isHost, userId]);

  // ============================================================================
  // SYSTEM & HARDWARE EVENT LISTENERS
  // ============================================================================
  useEffect(() => {
    // 1. Wake Lock API (Prevents screen from sleeping which throttles CPU)
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        try { wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); } catch (err) {}
      }
    };
    requestWakeLock();

    // 2. Visibility Change Handler (Detects backgrounding)
    const handleVis = () => { 
      if (document.visibilityState === 'visible') {
         requestWakeLock();
         if (!isHost) {
            logDebug('APP_FOREGROUNDED', { time: Date.now() });
            // The browser paused all Javascript. We must completely resync immediately.
            requestSync(); 
            measureLatency();
         }
      } else {
         logDebug('APP_BACKGROUNDED', { time: Date.now() });
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [isHost]);

  // ============================================================================
  // NETWORK & CLOCK SYNC PROTOCOL
  // ============================================================================
  const measureLatency = useCallback(() => {
    if (!channelRef.current) return;
    channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { timestamp: Date.now(), senderId: userId } });
  }, [userId]);

  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    channelRef.current.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } });
  }, [isHost, userId]);

  const manualResync = useCallback(() => {
    if (isHost) return;
    setSyncStatus('syncing');
    syncStatusRef.current = 'syncing';
    networkAnalyzer.current = new NetworkAnalyzer(); // Clear bad history
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  // Execute an absolute hardware seek and lockout evaluation to allow physical buffering
  const safeSeek = useCallback((time: number, reason: string, lockDurationMs: number = 2500) => {
    logDebug('HARD_SEEK_EXECUTED', { targetTime: time, reason });
    if (catchupTimeoutRef.current) {
      clearTimeout(catchupTimeoutRef.current);
      catchupTimeoutRef.current = null;
    }
    
    handlersRef.current.seekTo(time);
    
    if (playbackEpochRef.current.isPlaying) {
       handlersRef.current.play();
    } else {
       handlersRef.current.pause();
    }
    
    ignoreSyncUntilRef.current = Date.now() + lockDurationMs; 
  }, [logDebug]);


  // ============================================================================
  // CORE SUPABASE REALTIME INITIALIZATION
  // ============================================================================
  useEffect(() => {
    logDebug('INIT_WEBRTC_CHANNEL', { roomId, userId });
    
    const channel = supabase.channel(`room:${roomId}`, {
      config: { 
          presence: { key: userId }, 
          broadcast: { self: false } 
      },
    });

    // --- PRESENCE HANDLER ---
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const devices: PresenceState[] = Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping, 
        os: p.os || 'Unknown', browser: p.browser || 'Unknown', 
        syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, 
        lastSyncDelta: p.lastSyncDelta || 0, jitter: p.jitter || 0
      }));
      setConnectedDevices(devices);
    });

    // --- PING HANDLER (HOST) ---
    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.senderId !== userId) {
        channel.send({ 
            type: 'broadcast', 
            event: 'pong', 
            payload: { timestamp: payload.timestamp, hostTime: Date.now(), targetId: payload.senderId } 
        });
      }
    });

    // --- PONG HANDLER (JOINER) ---
    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.targetId === userId) {
        const now = Date.now();
        const rawRtt = now - payload.timestamp;
        const rawOffset = payload.hostTime - payload.timestamp - (rawRtt / 2);
        
        // Feed into statistical analyzer to remove mobile network outliers
        networkAnalyzer.current.addSample(rawRtt, rawOffset);
        const { offset, jitter, rtt } = networkAnalyzer.current.getFilteredOffset();
        
        clockOffsetRef.current = offset;
        setLatency(Math.round(rtt));
        setNetworkJitter(Math.round(jitter));
        latencyRef.current = Math.round(rtt);
        
        channel.track({ 
            id: userId, isHost, joinedAt: Date.now(), 
            os: deviceInfo.current.os, browser: deviceInfo.current.browser, 
            syncStatus: syncStatusRef.current, latency: Math.round(rtt), 
            lastSyncDelta: lastSyncDelta, jitter: Math.round(jitter) 
        });
      }
    });

    // --- SYNC REQUEST HANDLER (HOST) ---
    channel.on('broadcast', { event: 'sync_request' }, () => {
      if (!isHost) return;
      channel.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => { 
        if (!isHost && payload) handlersRef.current.onQueueUpdate?.(payload as QueueState); 
    });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: any }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlersRef.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        
        // Wipe locks, but KEEP PID PENALTY INTACT (carries over across songs)
        ignoreSyncUntilRef.current = 0;
        softCatchupLockRef.current = 0;
        consecutiveMissesRef.current = 0;
        
        safeSeek(0, 'New Video Started');
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });


    // ============================================================================
    // THE MASTER AI SYNC EVALUATION ENGINE (JOINERS ONLY)
    // ============================================================================
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;
      
      // Prevent processing out-of-order UDP packets
      if (payload.hostUpdateId < playbackEpochRef.current.hostUpdateId) return;
      playbackEpochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      const networkTime = Date.now() + clockOffsetRef.current;
      let newStatus: SyncStatus = 'synced';

      const isPlayingNow = payload.isPlaying;
      const justResumed = isPlayingNow && !wasPlayingRef.current;
      wasPlayingRef.current = isPlayingNow;

      if (isPlayingNow) {
        // --- BYPASS LOCKS ---
        if (Date.now() < ignoreSyncUntilRef.current) return;
        if (Date.now() < softCatchupLockRef.current) return; // Currently mid-glide

        // --- HARDWARE DECODING OFFSETS ---
        // Bluetooth headphones, Airpods, and specific OS audio pipelines add physical delay
        let hardwareOffset = 0;
        if (deviceInfo.current.os === 'iOS') hardwareOffset = 0.050; // Safari iOS Audio Stack
        if (deviceInfo.current.os === 'macOS') hardwareOffset = 0.020; // CoreAudio
        if (deviceInfo.current.os === 'Android') hardwareOffset = 0.080; // Android AudioFlinger

        const expectedVideoTime = payload.startVideoTime + ((networkTime - payload.startNetworkTime) / 1000) - hardwareOffset;
        const localTime = handlersRef.current.getCurrentTime();
        
        const drift = expectedVideoTime - localTime;
        const absDrift = Math.abs(drift);
        setLastSyncDelta(Math.round(absDrift * 1000));

        // --- DYNAMIC JITTER TOLERANCE ---
        // If on 4G/5G, network ping fluctuates. We cannot enforce 10ms sync if the network lies by 40ms.
        const currentJitterSecs = (networkJitter / 1000) || 0;
        const dynamicTolerance = Math.max(0.010, Math.min(0.060, currentJitterSecs * 1.5)); 

        logDebug('SYNC_EVALUATION', {
          localTime, expectedVideoTime, drift, absDrift, 
          activePenalty: currentPenaltyRef.current, tolerance: dynamicTolerance
        });

        // 🚀 SCENARIO 1: INSTANT RESUME PENALTY
        // The host just pressed play. We know the iframe will spin the loading wheel.
        // Pre-emptively seek forward by our learned penalty to negate the wheel.
        if (justResumed && absDrift > dynamicTolerance) {
             const targetTime = expectedVideoTime + currentPenaltyRef.current;
             safeSeek(targetTime, `Instant Resume Forward-Seek. Expected Buffer: ${currentPenaltyRef.current.toFixed(3)}s`);
             return; 
        }

        // 🎯 SCENARIO 2: OUT OF TOLERANCE (DRIFT DETECTED)
        if (absDrift > dynamicTolerance) { 
          consecutiveMissesRef.current += 1;

          // Only trigger heavy corrections if it misses multiple times (ignores single lag spikes)
          if (consecutiveMissesRef.current >= 2) {
              if (drift > 0) {
                 // 🔴 FALLING BEHIND
                 // Run PID calculation. We use time since last seek as delta-time (dt).
                 const dt = (Date.now() - lastSeekTimeRef.current) / 1000;
                 if (dt > 0 && dt < 10) {
                     // We sought recently and still fell behind. Device is slow.
                     currentPenaltyRef.current += bufferPidRef.current.calculate(0, -absDrift, dt);
                     currentPenaltyRef.current = Math.min(currentPenaltyRef.current, 1.200); // Cap at 1.2s
                 }
    
                 const targetTime = expectedVideoTime + currentPenaltyRef.current;
                 lastSeekTimeRef.current = Date.now();
                 safeSeek(targetTime, `Macro-Behind: ${absDrift.toFixed(3)}s. PID Adjusted Penalty: ${currentPenaltyRef.current.toFixed(3)}s`);
              } else {
                 // 🟢 DRIFTING AHEAD
                 if (Date.now() - lastSeekTimeRef.current < 5000) {
                     // We sought recently and overshot. Penalty was too high.
                     currentPenaltyRef.current -= (absDrift * 0.6); 
                     currentPenaltyRef.current = Math.max(0.100, currentPenaltyRef.current);
                 }
                 lastSeekTimeRef.current = 0; 
    
                 // 🎧 THE SOFT-CATCHUP GLIDE (Micro-leads < 60ms)
                 // Instead of a jarring JS pause, we drop playback speed to 0.75x to imperceptibly let the Host catch up.
                 if (absDrift <= 0.060) {
                     logDebug('SOFT_CATCHUP_GLIDE', { reason: `Ahead by ${absDrift.toFixed(3)}s`, rate: 0.75 });
                     
                     handlersRef.current.setPlaybackRate(0.75);
                     currentPlaybackRateRef.current = 0.75;
                     
                     // At 0.75x speed, video loses 0.25s of virtual time per 1s of real time.
                     // Time to hold 0.75x = (drift / 0.25) seconds
                     const glideTimeMs = Math.min((absDrift / 0.25) * 1000, 800);
                     
                     // Lock the sync evaluator while we glide, then restore normal speed
                     softCatchupLockRef.current = Date.now() + glideTimeMs;
                     setTimeout(() => {
                         handlersRef.current.setPlaybackRate(1.0);
                         currentPlaybackRateRef.current = 1.0;
                         logDebug('SOFT_CATCHUP_END', { restoredRate: 1.0 });
                     }, glideTimeMs);
                     
                 } else {
                     // MACRO-AHEAD: Hard Pause Catchup (> 60ms)
                     const pauseTimeMs = Math.round(absDrift * 1000);
                     if (pauseTimeMs >= 15) {
                         logDebug('HARD_PAUSE_CATCHUP', { reason: `Ahead by ${absDrift.toFixed(3)}s`, pauseTimeMs });
                         
                         if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
                         handlersRef.current.pause();
                         
                         ignoreSyncUntilRef.current = Date.now() + pauseTimeMs + 500; 
                         
                         catchupTimeoutRef.current = setTimeout(() => {
                            handlersRef.current.play();
                            catchupTimeoutRef.current = null;
                         }, pauseTimeMs);
                     }
                 }
              }
          }
          newStatus = 'syncing';
        } else {
          // 🏆 PERFECT SYNC ACHIEVED
          consecutiveMissesRef.current = 0;
          bufferPidRef.current.reset(); // Reset integral windup
          
          if (currentPlaybackRateRef.current !== 1 && Date.now() > softCatchupLockRef.current) {
              handlersRef.current.setPlaybackRate(1);
              currentPlaybackRateRef.current = 1;
          }
        }

        // Failsafe: Ensure player is physically moving
        if (handlersRef.current.getPlayerState() !== 1 && newStatus !== 'syncing' && !catchupTimeoutRef.current) {
          handlersRef.current.play();
        }

      } else {
        // ⏸️ SCENARIO 3: HOST IS PAUSED
        if (catchupTimeoutRef.current) {
           clearTimeout(catchupTimeoutRef.current);
           catchupTimeoutRef.current = null;
        }
        if (handlersRef.current.getPlayerState() === 1) {
          handlersRef.current.pause();
        }
        const localTime = handlersRef.current.getCurrentTime();
        // Exact sync placement when paused (Threshold 10ms)
        if (Math.abs(localTime - payload.startVideoTime) > 0.010) {
          handlersRef.current.seekTo(payload.startVideoTime); 
        }
        setLastSyncDelta(0);
      }

      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;
    });

    // --- CONNECTION SUBSCRIPTION ---
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, lastSyncDelta: 0 });
        if (!isHost) {
          // Burst pings to rapidly establish NTP offset on join
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 12) channel.send({ type: 'broadcast', event: 'ping', payload: { timestamp: Date.now(), senderId: userId } });
             else { clearInterval(interval); channel.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } }); }
          }, 250);
        }
      }
    });

    channelRef.current = channel;
    return () => { 
        if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
        channel.unsubscribe(); 
    };
  }, [roomId, userId, isHost, logDebug, safeSeek]);


  // ============================================================================
  // HOST BROADCAST ENGINE
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    
    // Polling every 150ms for instant native Play/Pause/Seek response
    const interval = setInterval(() => {
      const currentTime = handlersRef.current.getCurrentTime();
      const playerState = handlersRef.current.getPlayerState();
      const networkTime = Date.now() + clockOffsetRef.current;
      const isPlaying = playerState === 1;

      let stateChanged = false;

      if (isPlaying) {
        const expectedTime = playbackEpochRef.current.startVideoTime + ((networkTime - playbackEpochRef.current.startNetworkTime) / 1000);
        // If Host physically scrubbed timeline, it violates expected time
        if (!playbackEpochRef.current.isPlaying || Math.abs(expectedTime - currentTime) > 0.5) {
           epochIdCounterRef.current += 1;
           playbackEpochRef.current = { isPlaying: true, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, hostUpdateId: epochIdCounterRef.current };
           stateChanged = true;
        }
      } else {
         // Host physically pressed pause
         if (playbackEpochRef.current.isPlaying || Math.abs(playbackEpochRef.current.startVideoTime - currentTime) > 0.5) {
           epochIdCounterRef.current += 1;
           playbackEpochRef.current = { isPlaying: false, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current, hostUpdateId: epochIdCounterRef.current };
           stateChanged = true;
         }
      }

      const now = Date.now();
      // Broadcast instantly if state changed, OR send a slow heartbeat every 3 seconds to keep network alive
      if (stateChanged || now - lastBroadcastTimeRef.current > 3000) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
        lastBroadcastTimeRef.current = now;
        if (stateChanged) logDebug('HOST_EPOCH_UPDATED', playbackEpochRef.current);
      }
    }, 150); 
    return () => clearInterval(interval);
  }, [isHost, logDebug]);


  // ============================================================================
  // MANUAL CONTROLS
  // ============================================================================
  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    epochIdCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: true, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochIdCounterRef.current };
    logDebug('HOST_BROADCAST_PLAY', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost, logDebug]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    epochIdCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: false, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochIdCounterRef.current };
    logDebug('HOST_BROADCAST_PAUSE', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost, logDebug]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    const isCurrentlyPlaying = handlersRef.current.getPlayerState() === 1;
    epochIdCounterRef.current += 1;
    
    playbackEpochRef.current = { 
      isPlaying: isCurrentlyPlaying, 
      startNetworkTime: Date.now() + clockOffsetRef.current, 
      startVideoTime: 0, 
      videoId,
      hostUpdateId: epochIdCounterRef.current
    };
    
    logDebug('HOST_BROADCAST_VIDEO_CHANGE', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } });
  }, [logDebug]);

  const forceResync = useCallback(() => { 
    if (!isHost || !channelRef.current) return;
    epochIdCounterRef.current += 1;
    playbackEpochRef.current = { isPlaying: handlersRef.current.getPlayerState() === 1, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current, hostUpdateId: epochIdCounterRef.current };
    channelRef.current.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate, forceResync, manualResync, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId,
  };
};
