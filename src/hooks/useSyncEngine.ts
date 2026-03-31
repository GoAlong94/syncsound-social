import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

export const ENGINE_VERSION = "v7.0-RateOnly-ContinuousNTP";

// ============================================================================
// PART 1: SIGNAL PROCESSING
// ============================================================================

class KalmanFilter {
  private r: number; private q: number; private p: number; private x: number; private k: number;
  constructor(measurementNoise = 10, processNoise = 0.1, initialError = 1, initialEstimate = 0) {
    this.r = measurementNoise; this.q = processNoise; this.p = initialError; this.x = initialEstimate; this.k = 0;
  }
  filter(measurement: number): number {
    if (this.x === 0) { this.x = measurement; return measurement; }
    this.p = this.p + this.q; this.k = this.p / (this.p + this.r);
    this.x = this.x + this.k * (measurement - this.x); this.p = (1 - this.k) * this.p; return this.x;
  }
  reset(initialEstimate = 0) { this.p = 1; this.x = initialEstimate; this.k = 0; }
}

class NTPAnalyzer {
  private history: { rtt: number; offset: number }[] = [];
  private emaOffset: number | null = null;
  private readonly alpha = 0.15;
  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset }); if (this.history.length > 30) this.history.shift();
  }
  getMetrics(): { offset: number; jitter: number; rtt: number } {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    if (this.history.length < 5) { const l = this.history[this.history.length - 1]; return { offset: l.offset, jitter: 50, rtt: l.rtt }; }
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.5));
    let sumO = 0, sumR = 0; best.forEach(s => { sumO += s.offset; sumR += s.rtt; });
    const avgO = sumO / best.length, avgR = sumR / best.length;
    const variance = best.reduce((acc, v) => acc + Math.pow(v.rtt - avgR, 2), 0) / best.length;
    if (this.emaOffset === null) { this.emaOffset = avgO; } else { this.emaOffset = (this.alpha * avgO) + ((1 - this.alpha) * this.emaOffset); }
    return { offset: this.emaOffset, jitter: Math.sqrt(variance), rtt: avgR };
  }
  reset() { this.history = []; this.emaOffset = null; }
}

class PIDController {
  private kp: number; private ki: number; private kd: number;
  private integral: number = 0; private prevError: number = 0; private minOut: number; private maxOut: number; private derivative: number = 0;
  constructor(kp: number, ki: number, kd: number, minOut: number, maxOut: number) { this.kp = kp; this.ki = ki; this.kd = kd; this.minOut = minOut; this.maxOut = maxOut; }
  calculate(error: number, dt: number, isAggressive: boolean = false): number {
    if (dt <= 0) return 0;
    const activeKi = isAggressive ? 0.15 : this.ki;
    const p = this.kp * error; this.integral += error * dt;
    if (this.integral * activeKi > this.maxOut) this.integral = this.maxOut / activeKi;
    else if (this.integral * activeKi < this.minOut) this.integral = this.minOut / activeKi;
    const rawD = (error - this.prevError) / dt; this.derivative = (0.7 * rawD) + (0.3 * this.derivative);
    this.prevError = error;
    return Math.max(this.minOut, Math.min(this.maxOut, p + (activeKi * this.integral) + (this.kd * this.derivative)));
  }
  reset() { this.integral = 0; this.prevError = 0; this.derivative = 0; }
}

// ============================================================================
// FIX #4: AudioContext DAC calibration
// Measures actual audio pipeline latency of this specific device.
// Falls back to OS-based estimates if AudioContext is unavailable.
// ============================================================================

const getAudioHardwareOffsetFallback = (os: string, browser: string): number => {
  if (os === 'iOS' || os === 'iPadOS') return 0.055;
  if (os === 'macOS' && browser.includes('Safari')) return 0.020;
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035;
  if (os === 'Android') return 0.090;
  if (os === 'Windows') return 0.045;
  return 0.040;
};

async function measureDACOffset(os: string, browser: string): Promise<number> {
  try {
    if (typeof window === 'undefined' || !window.AudioContext) return getAudioHardwareOffsetFallback(os, browser);
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const bufferSize = Math.floor(ctx.sampleRate * 0.1);
    const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    const wallBefore = performance.now();
    src.start(ctx.currentTime + 0.01);
    await new Promise<void>(resolve => { src.onended = () => resolve(); setTimeout(resolve, 300); });
    const elapsed = (performance.now() - wallBefore) / 1000;
    const measured = Math.max(0, elapsed - 0.110);
    await ctx.close();
    if (measured < 0.005 || measured > 0.200) return getAudioHardwareOffsetFallback(os, browser);
    return measured;
  } catch { return getAudioHardwareOffsetFallback(os, browser); }
}

// ============================================================================
// INTERFACES
// ============================================================================

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
// PART 2: THE SYNC ENGINE v7.0
//
// Changes from v6.3:
//   FIX 1 — NTP never permanently freezes: slow background re-ping every 60s
//   FIX 2 — Eval loop: 200ms → 50ms (4× finer drift detection)
//   FIX 3 — Rate-only zone: drift < 250ms → playback rate only, no hard seek
//   FIX 4 — DAC calibration: AudioContext measurement replaces hardcoded offsets
// ============================================================================

export const useSyncEngine = ({
  roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate,
  play, pause, getPlayerState, onVideoChange, onQueueUpdate,
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
  const currentVideoIdRef = useRef<string | null>(null);
  const epochRef = useRef<EpochState>({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, updateId: 0 });

  const isColdStartRef = useRef<boolean>(true);
  const playheadStartTimeRef = useRef<number>(0);
  const warmPenaltyPID = useRef(new PIDController(0.6, 0.05, 0.1, -0.200, 1.000));
  const currentWarmPenalty = useRef<number>(deviceInfo.current.os === 'iOS' ? 0.350 : 0.150);

  // FIX #4: DAC offset — starts as fallback, replaced by async measurement
  const dacOffsetRef = useRef<number>(getAudioHardwareOffsetFallback(deviceInfo.current.os, deviceInfo.current.browser));

  const ignoreSyncUntil = useRef<number>(0);
  const softGlideUntil = useRef<number>(0);
  const lastSeekTime = useRef<number>(0);
  const lastHostBroadcastTime = useRef<number>(0);
  const consecutiveMisses = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const catchupTimeout = useRef<NodeJS.Timeout | null>(null);

  const pingCountRef = useRef<number>(0);
  // FIX #1: Replace isNtpFrozenRef (permanently true) with phase tracking
  const isNtpFastPhaseRef = useRef<boolean>(true);
  const ntpSlowIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const cachedVideoIdRef = useRef<string | null>(null);

  // FIX #3: Track current rate to avoid redundant setPlaybackRate calls
  const currentRateRef = useRef<number>(1.0);

  const syncLogs = useRef<any[]>([]);
  const collectedLogsRef = useRef<Record<string, any[]>>({});

  const logEvent = useCallback((e: string, data: any = {}) => {
    const currentState = handlers.current.getPlayerState();
    syncLogs.current.push({
      t: new Date().toISOString(), r: isHost ? 'HOST' : 'JOINER', e,
      ctx: {
        state: currentState, locTime: handlers.current.getCurrentTime(),
        jitter: networkJitterRef.current, clockOffset: clockOffsetRef.current,
        dacOffset: dacOffsetRef.current, warmPenalty: currentWarmPenalty.current
      }, ...data
    });
    if (syncLogs.current.length > 15000) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    if (isHost && channelRef.current) {
      collectedLogsRef.current = { [`HOST_${deviceInfo.current.os}_${userId.slice(0, 5)}`]: syncLogs.current };
      channelRef.current.send({ type: 'broadcast', event: 'request_logs', payload: {} });
      setTimeout(() => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectedLogsRef.current, null, 2));
        const a = document.createElement('a'); a.href = dataStr;
        a.download = `sync_v7.0_${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      }, 3500);
    }
  }, [isHost, userId]);

  // FIX #4: Calibrate DAC offset once on join (joiners only)
  useEffect(() => {
    if (isHost) return;
    measureDACOffset(deviceInfo.current.os, deviceInfo.current.browser).then(offset => {
      dacOffsetRef.current = offset;
      logEvent('DAC_CALIBRATED', { measuredMs: Math.round(offset * 1000), fallbackMs: Math.round(getAudioHardwareOffsetFallback(deviceInfo.current.os, deviceInfo.current.browser) * 1000) });
    });
  }, [isHost, logEvent]);

  useEffect(() => {
    const handleUnload = () => {
      if (!isHost && channelRef.current) {
        logEvent('DEATH_RATTLE_UNLOAD');
        channelRef.current.send({ type: 'broadcast', event: 'submit_logs', payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } });
      }
    };
    if (typeof window !== 'undefined') { window.addEventListener('beforeunload', handleUnload); window.addEventListener('pagehide', handleUnload); }
    return () => { if (typeof window !== 'undefined') { window.removeEventListener('beforeunload', handleUnload); window.removeEventListener('pagehide', handleUnload); } };
  }, [isHost, userId, logEvent]);

  useEffect(() => {
    const acquireWakeLock = async () => {
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && !wakeLockRef.current) {
        try { wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); } catch (e) {}
      }
    };
    acquireWakeLock();
    const handleVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        acquireWakeLock();
        if (!isHost) { logEvent('APP_FOREGROUNDED', {}); ignoreSyncUntil.current = 0; channelRef.current?.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } }); }
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVis);
    return () => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVis); };
  }, [isHost, logEvent, userId]);

  // ============================================================================
  // CORRECTION PRIMITIVES
  // ============================================================================

  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs = 800) => {
    // FIX #2+3: Default lockout reduced 2500ms → 800ms.
    // Hard seek only fires for drift > 250ms now; shorter lockout is sufficient.
    logEvent('HARD_SEEK', { target: time, reason, lockoutMs });
    if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
    handlers.current.seekTo(time);
    if (epochRef.current.isPlaying) handlers.current.play(); else handlers.current.pause();
    currentRateRef.current = 1.0;
    ignoreSyncUntil.current = Date.now() + lockoutMs;
  }, [logEvent]);

  // FIX #3: Primary correction tool for drift < 250ms. Graduated rate, no seek.
  const applyRateCorrection = useCallback((drift: number, absDrift: number) => {
    let rate: number;
    if (absDrift < 0.050) { rate = drift > 0 ? 1.02 : 0.98; }
    else if (absDrift < 0.150) { rate = drift > 0 ? 1.05 : 0.95; }
    else { rate = drift > 0 ? 1.10 : 0.90; }

    if (Math.abs(rate - currentRateRef.current) > 0.001) {
      handlers.current.setPlaybackRate(rate);
      currentRateRef.current = rate;
      logEvent('RATE_CORRECTION', { rate, driftMs: Math.round(drift * 1000) });
    }
    ignoreSyncUntil.current = Date.now() + 80;
  }, [logEvent]);

  const restoreNormalRate = useCallback(() => {
    if (Math.abs(currentRateRef.current - 1.0) > 0.001) {
      handlers.current.setPlaybackRate(1.0);
      currentRateRef.current = 1.0;
      logEvent('RATE_RESTORED', {});
    }
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number) => {
    const rate = 0.92;
    const holdTimeMs = Math.min((driftSeconds / (1.0 - rate)) * 1000, 1200);
    logEvent('SOFT_GLIDE', { driftSeconds, holdTimeMs });
    handlers.current.setPlaybackRate(rate); currentRateRef.current = rate;
    softGlideUntil.current = Date.now() + holdTimeMs;
    ignoreSyncUntil.current = Date.now() + holdTimeMs + 150;
    setTimeout(() => { handlers.current.setPlaybackRate(1.0); currentRateRef.current = 1.0; }, holdTimeMs);
  }, [logEvent]);

  const measureLatency = useCallback(() => {
    if (!channelRef.current) return;
    channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
  }, [userId]);

  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    channelRef.current.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } });
  }, [isHost, userId]);

  // FIX #1: NTP burst helper — used for initial fast phase and slow refresh
  const runNTPBurst = useCallback((count: number, intervalMs: number, onComplete?: () => void) => {
    let sent = 0;
    const id = setInterval(() => {
      if (sent >= count) { clearInterval(id); onComplete?.(); return; }
      measureLatency(); sent++;
    }, intervalMs);
  }, [measureLatency]);

  // ============================================================================
  // LAYER 1: SUPABASE REALTIME CHANNEL
  // ============================================================================
  useEffect(() => {
    logEvent('INIT_NTP_BUS', { roomId, version: ENGINE_VERSION });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } } });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setConnectedDevices(Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping,
        os: p.os || '?', browser: p.browser || '?',
        syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0,
        jitter: p.jitter || 0, cachedVideoId: p.cachedVideoId
      })));
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.sId !== userId) {
        channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId && isNtpFastPhaseRef.current) {
        pingCountRef.current += 1;
        const rtt = kalmanRtt.current.filter(Date.now() - payload.t);
        const offset = payload.ht - payload.t - (rtt / 2); // pure NTP math
        ntpAnalyzer.current.addSample(rtt, offset);
        const metrics = ntpAnalyzer.current.getMetrics();
        clockOffsetRef.current = metrics.offset;
        networkJitterRef.current = metrics.jitter;
        setLatency(Math.round(metrics.rtt));
        setNetworkJitter(Math.round(metrics.jitter));

        // FIX #1: After 45 fast pings, switch to slow background refresh (never freeze)
        if (pingCountRef.current === 45 && isNtpFastPhaseRef.current) {
          isNtpFastPhaseRef.current = false;
          logEvent('NTP_FAST_PHASE_COMPLETE', { finalOffset: metrics.offset, finalRtt: metrics.rtt, finalJitter: metrics.jitter });

          // Schedule slow re-calibration every 60 seconds
          ntpSlowIntervalRef.current = setInterval(() => {
            logEvent('NTP_SLOW_REFRESH_START', { prevOffset: clockOffsetRef.current });
            ntpAnalyzer.current.reset();
            kalmanRtt.current.reset(clockOffsetRef.current);
            pingCountRef.current = 0;
            isNtpFastPhaseRef.current = true;
            runNTPBurst(5, 300, () => {
              isNtpFastPhaseRef.current = false;
              logEvent('NTP_SLOW_REFRESH_DONE', { newOffset: clockOffsetRef.current, delta: clockOffsetRef.current - metrics.offset });
            });
          }, 60_000);
        }

        if (Math.random() < 0.15 && isNtpFastPhaseRef.current) {
          channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: 'synced', latency: Math.round(metrics.rtt), jitter: Math.round(metrics.jitter), cachedVideoId: cachedVideoIdRef.current });
        }
      }
    });

    channel.on('broadcast', { event: 'request_logs' }, () => {
      if (isHost) return;
      channel.send({ type: 'broadcast', event: 'submit_logs', payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } });
    });

    channel.on('broadcast', { event: 'submit_logs' }, ({ payload }) => {
      if (!isHost) return;
      collectedLogsRef.current[`JOINER_${payload.os}_${payload.uId.slice(0, 5)}`] = payload.logs;
    });

    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;
      if (payload.updateId < epochRef.current.updateId) return;
      const wasPlaying = epochRef.current.isPlaying;
      epochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        currentVideoIdRef.current = payload.videoId; isColdStartRef.current = true;
        handlers.current.onVideoChange?.(payload.videoId, "", "");
        executeHardSeek(0, 'Video Changed', 800); return;
      }

      if (payload.isPlaying && !wasPlaying) {
        if (Date.now() < ignoreSyncUntil.current) return;
        const expectedTime = payload.startVideoTime + ((Date.now() + clockOffsetRef.current - payload.startNetworkTime) / 1000) - dacOffsetRef.current;
        playheadStartTimeRef.current = Date.now();
        if (isColdStartRef.current) {
          const coldPenalty = (deviceInfo.current.os === 'iOS' || deviceInfo.current.os === 'iPadOS') ? 1.800 : 1.200;
          executeHardSeek(expectedTime + coldPenalty, `Cold Start Resume: +${coldPenalty}s`, 1200);
          isColdStartRef.current = false;
        } else {
          executeHardSeek(expectedTime + currentWarmPenalty.current, `Warm Resume: +${currentWarmPenalty.current.toFixed(3)}s`, 800);
        }
      }

      if (!payload.isPlaying) {
        if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
        restoreNormalRate(); handlers.current.pause();
        if (Math.abs(handlers.current.getCurrentTime() - payload.startVideoTime) > 0.020) handlers.current.seekTo(payload.startVideoTime);
      }
    });

    channel.on('broadcast', { event: 'sync_req' }, () => {
      if (isHost) channel.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, jitter: 0, cachedVideoId: cachedVideoIdRef.current });
        if (!isHost) {
          // Initial fast NTP burst: 45 pings × 150ms ≈ 7 seconds
          runNTPBurst(45, 150, () => {
            channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } });
          });
        }
      }
    });

    channelRef.current = channel;
    return () => {
      if (catchupTimeout.current) clearTimeout(catchupTimeout.current);
      if (ntpSlowIntervalRef.current) clearInterval(ntpSlowIntervalRef.current);
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost, logEvent, executeHardSeek, restoreNormalRate, runNTPBurst]);

  // ============================================================================
  // LAYER 2: AUTONOMOUS JOINER EVAL LOOP
  // FIX #2: 200ms → 50ms interval
  // FIX #3: drift < 250ms → rate correction only, no hard seek
  // ============================================================================
  useEffect(() => {
    if (isHost) return;

    const interval = setInterval(() => {
      const epoch = epochRef.current;
      if (!epoch.videoId) return;
      const playerState = handlers.current.getPlayerState();
      if (playerState === 3 || playerState === -1) return;

      if (!epoch.isPlaying) {
        wasPlayingRef.current = false;
        if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
        if (playerState === 1) { handlers.current.pause(); restoreNormalRate(); }
        const localTime = handlers.current.getCurrentTime();
        const drift = Math.abs(localTime - epoch.startVideoTime);
        setLastSyncDelta(Math.round(drift * 1000)); lastSyncDeltaRef.current = Math.round(drift * 1000);
        if (drift > 0.020) handlers.current.seekTo(epoch.startVideoTime);
        setSyncStatus('synced'); return;
      }

      if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current) return;

      const networkTime = Date.now() + clockOffsetRef.current;
      const expectedTime = epoch.startVideoTime + ((networkTime - epoch.startNetworkTime) / 1000) - dacOffsetRef.current;
      const localTime = handlers.current.getCurrentTime();
      const drift = expectedTime - localTime;
      const absDrift = Math.abs(drift);

      setLastSyncDelta(Math.round(absDrift * 1000)); lastSyncDeltaRef.current = Math.round(absDrift * 1000);

      // Dynamic tolerance: 12ms floor, scales with jitter
      const tolerance = Math.max(0.012, Math.min(0.060, (networkJitterRef.current / 1000) * 1.2));

      const justResumed = !wasPlayingRef.current;
      wasPlayingRef.current = true;

      if (justResumed && absDrift > tolerance) {
        const penalty = isColdStartRef.current ? (deviceInfo.current.os === 'iOS' ? 1.8 : 1.2) : currentWarmPenalty.current;
        executeHardSeek(expectedTime + penalty, `Resume Strike. Pen: ${penalty.toFixed(3)}s`, 1000);
        if (isColdStartRef.current) isColdStartRef.current = false;
        return;
      }

      if (absDrift <= tolerance) {
        consecutiveMisses.current = 0; warmPenaltyPID.current.reset();
        restoreNormalRate(); setSyncStatus('synced');
        if (handlers.current.getPlayerState() !== 1) handlers.current.play();
        return;
      }

      consecutiveMisses.current += 1;
      if (consecutiveMisses.current < 2) return;

      setSyncStatus('syncing');

      // ======================================================================
      // FIX #3: TIERED CORRECTION
      // Zone A (< 250ms): rate correction only — smooth, no rebuffer
      // Zone B (> 250ms): hard seek — coarse reset only when truly needed
      // ======================================================================

      if (absDrift <= 0.250) {
        // ZONE A: rate-only correction
        if (drift > 0) {
          // Behind — speed up
          applyRateCorrection(drift, absDrift);
        } else {
          // Ahead — soft glide or rate-down
          if (absDrift <= 0.060) { executeSoftGlide(absDrift); }
          else { applyRateCorrection(drift, absDrift); }
        }
        // Slow-learn warm penalty from rate correction outcomes
        const dt = (Date.now() - lastSeekTime.current) / 1000;
        if (dt > 0 && dt < 15 && !isColdStartRef.current) {
          if (drift > 0) { currentWarmPenalty.current = Math.min(1.2, currentWarmPenalty.current + 0.005); }
          else { currentWarmPenalty.current = Math.max(0.100, currentWarmPenalty.current - 0.005); }
        }
      } else {
        // ZONE B: large drift — hard seek
        if (drift > 0) {
          const dt = (Date.now() - lastSeekTime.current) / 1000;
          if (dt > 0 && dt < 15 && !isColdStartRef.current) {
            const isAggressive = (Date.now() - playheadStartTimeRef.current < 10000) && (absDrift > 0.020);
            currentWarmPenalty.current += warmPenaltyPID.current.calculate(absDrift, dt, isAggressive);
            currentWarmPenalty.current = Math.min(1.2, currentWarmPenalty.current);
          }
          const penalty = isColdStartRef.current ? 1.5 : currentWarmPenalty.current;
          executeHardSeek(expectedTime + penalty, `Macro-Behind: ${absDrift.toFixed(3)}s`, 800);
          lastSeekTime.current = Date.now(); isColdStartRef.current = false;
        } else {
          if (Date.now() - lastSeekTime.current < 5000 && !isColdStartRef.current) {
            currentWarmPenalty.current = Math.max(0.100, currentWarmPenalty.current - (absDrift * 0.4));
          }
          lastSeekTime.current = 0;
          const cappedPauseMs = Math.min(Math.round(absDrift * 1000) - 5, 120);
          if (cappedPauseMs > 10) {
            logEvent('MICRO_PAUSE_CAPPED', { cappedPauseMs });
            if (catchupTimeout.current) clearTimeout(catchupTimeout.current);
            handlers.current.pause(); restoreNormalRate();
            ignoreSyncUntil.current = Date.now() + cappedPauseMs + 300;
            catchupTimeout.current = setTimeout(() => { handlers.current.play(); catchupTimeout.current = null; }, cappedPauseMs);
          }
        }
      }

    }, 50); // FIX #2: 200ms → 50ms

    return () => clearInterval(interval);
  }, [isHost, logEvent, executeHardSeek, executeSoftGlide, applyRateCorrection, restoreNormalRate]);

  // ============================================================================
  // LAYER 3: HOST BROADCAST POLLER (100ms — unchanged)
  // ============================================================================
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const currentTime = handlers.current.getCurrentTime();
      const isPlaying = handlers.current.getPlayerState() === 1;
      const networkTime = Date.now(); let stateChanged = false;
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
    ntpAnalyzer.current.reset(); kalmanRtt.current.reset();
    isNtpFastPhaseRef.current = true; pingCountRef.current = 0;
    requestSync(); runNTPBurst(5, 100);
  }, [isHost, requestSync, runNTPBurst]);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter,
    broadcastPlay, broadcastPause, broadcastVideoChange,
    broadcastQueueUpdate: () => {},
    forceResync, manualResync: manualResyncFunc, measureLatency, downloadLogs,
    engineVersion: ENGINE_VERSION, deviceInfo: deviceInfo.current,
    setCurrentVideoId: (id: string) => { currentVideoIdRef.current = id; },
    reportPreloadReady: (vid: string) => {
      cachedVideoIdRef.current = vid;
      if (!isHost) channelRef.current?.track({ id: userId, isHost: false, cachedVideoId: vid });
    }
  };
};
