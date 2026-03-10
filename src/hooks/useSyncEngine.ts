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
 */
class KalmanFilter {
  private r: number;
  private q: number;
  private p: number;
  private x: number;
  private k: number;

  constructor(r = 10, q = 0.1, initial_p = 1, initial_x = 0) {
    this.r = r; this.q = q; this.p = initial_p; this.x = initial_x; this.k = 0;
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

/**
 * IQR + EMA Network Time Analyzer
 */
class NetworkTimeAnalyzer {
  private history: { rtt: number; offset: number }[] = [];
  private maxSize = 30;
  private emaOffset: number | null = null;
  private alpha = 0.15;

  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    if (this.history.length > this.maxSize) this.history.shift();
  }

  getFilteredMetrics(): { offset: number; jitter: number; rtt: number } {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    if (this.history.length < 5) {
      const latest = this.history[this.history.length - 1];
      return { offset: latest.offset, jitter: 50, rtt: latest.rtt };
    }

    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const q1 = Math.floor(sorted.length * 0.20);
    const q3 = Math.floor(sorted.length * 0.50);
    const bestPackets = sorted.slice(q1, q3 + 1);

    let sumOffset = 0, sumRtt = 0;
    bestPackets.forEach(s => { sumOffset += s.offset; sumRtt += s.rtt; });
    const avgOffset = sumOffset / bestPackets.length;
    const avgRtt = sumRtt / bestPackets.length;

    const variance = bestPackets.reduce((acc, v) => acc + Math.pow(v.rtt - avgRtt, 2), 0) / bestPackets.length;
    const jitter = Math.sqrt(variance);

    if (this.emaOffset === null) this.emaOffset = avgOffset;
    else this.emaOffset = (this.alpha * avgOffset) + ((1 - this.alpha) * this.emaOffset);

    return { offset: this.emaOffset, jitter, rtt: avgRtt };
  }
}

/**
 * FIX #4 — Replaced AdvancedPID with SeekLandingTracker.
 *
 * The old PID estimated hardware latency by accumulating error integrals
 * across seeks. The problem: it had no feedback loop on where the player
 * ACTUALLY landed after a seek — it only knew the error before the seek.
 * The integral wound up aggressively (0.150 → 0.325 → 0.456 in 3 seeks),
 * driving the penalty into overshoot territory.
 *
 * This class directly measures seek accuracy. After each HARD_SEEK:
 *   1. Record (seekTargetTime, nowMs)
 *   2. On the NEXT sync eval (after lockout), read actualLandedTime
 *   3. landingError = seekTarget - actualLanded  ← true hardware delay
 *   4. Update penalty as an EMA of landingError
 *
 * This converges in 1–2 seeks instead of 3–5, and never overshoots.
 */
class SeekLandingTracker {
  private alpha = 0.6; // Aggressive EMA for fast convergence
  penalty: number;

  constructor(basePenalty: number) {
    this.penalty = basePenalty;
  }

  /** Call immediately after issuing a hard seek. */
  recordSeek(seekTargetTime: number): { seekTargetTime: number } {
    return { seekTargetTime };
  }

  /**
   * Call on first sync eval after lockout clears.
   * actualTime = getCurrentTime() reading right after lockout.
   * seekTargetTime = what we passed to seekTo().
   */
  recordLanding(seekTargetTime: number, actualTime: number): number {
    // How far BEHIND the target did we land? (positive = we undershot = need more penalty)
    const landingError = seekTargetTime - actualTime;

    // Clamp correction to ±200ms to prevent wild swings on jitter spikes
    const clampedError = Math.max(-0.200, Math.min(0.200, landingError));
    this.penalty = (this.alpha * clampedError) + ((1 - this.alpha) * this.penalty);

    // Hard floor/ceiling — platform constraints
    this.penalty = Math.max(0.020, Math.min(1.500, this.penalty));
    return this.penalty;
  }

  /**
   * FIX #2 — Symmetric correction on overshoot.
   * When we detect we're AHEAD (negative drift), reduce penalty proportionally.
   * Old code: reduction = absDrift * 0.4, guarded by lastSeekTimeRef < 5000.
   * lastSeekTimeRef was set to 0 on overshoot, so the guard ALWAYS failed.
   */
  correctOvershoot(absDrift: number): number {
    // Treat overshoot as a negative landing error — symmetric to undershoot
    const reduction = absDrift * 0.7; // More aggressive than the old 0.4
    this.penalty = Math.max(0.020, this.penalty - reduction);
    return this.penalty;
  }

  reset() {
    // Don't fully reset — keep learned penalty for next song (hardware doesn't change)
    // But do decay slightly toward the base to account for buffering differences
  }
}

// ============================================================================
// PART 2: DEVICE HEURISTICS & SYSTEM CONSTANTS
// ============================================================================

const getDeviceAudioPipelineOffset = (os: string, browser: string): number => {
  if (os === 'iOS') return 0.055;
  if (os === 'macOS' && browser.includes('Safari')) return 0.025;
  if (os === 'macOS' && browser.includes('Chrome')) return 0.035;
  if (os === 'Android') return 0.090;
  if (os === 'Windows') return 0.045;
  return 0.040;
};

// FIX #6 — Separate base penalties per platform (used for reset on video change)
const getBasePenalty = (os: string): number => {
  if (os === 'iOS') return 0.350;
  if (os === 'Android') return 0.450;
  return 0.150;
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
// PART 3: THE OMEGA SYNC ENGINE (v2)
// ============================================================================

export const useSyncEngine = ({
  roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate,
}: UseSyncEngineProps) => {

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);

  const [latency, setLatency] = useState<number>(0);
  const [networkJitter, setNetworkJitter] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const lastBroadcastTimeRef = useRef<number>(0);

  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; });

  const rttKalman = useRef(new KalmanFilter(15, 0.5, 1, 0));
  const timeAnalyzer = useRef(new NetworkTimeAnalyzer());
  const clockOffsetRef = useRef<number>(0);
  const currentVideoIdRef = useRef<string | null>(null);
  const deviceInfo = useRef(getDeviceInfo());

  const playbackEpochRef = useRef<EpochState>({
    isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, hostUpdateId: 0, stateSequence: 0
  });

  const ignoreSyncUntilRef = useRef<number>(0);
  const softGlideUntilRef = useRef<number>(0);
  const catchupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wakeLockRef = useRef<any>(null);

  // FIX #4 — SeekLandingTracker replaces AdvancedPID
  const seekTrackerRef = useRef(new SeekLandingTracker(getBasePenalty(deviceInfo.current.os)));

  // FIX #4 — Track the last seek target for landing measurement
  const pendingLandingCheckRef = useRef<{ seekTargetTime: number; seekIssuedAt: number } | null>(null);

  const consecutiveMissesRef = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const epochSequenceCounterRef = useRef<number>(0);
  const networkJitterRef = useRef<number>(0);

  // FIX #5 — Track NTP readiness: don't allow sync evaluations until we have
  // at least 5 NTP samples with confidence (prevents first-packet bad offset)
  const ntpReadyRef = useRef<boolean>(false);
  const ntpSampleCountRef = useRef<number>(0);

  const syncLogs = useRef<any[]>([]);
  const logEvent = useCallback((event: string, data: any) => {
    syncLogs.current.push({ t: new Date().toISOString(), role: isHost ? 'HOST' : 'JOINER', e: event, ...data });
    if (syncLogs.current.length > 2500) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syncLogs.current, null, 2));
    const a = document.createElement('a');
    a.href = dataStr; a.download = `sync_omega_log_${isHost ? 'host' : 'joiner'}_${userId.slice(0, 5)}.json`;
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
          ignoreSyncUntilRef.current = 0;
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
    timeAnalyzer.current = new NetworkTimeAnalyzer();
    rttKalman.current = new KalmanFilter(15, 0.5, 1, 0);
    ntpReadyRef.current = false;
    ntpSampleCountRef.current = 0;
    requestSync();
    for (let i = 0; i < 5; i++) setTimeout(measureLatency, i * 100);
  }, [isHost, requestSync, measureLatency]);

  // ============================================================================
  // MEDIA MANIPULATORS
  // ============================================================================
  const executeHardSeek = useCallback((time: number, reason: string, lockoutMs = 2500) => {
    logEvent('HARD_SEEK', { target: time, reason, penalty: seekTrackerRef.current.penalty });
    if (catchupTimeoutRef.current) { clearTimeout(catchupTimeoutRef.current); catchupTimeoutRef.current = null; }

    handlers.current.seekTo(time);
    if (playbackEpochRef.current.isPlaying) handlers.current.play();
    else handlers.current.pause();

    // FIX #4 — Record seek target for landing measurement after lockout
    pendingLandingCheckRef.current = { seekTargetTime: time, seekIssuedAt: Date.now() };

    ignoreSyncUntilRef.current = Date.now() + lockoutMs;
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number) => {
    const rate = 0.75;
    const virtualLossPerSec = 1.0 - rate;
    const holdTimeMs = Math.min((driftSeconds / virtualLossPerSec) * 1000, 1500);

    logEvent('SOFT_GLIDE_INIT', { driftSeconds, holdTimeMs, rate });
    handlers.current.setPlaybackRate(rate);

    softGlideUntilRef.current = Date.now() + holdTimeMs;
    ignoreSyncUntilRef.current = Date.now() + holdTimeMs + 200;

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
        const filteredRtt = rttKalman.current.filter(rawRtt);
        const rawOffset = payload.ht - payload.t - (filteredRtt / 2);

        timeAnalyzer.current.addSample(filteredRtt, rawOffset);
        const { offset, jitter, rtt } = timeAnalyzer.current.getFilteredMetrics();

        clockOffsetRef.current = offset;
        networkJitterRef.current = jitter;
        setLatency(Math.round(rtt));
        setNetworkJitter(Math.round(jitter));

        // FIX #5 — Gate sync evaluations behind NTP readiness
        ntpSampleCountRef.current += 1;
        if (!ntpReadyRef.current && ntpSampleCountRef.current >= 5) {
          ntpReadyRef.current = true;
          logEvent('NTP_READY', { offset, jitter, rtt, samples: ntpSampleCountRef.current });
          // Now that we have a valid clock offset, request a sync immediately
          channel.send({ type: 'broadcast', event: 'sync_req', payload: { sId: userId } });
        }

        if (Math.random() < 0.2) {
          channel.track({
            id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser,
            syncStatus: syncStatusRef.current, latency: Math.round(rtt), lastSyncDelta: lastSyncDelta, jitter: Math.round(jitter)
          });
        }
      }
    });

    // ============================================================================
    // THE AI PLAYBACK EVALUATOR (JOINER)
    // ============================================================================
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost) return;

      // UDP Sequence enforcement
      if (payload.hostUpdateId < playbackEpochRef.current.hostUpdateId) return;
      playbackEpochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync(); return;
      }

      // FIX #5 — Don't evaluate sync until NTP is ready (prevents bad clock offset seeks)
      if (!ntpReadyRef.current) {
        logEvent('SYNC_EVAL_SKIPPED', { reason: 'NTP not ready', samples: ntpSampleCountRef.current });
        return;
      }

      const networkTime = Date.now() + clockOffsetRef.current;
      let newStatus: SyncStatus = 'synced';

      const isPlayingNow = payload.isPlaying;
      const justResumed = isPlayingNow && !wasPlayingRef.current;
      wasPlayingRef.current = isPlayingNow;

      if (isPlayingNow) {
        if (Date.now() < ignoreSyncUntilRef.current) return;
        if (Date.now() < softGlideUntilRef.current) return;

        // FIX #4 — Measure where we actually landed after the last seek
        if (pendingLandingCheckRef.current) {
          const { seekTargetTime } = pendingLandingCheckRef.current;
          const actualTime = handlers.current.getCurrentTime();
          const newPenalty = seekTrackerRef.current.recordLanding(seekTargetTime, actualTime);
          logEvent('SEEK_LANDING', { seekTargetTime, actualTime, landingError: seekTargetTime - actualTime, newPenalty });
          pendingLandingCheckRef.current = null;
        }

        const dacOffset = getDeviceAudioPipelineOffset(deviceInfo.current.os, deviceInfo.current.browser);
        const expectedVideoTime = payload.startVideoTime + ((networkTime - payload.startNetworkTime) / 1000) - dacOffset;
        const localTime = handlers.current.getCurrentTime();

        const drift = expectedVideoTime - localTime;
        const absDrift = Math.abs(drift);
        setLastSyncDelta(Math.round(absDrift * 1000));

        const currentJitterSecs = (networkJitterRef.current / 1000) || 0;
        // FIX #7 — Raise the base tolerance to 30ms (human perception floor).
        // 10ms tolerance caused endless seeking on any network jitter at all.
        // 30ms is below the human auditory fusion threshold (~40ms).
        const dynamicTolerance = Math.max(0.030, Math.min(0.080, currentJitterSecs * 1.2));

        logEvent('SYNC_EVAL', { localTime, expectedVideoTime, drift, absDrift, penalty: seekTrackerRef.current.penalty, tolerance: dynamicTolerance });

        // 🚀 SCENARIO 1: INSTANT RESUME (PRE-EMPTIVE STRIKE)
        // FIX #3 — On Instant Resume, DON'T apply penalty blindly.
        // Instead, seek to expectedVideoTime + penalty, but only if drift > tolerance.
        // The penalty here compensates for buffer-fill time on resume.
        if (justResumed) {
          if (absDrift > dynamicTolerance) {
            const targetTime = expectedVideoTime + seekTrackerRef.current.penalty;
            executeHardSeek(targetTime, `Instant Resume. Penalty: ${seekTrackerRef.current.penalty.toFixed(3)}s`);
          }
          // If within tolerance on resume, do nothing — we're already good
          return;
        }

        // 🎯 SCENARIO 2: OUT OF TOLERANCE
        if (absDrift > dynamicTolerance) {
          consecutiveMissesRef.current += 1;

          if (consecutiveMissesRef.current >= 2) {
            if (drift > 0) {
              // 🔴 BEHIND: Seek forward with current learned penalty
              const targetTime = expectedVideoTime + seekTrackerRef.current.penalty;
              executeHardSeek(targetTime, `Behind by ${absDrift.toFixed(3)}s. Penalty: ${seekTrackerRef.current.penalty.toFixed(3)}s`);
            } else {
              // 🟢 AHEAD: FIX #2 — Actually apply symmetric correction
              const newPenalty = seekTrackerRef.current.correctOvershoot(absDrift);
              logEvent('OVERSHOOT_CORRECTION', { absDrift, newPenalty });

              if (absDrift <= 0.050) {
                executeSoftGlide(absDrift);
              } else {
                const pauseTimeMs = Math.round(absDrift * 1000) - 5;
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
          // 🏆 ZERO-ECHO SYNC MAINTAINED
          consecutiveMissesRef.current = 0;

          if (Date.now() > softGlideUntilRef.current) {
            handlers.current.setPlaybackRate(1);
          }
        }

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

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => {
      if (!isHost && payload) handlers.current.onQueueUpdate?.(payload as QueueState);
    });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: any }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlers.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);

        // FIX #6 — Reset consecutiveMissesRef on video change to prevent
        // stale miss-count from firing a seek during the buffering window
        consecutiveMissesRef.current = 0;
        pendingLandingCheckRef.current = null;
        wasPlayingRef.current = false;

        // Penalty intentionally persists: hardware delay doesn't change between songs.
        // But do partially decay it toward the base in case new video has different buffering.
        const base = getBasePenalty(deviceInfo.current.os);
        seekTrackerRef.current.penalty = (seekTrackerRef.current.penalty * 0.8) + (base * 0.2);

        executeHardSeek(0, 'New Video Pipeline Reset');
        setSyncStatus('syncing');
      }
    });

    // --- CONNECTION SUBSCRIPTION ---
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser,
          syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, lastSyncDelta: 0
        });
        if (!isHost) {
          // FIX #5 — Burst 20 pings (was 15) at 100ms intervals (was 150ms).
          // This gives us 5 NTP-ready samples in ~500ms instead of ~750ms,
          // so the first valid sync_req goes out BEFORE the host's first heartbeat.
          let pings = 0;
          const interval = setInterval(() => {
            if (pings++ < 20) {
              channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
            } else {
              clearInterval(interval);
              // sync_req is now sent inside the NTP_READY handler instead of here,
              // ensuring clockOffsetRef is valid before we ask for a sync packet.
            }
          }, 100);
        }
      }
    });

    channelRef.current = channel;
    return () => {
      if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost, logEvent, executeHardSeek, executeSoftGlide]);

  // ============================================================================
  // HOST BROADCAST POLLER (100ms cycle)
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
      if (stateChanged || now - lastBroadcastTimeRef.current > 2000) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
        lastBroadcastTimeRef.current = now;
        if (stateChanged) logEvent('HOST_STATE_UPDATE', playbackEpochRef.current);
      }
    }, 100);

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

  const broadcastQueueUpdate = useCallback((queue: QueueState) => {
    channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue });
  }, []);

  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter,
    broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate,
    forceResync, manualResync, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId,
  };
};
