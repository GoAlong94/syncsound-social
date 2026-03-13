import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

export const ENGINE_VERSION = "v3.0-Omega-Convoy";

// ============================================================================
// PART 1: MATH & FILTERS
// ============================================================================
class KalmanFilter {
  private r: number; private q: number; private p: number; private x: number; private k: number;
  constructor(r = 10, q = 0.1, p = 1, x = 0) { this.r = r; this.q = q; this.p = p; this.x = x; this.k = 0; }
  filter(measurement: number) {
    if (this.x === 0) { this.x = measurement; return measurement; }
    this.p += this.q; this.k = this.p / (this.p + this.r); this.x += this.k * (measurement - this.x); this.p = (1 - this.k) * this.p;
    return this.x;
  }
}

class NTPAnalyzer {
  private history: { rtt: number, offset: number }[] = [];
  private emaOffset: number | null = null;
  addSample(rtt: number, offset: number) {
    this.history.push({ rtt, offset });
    if (this.history.length > 30) this.history.shift();
  }
  getMetrics() {
    if (this.history.length === 0) return { offset: 0, jitter: 0, rtt: 0 };
    const sorted = [...this.history].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.5) || 1);
    let sumO = 0, sumR = 0; best.forEach(s => { sumO += s.offset; sumR += s.rtt; });
    const avgO = sumO / best.length, avgR = sumR / best.length;
    const variance = best.reduce((acc, val) => acc + Math.pow(val.rtt - avgR, 2), 0) / best.length;
    this.emaOffset = this.emaOffset === null ? avgO : (0.15 * avgO) + (0.85 * this.emaOffset);
    return { offset: this.emaOffset, jitter: Math.sqrt(variance), rtt: avgR };
  }
}

const getAudioHardwareOffset = (os: string, browser: string) => {
  if (os === 'iOS') return 0.055; if (os === 'macOS') return 0.035; if (os === 'Android') return 0.090; return 0.045; 
};

interface UseSyncEngineProps {
  roomId: string; isHost: boolean; userId: string;
  getCurrentTime: () => number; seekTo: (time: number) => void;
  setPlaybackRate: (rate: number) => void; play: () => void; pause: () => void; getPlayerState: () => number;
  onVideoChange?: (videoId: string, title: string, thumbnail: string) => void;
}

// ============================================================================
// PART 2: V3 ENGINE
// ============================================================================
export const useSyncEngine = ({ roomId, isHost, userId, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange }: UseSyncEngineProps) => {

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  
  const [latency, setLatency] = useState(0);
  const [networkJitter, setNetworkJitter] = useState(0);
  const [lastSyncDelta, setLastSyncDelta] = useState(0);
  const lastSyncDeltaRef = useRef(0); 
  
  const handlers = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange });
  useEffect(() => { handlers.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange }; });
  
  const deviceInfo = useRef(getDeviceInfo());
  const epochRef = useRef({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null as string | null, updateId: 0 });
  const currentVideoIdRef = useRef<string | null>(null);

  // NTP Freeze Logic
  const ntpAnalyzer = useRef(new NTPAnalyzer());
  const kalmanRtt = useRef(new KalmanFilter());
  const clockOffsetRef = useRef(0); 
  const networkJitterRef = useRef(0);
  const pingCountRef = useRef(0);
  const isNtpFrozenRef = useRef(false);

  // Execution Locks
  const ignoreSyncUntil = useRef(0);
  const softGlideUntil = useRef(0);
  const lastHostBroadcastTime = useRef(0);
  const consecutiveMisses = useRef(0);
  const wasPlayingRef = useRef(false);
  
  // Convoy Protocol
  const cachedVideoIdRef = useRef<string | null>(null);

  // Telemetry
  const syncLogs = useRef<any[]>([]);
  const collectedLogsRef = useRef<Record<string, any[]>>({});
  const logEvent = useCallback((e: string, data: any = {}) => {
    syncLogs.current.push({ t: new Date().toISOString(), r: isHost ? 'HOST' : 'JOINER', e, ctx: { st: handlers.current.getPlayerState(), loc: handlers.current.getCurrentTime(), jit: networkJitterRef.current }, ...data });
    if (syncLogs.current.length > 2500) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    if (isHost && channelRef.current) {
      collectedLogsRef.current = { [`HOST_${deviceInfo.current.os}_${userId.slice(0,5)}`]: syncLogs.current };
      logEvent('BROADCAST_LOG_REQUEST');
      channelRef.current.send({ type: 'broadcast', event: 'request_logs', payload: {} });
      setTimeout(() => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectedLogsRef.current, null, 2));
        const a = document.createElement('a'); a.href = dataStr; a.download = `sync_v3_ALL_${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      }, 2500);
    }
  }, [isHost, userId, logEvent]);

  // Network Boot
  useEffect(() => {
    logEvent('BOOT_ENGINE_V3', { ver: ENGINE_VERSION, roomId });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } }});

    channel.on('presence', { event: 'sync' }, () => {
      setConnectedDevices(Object.values(channel.presenceState()).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, os: p.os || '?', browser: p.browser || '?', syncStatus: p.syncStatus, latency: p.latency, jitter: p.jitter, cachedVideoId: p.cachedVideoId
      })));
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.sId !== userId) channel.send({ type: 'broadcast', event: 'pong', payload: { t: payload.t, ht: Date.now(), target: payload.sId } });
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.target === userId && !isNtpFrozenRef.current) {
        pingCountRef.current += 1;
        const rtt = kalmanRtt.current.filter(Date.now() - payload.t); 
        const offset = payload.ht - payload.t - (rtt / 2);
        ntpAnalyzer.current.addSample(rtt, offset);
        const metrics = ntpAnalyzer.current.getMetrics();
        
        clockOffsetRef.current = metrics.offset;
        networkJitterRef.current = metrics.jitter;
        setLatency(Math.round(metrics.rtt)); setNetworkJitter(Math.round(metrics.jitter));
        
        // PHASE 4: NTP JITTER FREEZE
        if (pingCountRef.current > 45) {
            isNtpFrozenRef.current = true;
            logEvent('NTP_FROZEN_LOCKED', { finalOffset: metrics.offset, finalJitter: metrics.jitter });
        }

        if (Math.random() < 0.2) channel.track({ id: userId, isHost, os: deviceInfo.current.os, syncStatus: 'synced', latency: Math.round(metrics.rtt), jitter: Math.round(metrics.jitter), cachedVideoId: cachedVideoIdRef.current });
      }
    });

    channel.on('broadcast', { event: 'request_logs' }, () => {
      if (!isHost) channel.send({ type: 'broadcast', event: 'submit_logs', payload: { uId: userId, os: deviceInfo.current.os, logs: syncLogs.current } });
    });
    channel.on('broadcast', { event: 'submit_logs' }, ({ payload }) => {
      if (isHost) collectedLogsRef.current[`JOINER_${payload.os}_${payload.uId.slice(0,5)}`] = payload.logs;
    });

    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: EpochState }) => {
      if (isHost || payload.updateId < epochRef.current.updateId) return; 
      const wasPlaying = epochRef.current.isPlaying;
      epochRef.current = payload;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        currentVideoIdRef.current = payload.videoId;
        handlers.current.onVideoChange?.(payload.videoId, "", "");
        logEvent('CMD_NEW_VIDEO', { vId: payload.videoId });
        handlers.current.seekTo(0);
        ignoreSyncUntil.current = Date.now() + 2500;
        return;
      }
      if (payload.isPlaying && !wasPlaying) {
         if (Date.now() < ignoreSyncUntil.current) return;
         handlers.current.play();
      }
      if (!payload.isPlaying) {
         handlers.current.pause();
         if (Math.abs(handlers.current.getCurrentTime() - payload.startVideoTime) > 0.05) handlers.current.seekTo(payload.startVideoTime);
      }
    });

    channel.on('broadcast', { event: 'sync_req' }, () => { if (isHost) channel.send({ type: 'broadcast', event: 'sync', payload: epochRef.current }); });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && !isHost) {
        const int = setInterval(() => {
           if (pingCountRef.current < 45) channel.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now(), sId: userId } });
           else clearInterval(int);
        }, 150);
      }
    });

    channelRef.current = channel;
    return () => channel.unsubscribe();
  }, [roomId, userId, isHost, logEvent]);

  // PHASE 2 & 4: JOINER LOOP WITH COAST MODE
  useEffect(() => {
    if (isHost) return;
    const interval = setInterval(() => {
      const epoch = epochRef.current;
      if (!epoch.videoId) return;
      
      const st = handlers.current.getPlayerState();
      if (st === 3 || st === -1) {
          setSyncStatus('syncing'); ignoreSyncUntil.current = Date.now() + 1000; return; 
      }
      if (!epoch.isPlaying) {
          wasPlayingRef.current = false;
          const drift = Math.abs(handlers.current.getCurrentTime() - epoch.startVideoTime);
          setLastSyncDelta(Math.round(drift * 1000)); lastSyncDeltaRef.current = Math.round(drift * 1000);
          if (drift > 0.05) handlers.current.seekTo(epoch.startVideoTime);
          setSyncStatus('synced'); return;
      }
      if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current) return;

      const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
      const expectedTime = epoch.startVideoTime + (((Date.now() + clockOffsetRef.current) - epoch.startNetworkTime) / 1000) - dacOffset;
      const drift = expectedTime - handlers.current.getCurrentTime();
      const absDrift = Math.abs(drift);
      
      setLastSyncDelta(Math.round(absDrift * 1000)); lastSyncDeltaRef.current = Math.round(absDrift * 1000);

      // 🏆 COAST MODE (< 5ms)
      if (absDrift < 0.005) {
          consecutiveMisses.current = 0;
          setSyncStatus('synced');
          if (st !== 1) handlers.current.play();
          return; // Skip all math! Coast perfectly.
      }

      const tolerance = Math.max(0.015, Math.min(0.250, (networkJitterRef.current / 1000) * 1.5));
      if (absDrift > tolerance) {
          consecutiveMisses.current += 1;
          if (consecutiveMisses.current >= 2) {
              setSyncStatus('syncing');
              if (absDrift <= 0.600) {
                  // DUAL-DIRECTION GLIDE
                  const rate = drift > 0 ? 1.25 : 0.75;
                  const holdTimeMs = Math.min((absDrift / 0.25) * 1000, 2000); 
                  logEvent('GLIDE', { rate, absDrift });
                  handlers.current.setPlaybackRate(rate);
                  softGlideUntil.current = Date.now() + holdTimeMs;
                  ignoreSyncUntil.current = Date.now() + holdTimeMs + 200; 
                  setTimeout(() => handlers.current.setPlaybackRate(1.0), holdTimeMs);
              } else {
                  logEvent('HARD_SEEK', { absDrift });
                  handlers.current.seekTo(expectedTime);
                  ignoreSyncUntil.current = Date.now() + 2500;
              }
          }
      } else {
          consecutiveMisses.current = 0; setSyncStatus('synced');
          if (st !== 1) handlers.current.play();
      }
    }, 300); 
    return () => clearInterval(interval);
  }, [isHost, logEvent]);

  // HOST BROADCAST
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const isPlaying = handlers.current.getPlayerState() === 1;
      let changed = false;
      if (isPlaying) {
        const expected = epochRef.current.startVideoTime + ((Date.now() - epochRef.current.startNetworkTime) / 1000);
        if (!epochRef.current.isPlaying || Math.abs(expected - handlers.current.getCurrentTime()) > 0.150) {
           epochRef.current = { isPlaying: true, startNetworkTime: Date.now(), startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
           changed = true;
        }
      } else {
         if (epochRef.current.isPlaying || Math.abs(epochRef.current.startVideoTime - handlers.current.getCurrentTime()) > 0.150) {
           epochRef.current = { isPlaying: false, startNetworkTime: Date.now(), startVideoTime: handlers.current.getCurrentTime(), videoId: currentVideoIdRef.current, updateId: epochRef.current.updateId + 1 };
           changed = true;
         }
      }
      if (changed || Date.now() - lastHostBroadcastTime.current > 2500) {
        channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: epochRef.current });
        lastHostBroadcastTime.current = Date.now();
        if (changed) logEvent('HOST_UPDATE', epochRef.current);
      }
    }, 100); 
    return () => clearInterval(interval);
  }, [isHost, logEvent]);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, downloadLogs, engineVersion: ENGINE_VERSION,
    broadcastPlay: () => {}, broadcastPause: () => {}, broadcastVideoChange: (id: string) => { currentVideoIdRef.current = id; }, broadcastQueueUpdate: () => {}, forceResync: () => {}, manualResync: () => {}, measureLatency: () => {}, 
    deviceInfo: deviceInfo.current, setCurrentVideoId: (id: string) => { currentVideoIdRef.current = id; },
    reportPreloadReady: (vid: string) => { cachedVideoIdRef.current = vid; if (!isHost) channelRef.current?.track({ id: userId, cachedVideoId: vid }); }
  };
};
