import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

export const ENGINE_VERSION = "v5.0-Predictive-HoltWinters";

// ============================================================================
// PART 1: ENTERPRISE CONTROL THEORY & SIGNAL PROCESSING
// ============================================================================

class KalmanFilter {
  private r: number; private q: number; private p: number; private x: number; private k: number;
  constructor(measurementNoise = 10, processNoise = 0.1, initialError = 1, initialEstimate = 0) {
    this.r = measurementNoise; this.q = processNoise; this.p = initialError; this.x = initialEstimate; this.k = 0;
  }
  filter(measurement: number): number {
    if (this.x === 0) { this.x = measurement; return measurement; }
    this.p = this.p + this.q; 
    this.k = this.p / (this.p + this.r); 
    this.x = this.x + this.k * (measurement - this.x); 
    this.p = (1 - this.k) * this.p; 
    return this.x;
  }
}

class NTPAnalyzer {
  private history: { rtt: number, offset: number }[] = [];
  private emaOffset: number | null = null;
  private readonly alpha = 0.15; 
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
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const bestPackets = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.5));
    let sumOffset = 0; let sumRtt = 0;
    bestPackets.forEach(sample => { sumOffset += sample.offset; sumRtt += sample.rtt; });
    const avgOffset = sumOffset / bestPackets.length;
    const avgRtt = sumRtt / bestPackets.length;
    const variance = bestPackets.reduce((acc, val) => acc + Math.pow(val.rtt - avgRtt, 2), 0) / bestPackets.length;
    if (this.emaOffset === null) this.emaOffset = avgOffset;
    else this.emaOffset = (this.alpha * avgOffset) + ((1 - this.alpha) * this.emaOffset);
    return { offset: this.emaOffset, jitter: Math.sqrt(variance), rtt: avgRtt };
  }
}

class PIDController {
  private kp: number; private ki: number; private kd: number;
  private integral: number = 0; private prevError: number = 0;
  private minOut: number; private maxOut: number;
  private derivative: number = 0;
  constructor(kp: number, ki: number, kd: number, minOut: number, maxOut: number) {
    this.kp = kp; this.ki = ki; this.kd = kd; this.minOut = minOut; this.maxOut = maxOut;
  }
  calculate(error: number, dt: number): number {
    if (dt <= 0) return 0;
    const p = this.kp * error;
    this.integral += error * dt;
    if (this.integral * this.ki > this.maxOut) this.integral = this.maxOut / this.ki;
    else if (this.integral * this.ki < this.minOut) this.integral = this.minOut / this.ki;
    const rawD = (error - this.prevError) / dt;
    this.derivative = (0.7 * rawD) + (0.3 * this.derivative); 
    const d = this.kd * this.derivative;
    this.prevError = error;
    return Math.max(this.minOut, Math.min(this.maxOut, p + (this.ki * this.integral) + d));
  }
  reset() { this.integral = 0; this.prevError = 0; this.derivative = 0; }
}

// 🚀 NEW: HOLT-WINTERS PREDICTOR 🚀
// Uses Double Exponential Smoothing to predict where the audio will drift before it happens.
class HoltWintersPredictor {
    private alpha: number = 0.4; // Data Smoothing
    private beta: number = 0.3;  // Trend Smoothing
    private level: number | null = null;
    private trend: number = 0;

    predictNext(currentDrift: number): number {
        if (this.level === null) {
            this.level = currentDrift;
            return currentDrift;
        }
        const lastLevel = this.level;
        this.level = (this.alpha * currentDrift) + ((1 - this.alpha) * (lastLevel + this.trend));
        this.trend = (this.beta * (this.level - lastLevel)) + ((1 - this.beta) * this.trend);
        return this.level + this.trend;
    }
    
    reset() { this.level = null; this.trend = 0; }
}

const getAudioHardwareOffset = (os: string, browser: string): number => {
  if (os === 'iOS') return 0.055; 
  if (os === 'macOS' && browser.includes('Safari')) return 0.020;
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035; 
  if (os === 'Android') return 0.090; 
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
// PART 2: THE V5 PREDICTIVE ENGINE
// ============================================================================

export const useSyncEngine = ({
  roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate,
}: UseSyncEngineProps) => {

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  
  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);
  const lastSyncDeltaRef = useRef<number>(0); 
  
  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; });
  
  const deviceInfo = useRef(getDeviceInfo());
  const wakeLockRef = useRef<any>(null);

  const ntpAnalyzer = useRef(new NTPAnalyzer());
  const kalmanRtt = useRef(new KalmanFilter(15, 0.5, 1, 0));
  const clockOffsetRef = useRef<number>(0); 
  const networkJitterRef = useRef<number>(0);
  const pingCountRef = useRef<number>(0);
  const isNtpFrozenRef = useRef<boolean>(false);
  const currentVideoIdRef = useRef<string | null>(null);
  
  const epochRef = useRef<EpochState>({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, updateId: 0 });

  const isColdStartRef = useRef<boolean>(true);
  const warmPenaltyPID = useRef(new PIDController(0.6, 0.05, 0.1, -0.200, 1.000)); 
  const driftPredictor = useRef(new HoltWintersPredictor());
  const currentWarmPenaltyRef = useRef<number>(deviceInfo.current.os === 'iOS' ? 0.350 : 0.150);
  const consecutiveBufferingTicks = useRef<number>(0); 
  
  const currentPlaybackRateRef = useRef<number>(1.0);
  const timeTracker = useRef({ rawTime: 0, sysTime: 0 });
  const cpuTracker = useRef({ lastTick: 0 });

  const ignoreSyncUntil = useRef<number>(0);
  const softGlideUntil = useRef<number>(0);
  const postBufferGracePeriodUntil = useRef<number>(0);
  const lastSeekTime = useRef<number>(0);
  const lastHostBroadcastTime = useRef<number>(0);
  const consecutiveMisses = useRef<number>(0);
  const catchupTimeout = useRef<NodeJS.Timeout | null>(null);
  const cachedVideoIdRef = useRef<string | null>(null); 

  const getHighResTime = useCallback(() => {
    const rawTime = handlers.current.getCurrentTime();
    const now = performance.now();
    const state = handlers.current.getPlayerState();

    if (rawTime !== timeTracker.current.rawTime) {
        timeTracker.current.rawTime = rawTime;
        timeTracker.current.sysTime = now;
        return rawTime;
    }

    if (state === 1) { 
        const elapsedSinceRealUpdate = (now - timeTracker.current.sysTime) / 1000;
        if (elapsedSinceRealUpdate < 0.500) {
            return rawTime + (elapsedSinceRealUpdate * currentPlaybackRateRef.current);
        }
    }
    return rawTime;
  }, []);

  const syncLogs = useRef<any[]>([]);
  const collectedLogsRef = useRef<Record<string, any[]>>({});

  const logEvent = useCallback((e: string, data: any = {}) => {
    const currentState = handlers.current.getPlayerState();
    const currentHighResTime = getHighResTime();
    
    // CPU Freeze Detection
    const now = performance.now();
    let cpuLag = 0;
    if (cpuTracker.current.lastTick > 0) {
        // Interval should be 300ms. Anything over 350ms means JS is choking.
        const dt = now - cpuTracker.current.lastTick;
        if (dt > 350) cpuLag = dt - 300;
    }
    cpuTracker.current.lastTick = now;

    syncLogs.current.push({ 
      t: new Date().toISOString(), 
      r: isHost ? 'HOST' : 'JOINER', 
      e, 
      ctx: { state: currentState, locTime: currentHighResTime, jitter: networkJitterRef.current, cpuLag },
      ...data 
    });
    
    if (syncLogs.current.length > 3000) syncLogs.current.shift();
  }, [isHost, getHighResTime]);

  const downloadLogs = useCallback(() => {
    if (isHost && channelRef.current) {
      collectedLogsRef.current = { [`HOST_${deviceInfo.current.os}_${userId.slice(0,5)}`]: syncLogs.current };
      logEvent('BROADCAST_LOG_REQUEST', {});
      channelRef.current.send({ type: 'broadcast', event: 'request_logs', payload: {} });
      setTimeout(() => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectedLogsRef.current, null, 2));
        const a = document.createElement('a'); a.href = dataStr; a.download = `sync_v5_ALL_DEVICES_${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      }, 2500);
    }
  }, [isHost, userId, logEvent]);

  useEffect(() => {
    const acquireWakeLock = async () => { if ('wakeLock' in navigator && !wakeLockRef.current) { try { wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); } catch (e) {} } };
    acquireWakeLock();
    const handleVis = () => { if (document.visibilityState === 'visible') { acquireWakeLock(); if (!isHost) { logEvent('APP_FOREGROUNDED'); ignoreSyncUntil.current = 0; channelRef.current?.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); } } };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [isHost, logEvent, userId]);

  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs = 2500) => {
    logEvent('HARD_SEEK_EXEC', { target: time, reason });
    if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
    handlers.current.seekTo(time);
    if (epochRef.current.isPlaying) handlers.current.play(); else handlers.current.pause();
    ignoreSyncUntil.current = Date.now() + lockoutMs; 
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number, direction: 'ahead' | 'behind') => {
      const rate = direction === 'ahead' ? 0.75 : 1.25;
      const holdTimeMs = Math.min((driftSeconds / 0.25) * 1000, 2000); 
      logEvent('SOFT_GLIDE_EXEC', { direction, driftSeconds, holdTimeMs, rate });
      currentPlaybackRateRef.current = rate;
      handlers.current.setPlaybackRate(rate);
      softGlideUntil.current = Date.now() + holdTimeMs;
      ignoreSyncUntil.current = Date.now() + holdTimeMs + 200; 
      setTimeout(() => { currentPlaybackRateRef.current = 1.0; handlers.current.setPlaybackRate(1.0); logEvent('SOFT_GLIDE_END', { restoredRate: 1.0 }); }, holdTimeMs);
  }, [logEvent]);

  const requestSync = useCallback(() => { if (!channelRef.current || isHost) return; channelRef.current.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); }, [isHost, userId]);
  const measureLatency = useCallback(() => { if (!channelRef.current) return; channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } }); }, [userId]);

  // ============================================================================
  // LAYER 1: SUPABASE WEBRTC NETWORK DEMUXER
  // ============================================================================
  useEffect(() => {
    logEvent('INIT_NTP_BUS', { roomId, version: ENGINE_VERSION });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } }});

    channel.on('presence', { event: 'sync' }, () => {
      setConnectedDevices(Object.values(channel.presenceState()).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, os: p.os || '?', browser: p.browser || '?', syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, jitter: p.jitter || 0, cachedVideoId: p.cachedVideoId, lastSyncDelta: p.lastSyncDelta || 0
      })));
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => { if (isHost && payload.sId !== userId) channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } }); });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId && !isNtpFrozenRef.current) {
        pingCountRef.current += 1;
        const rtt = kalmanRtt.current.filter(Date.now() - payload.t); 
        const offset = payload.ht - payload.t - (rtt / 2);
        ntpAnalyzer.current.addSample(rtt, offset);
        const metrics = ntpAnalyzer.current.getMetrics();
        clockOffsetRef.current = metrics.offset; networkJitterRef.current = metrics.jitter;
        setLatency(Math.round(metrics.rtt)); setNetworkJitter(Math.round(metrics.jitter));
        if (pingCountRef.current > 45) { isNtpFrozenRef.current = true; logEvent('NTP_FROZEN_LOCKED', { finalOffset: metrics.offset, finalJitter: metrics.jitter }); }
        if (Math.random() < 0.2) channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, syncStatus: 'synced', latency: Math.round(metrics.rtt), jitter: Math.round(metrics.jitter), cachedVideoId: cachedVideoIdRef.current });
      }
    });

    channel.on('broadcast', { event: 'request_logs' }, () => { if (!isHost) { logEvent('UPLOADING_LOGS'); channel.send({ type: 'broadcast', event: 'submit_logs', payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } }); }});
    channel.on('broadcast', { event: 'submit_logs' }, ({ payload }) => { if (isHost) collectedLogsRef.current[`JOINER_${payload.os}_${payload.uId.slice(0,5)}`] = payload.logs; });

    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost || payload.updateId < epochRef.current.updateId) return; 
      const wasPlaying = epochRef.current.isPlaying;
      epochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        currentVideoIdRef.current = payload.videoId; isColdStartRef.current = true; handlers.current.onVideoChange?.(payload.videoId, "", ""); logEvent('CMD_NEW_VIDEO_PIPELINE', { vId: payload.videoId }); handlers.current.seekTo(0); ignoreSyncUntil.current = Date.now() + 2500; return;
      }

      if (payload.isPlaying && !wasPlaying) {
         if (Date.now() < ignoreSyncUntil.current) return;
         logEvent('HOST_CMD_PLAY_RECEIVED');
         const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
         const expectedTime = payload.startVideoTime + ((Date.now() + clockOffsetRef.current - payload.startNetworkTime) / 1000) - dacOffset;
         if (isColdStartRef.current) {
             const coldPenalty = deviceInfo.current.os === 'iOS' ? 1.800 : 1.200;
             executeHardSeek(expectedTime + coldPenalty, `Cold Start Resume: +${coldPenalty}s`, 3500);
             isColdStartRef.current = false; 
         } else { executeHardSeek(expectedTime + currentWarmPenaltyRef.current, `Warm Resume: +${currentWarmPenaltyRef.current.toFixed(3)}s`); }
      }
      
      if (!payload.isPlaying) {
         if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
         handlers.current.pause();
         logEvent('HOST_CMD_PAUSE_RECEIVED');
         if (Math.abs(getHighResTime() - payload.startVideoTime) > 0.05) handlers.current.seekTo(payload.startVideoTime);
      }
    });

    channel.on('broadcast', { event: 'sync_req' }, () => { if (isHost) channel.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, jitter: 0, cachedVideoId: cachedVideoIdRef.current });
        if (!isHost) {
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 45) channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
             else { clearInterval(interval); channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); }
          }, 150);
        }
      }
    });

    channelRef.current = channel;
    return () => { if (catchupTimeout.current) clearTimeout(catchupTimeout.current); channel.unsubscribe(); };
  }, [roomId, userId, isHost, logEvent, executeHardSeek, getHighResTime]);

  // ============================================================================
  // LAYER 2: AUTONOMOUS PREDICTIVE JOINER LOOP 
  // ============================================================================
  useEffect(() => {
    if (isHost) return;

    const interval = setInterval(() => {
      const epoch = epochRef.current;
      if (!epoch.videoId) return;
      
      const playerState = handlers.current.getPlayerState();
      
      if (playerState === 3) {
          consecutiveBufferingTicks.current += 1;
          if (consecutiveBufferingTicks.current > 2) { 
              logEvent('TRUE_MACRO_BUFFER_DETECTED'); setSyncStatus('syncing'); ignoreSyncUntil.current = Date.now() + 1000; postBufferGracePeriodUntil.current = Date.now() + 3000; 
          }
          return; 
      } else { consecutiveBufferingTicks.current = 0; }

      if (!epoch.isPlaying) {
          if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
          if (playerState === 1) handlers.current.pause();
          const drift = Math.abs(getHighResTime() - epoch.startVideoTime);
          setLastSyncDelta(Math.round(drift * 1000)); lastSyncDeltaRef.current = Math.round(drift * 1000);
          if (drift > 0.050) handlers.current.seekTo(epoch.startVideoTime);
          setSyncStatus('synced'); return;
      }

      if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current) return;

      const networkTime = Date.now() + clockOffsetRef.current;
      const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
      const expectedTime = epoch.startVideoTime + ((networkTime - epoch.startNetworkTime) / 1000) - dacOffset;
      const localTime = getHighResTime();
      
      const rawDrift = expectedTime - localTime;
      
      // 🚀 THE PREDICTIVE LAYER 🚀
      // Smooth out the host's micro-stutters and predict the true playhead position.
      const predictedDrift = driftPredictor.current.predictNext(rawDrift);
      const absDrift = Math.abs(predictedDrift);
      
      setLastSyncDelta(Math.round(absDrift * 1000));
      lastSyncDeltaRef.current = Math.round(absDrift * 1000);

      // 🏆 GOLDEN V2 PSYTRANCE DEADBAND (< 10ms)
      if (absDrift <= 0.010) {
          consecutiveMisses.current = 0;
          warmPenaltyPID.current.reset();
          driftPredictor.current.reset(); // Stay perfectly locked
          setSyncStatus('synced');
          if (playerState !== 1) handlers.current.play();
          return; 
      }
      
      const tolerance = Math.max(0.015, Math.min(0.200, (networkJitterRef.current / 1000) * 1.5));

      if (absDrift > tolerance) {
          consecutiveMisses.current += 1;
          
          if (consecutiveMisses.current >= 2) {
              setSyncStatus('syncing');
              const isMacroBufferGrace = Date.now() < postBufferGracePeriodUntil.current;
              
              logEvent('PREDICTIVE_CORRECTION', { predictedDrift, rawDrift });

              if (predictedDrift > 0) {
                  // 🔴 BEHIND
                  const dt = (Date.now() - lastSeekTime.current) / 1000;
                  if (dt > 0 && dt < 15 && !isColdStartRef.current && absDrift > 0.200) {
                      currentWarmPenaltyRef.current += warmPenaltyPID.current.calculate(absDrift, dt);
                      currentWarmPenaltyRef.current = Math.min(1.200, currentWarmPenaltyRef.current);
                  }

                  if (absDrift <= 0.150 || (isMacroBufferGrace && absDrift < 1.0)) {
                      executeSoftGlide(absDrift, 'behind'); 
                  } else {
                      const penalty = isColdStartRef.current ? 1.0 : currentWarmPenaltyRef.current;
                      executeHardSeek(expectedTime + penalty, `Macro-Behind: ${absDrift.toFixed(3)}s`);
                      lastSeekTime.current = Date.now();
                      isColdStartRef.current = false;
                  }
              } else {
                  // 🟢 AHEAD (Golden V2 Micro-Pause Magic)
                  if (Date.now() - lastSeekTime.current < 5000 && !isColdStartRef.current && absDrift > 0.200) {
                      currentWarmPenaltyRef.current -= (absDrift * 0.4);
                      currentWarmPenaltyRef.current = Math.max(0.100, currentWarmPenaltyRef.current);
                  }
                  lastSeekTime.current = 0;

                  if (absDrift <= 0.050) {
                      executeSoftGlide(absDrift, 'ahead'); 
                  } else {
                      // Precise Wi-Fi Sync Lock
                      const pauseMs = Math.round(absDrift * 1000) - 5;
                      logEvent('MICRO_PAUSE_EXEC', { pauseMs });
                      if (catchupTimeout.current) clearTimeout(catchupTimeout.current);
                      handlers.current.pause();
                      ignoreSyncUntil.current = Date.now() + pauseMs + 400;
                      catchupTimeout.current = setTimeout(() => { handlers.current.play(); catchupTimeout.current = null; }, pauseMs);
                  }
              }
          }
      } else {
          consecutiveMisses.current = 0;
          setSyncStatus('synced');
          if (playerState !== 1) handlers.current.play();
      }

    }, 300); 
    return () => clearInterval(interval);
  }, [isHost, logEvent, executeHardSeek, executeSoftGlide, getHighResTime]);

  // ============================================================================
  // LAYER 3: HOST BROADCAST POLLER 
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const currentTime = getHighResTime();
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

      if (stateChanged || Date.now() - lastHostBroadcastTime.current > 2500) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
        lastHostBroadcastTime.current = Date.now();
        if (stateChanged) logEvent('HOST_STATE_CHANGED', epochRef.current);
      }
    }, 100); 
    return () => clearInterval(interval);
  }, [isHost, logEvent, getHighResTime]);

  const broadcastPlay = useCallback(() => { if (!isHost) return; epochRef.current = { isPlaying: true, startNetworkTime: Date.now(), startVideoTime: getHighResTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 }; channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); }, [isHost, getHighResTime]);
  const broadcastPause = useCallback(() => { if (!isHost) return; epochRef.current = { isPlaying: false, startNetworkTime: Date.now(), startVideoTime: getHighResTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 }; channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); }, [isHost, getHighResTime]);
  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => { currentVideoIdRef.current = videoId; epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now(), startVideoTime: 0, videoId, updateId: epochRef.current.updateId + 1 }; channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } }); }, []);
  const forceResync = useCallback(() => { if (!isHost) return; epochRef.current = { isPlaying: handlers.current.getPlayerState() === 1, startNetworkTime: Date.now(), startVideoTime: getHighResTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 }; channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); }, [isHost, getHighResTime]);

  const manualResyncFunc = useCallback(() => {
    if (isHost) return;
    setSyncStatus('syncing');
    ntpAnalyzer.current = new NTPAnalyzer();
    kalmanRtt.current = new KalmanFilter(15, 0.5, 1, 0);
    driftPredictor.current.reset();
    isNtpFrozenRef.current = false;
    pingCountRef.current = 0;
    requestSync();
    for(let i=0; i<10; i++) setTimeout(measureLatency, i*100);
  }, [isHost, requestSync, measureLatency]);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate: () => {}, forceResync, manualResync: manualResyncFunc, measureLatency, downloadLogs, engineVersion: ENGINE_VERSION,
    deviceInfo: deviceInfo.current, setCurrentVideoId: (id: string) => { currentVideoIdRef.current = id; },
    reportPreloadReady: (vid: string) => { cachedVideoIdRef.current = vid; if (!isHost) channelRef.current?.track({ id: userId, isHost: false, cachedVideoId: vid }); }
  };
};
