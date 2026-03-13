import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

// ============================================================================
// PART 1: MATH & FILTERS
// ============================================================================

class KalmanFilter {
  private r: number; private q: number; private p: number; 
  private x: number; private k: number;
  constructor(measurementNoise = 10, processNoise = 0.1, initialError = 1, initialEstimate = 0) {
    this.r = measurementNoise; this.q = processNoise; 
    this.p = initialError; this.x = initialEstimate; this.k = 0;
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
// PART 2: THE DECOUPLED SYNC ENGINE
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
  const currentVideoIdRef = useRef<string | null>(null);
  
  const epochRef = useRef<EpochState>({ isPlaying: false, startNetworkTime: 0, startVideoTime: 0, videoId: null, updateId: 0 });

  const ignoreSyncUntil = useRef<number>(0);
  const softGlideUntil = useRef<number>(0);
  const lastHostBroadcastTime = useRef<number>(0);
  const consecutiveMisses = useRef<number>(0);
  const wasPlayingRef = useRef<boolean>(false);
  const catchupTimeout = useRef<NodeJS.Timeout | null>(null);
  
  // NEW: Buffer loop protection refs
  const postBufferGracePeriodUntil = useRef<number>(0);

  // --- OMNISCIENT TELEMETRY ---
  const syncLogs = useRef<any[]>([]);
  const collectedLogsRef = useRef<Record<string, any[]>>({});

  const logEvent = useCallback((e: string, data: any = {}) => {
    // Inject vital player stats into EVERY log event
    const currentState = handlers.current.getPlayerState();
    const currentLocalTime = handlers.current.getCurrentTime();
    
    syncLogs.current.push({ 
      t: new Date().toISOString(), 
      r: isHost ? 'HOST' : 'JOINER', 
      e, 
      ctx: { state: currentState, locTime: currentLocalTime, jitter: networkJitterRef.current },
      ...data 
    });
    if (syncLogs.current.length > 3000) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    if (isHost && channelRef.current) {
      collectedLogsRef.current = { [`HOST_${deviceInfo.current.os}_${userId.slice(0,5)}`]: syncLogs.current };
      logEvent('BROADCAST_LOG_REQUEST', {});
      channelRef.current.send({ type: 'broadcast', event: 'request_logs', payload: {} });
      setTimeout(() => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(collectedLogsRef.current, null, 2));
        const a = document.createElement('a'); a.href = dataStr; a.download = `sync_omega_ALL_DEVICES_${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      }, 2500);
    }
  }, [isHost, userId, logEvent]);

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
            logEvent('APP_FOREGROUNDED');
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
    logEvent('HARD_SEEK_EXEC', { target: time, reason });
    if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
    
    handlers.current.seekTo(time);
    if (epochRef.current.isPlaying) handlers.current.play();
    else handlers.current.pause();
    
    ignoreSyncUntil.current = Date.now() + lockoutMs; 
  }, [logEvent]);

  const executeSoftGlide = useCallback((driftSeconds: number, direction: 'ahead' | 'behind') => {
      const rate = direction === 'ahead' ? 0.75 : 1.25;
      const virtualDiffPerSec = 0.25; 
      
      const holdTimeMs = Math.min((driftSeconds / virtualDiffPerSec) * 1000, 2000); 
      
      logEvent('SOFT_GLIDE_EXEC', { direction, driftSeconds, holdTimeMs, rate });
      handlers.current.setPlaybackRate(rate);
      
      softGlideUntil.current = Date.now() + holdTimeMs;
      ignoreSyncUntil.current = Date.now() + holdTimeMs + 200; 
      
      setTimeout(() => { 
          handlers.current.setPlaybackRate(1.0); 
          logEvent('SOFT_GLIDE_END', { restoredRate: 1.0 });
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
  // LAYER 1: NETWORK DEMUXER
  // ============================================================================
  useEffect(() => {
    logEvent('INIT_NTP_BUS', { roomId });
    const channel = supabase.channel(`room:${roomId}`, { config: { presence: { key: userId }, broadcast: { self: false } }});

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setConnectedDevices(Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping, os: p.os || '?', browser: p.browser || '?', 
        syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, lastSyncDelta: p.lastSyncDelta || 0, jitter: p.jitter || 0
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
        networkJitterRef.current = metrics.jitter;
        
        setLatency(Math.round(metrics.rtt));
        setNetworkJitter(Math.round(metrics.jitter));
        
        if (Math.random() < 0.15) { 
           channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, syncStatus: 'synced', latency: Math.round(metrics.rtt), jitter: Math.round(metrics.jitter), lastSyncDelta: lastSyncDeltaRef.current });
        }
      }
    });

    channel.on('broadcast', { event: 'request_logs' }, () => {
      if (isHost) return;
      logEvent('UPLOADING_LOGS_TO_HOST');
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
        handlers.current.onVideoChange?.(payload.videoId, "", "");
        logEvent('HOST_CMD_NEW_VIDEO', { vId: payload.videoId });
        executeHardSeek(0, 'Video Changed', 2500);
        return;
      }

      if (payload.isPlaying && !wasPlaying) {
         if (Date.now() < ignoreSyncUntil.current) return;
         logEvent('HOST_CMD_PLAY_RECEIVED');
         handlers.current.play();
      }
      
      if (!payload.isPlaying) {
         if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
         handlers.current.pause();
         logEvent('HOST_CMD_PAUSE_RECEIVED');
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
  }, [roomId, userId, isHost, logEvent, executeHardSeek]);

  // ============================================================================
  // LAYER 2: AUTONOMOUS JOINER EVALUATION LOOP 
  // ============================================================================
  useEffect(() => {
    if (isHost) return;

    const interval = setInterval(() => {
      const epoch = epochRef.current;
      if (!epoch.videoId) return;
      
      const playerState = handlers.current.getPlayerState();
      
      // 🛡️ THE POST-BUFFER GRACE PERIOD FIX 🛡️
      if (playerState === 3 || playerState === -1) {
          logEvent('BUFFER_PROTECT_ACTIVE');
          setSyncStatus('syncing');
          // Extend locks so we don't try to seek while spinning
          ignoreSyncUntil.current = Date.now() + 1000;
          // Set a Grace Period. When it finishes buffering, it must wait 4s before hard seeking.
          postBufferGracePeriodUntil.current = Date.now() + 4000; 
          return; 
      }

      if (!epoch.isPlaying) {
          wasPlayingRef.current = false;
          if (catchupTimeout.current) { clearTimeout(catchupTimeout.current); catchupTimeout.current = null; }
          if (playerState === 1) handlers.current.pause();
          
          const localTime = handlers.current.getCurrentTime();
          const drift = Math.abs(localTime - epoch.startVideoTime);
          
          setLastSyncDelta(Math.round(drift * 1000));
          lastSyncDeltaRef.current = Math.round(drift * 1000);
          
          if (drift > 0.050) handlers.current.seekTo(epoch.startVideoTime);
          setSyncStatus('synced');
          return;
      }

      if (Date.now() < ignoreSyncUntil.current || Date.now() < softGlideUntil.current) return;

      const networkTime = Date.now() + clockOffsetRef.current;
      const dacOffset = getAudioHardwareOffset(deviceInfo.current.os, deviceInfo.current.browser);
      const expectedTime = epoch.startVideoTime + ((networkTime - epoch.startNetworkTime) / 1000) - dacOffset;
      const localTime = handlers.current.getCurrentTime();
      
      const drift = expectedTime - localTime;
      const absDrift = Math.abs(drift);
      
      setLastSyncDelta(Math.round(absDrift * 1000));
      lastSyncDeltaRef.current = Math.round(absDrift * 1000);
      
      // Dynamic Tolerance: Expands up to 250ms on extremely jittery forest networks
      const tolerance = Math.max(0.015, Math.min(0.250, (networkJitterRef.current / 1000) * 1.5));

      logEvent('EVAL_TICK', { drift, absDrift, tolerance, inGracePeriod: Date.now() < postBufferGracePeriodUntil.current });

      if (absDrift > tolerance) {
          consecutiveMisses.current += 1;
          
          if (consecutiveMisses.current >= 2) {
              setSyncStatus('syncing');
              
              const isInGracePeriod = Date.now() < postBufferGracePeriodUntil.current;
              
              if (drift > 0) {
                  // BEHIND
                  if (absDrift <= 0.600 || isInGracePeriod) {
                      logEvent('DECISION: Glide Behind', { reason: isInGracePeriod ? 'Grace Period Active' : 'Under 600ms threshold' });
                      executeSoftGlide(absDrift, 'behind');
                  } else {
                      executeHardSeek(expectedTime, `Macro-Behind: ${absDrift.toFixed(3)}s`, 2500);
                  }
              } else {
                  // AHEAD
                  if (absDrift <= 0.600 || isInGracePeriod) {
                      logEvent('DECISION: Glide Ahead', { reason: isInGracePeriod ? 'Grace Period Active' : 'Under 600ms threshold' });
                      executeSoftGlide(absDrift, 'ahead');
                  } else {
                      executeHardSeek(expectedTime, `Macro-Ahead: ${absDrift.toFixed(3)}s`, 2500);
                  }
              }
          }
      } else {
          consecutiveMisses.current = 0;
          setSyncStatus('synced');
          if (playerState !== 1) {
              logEvent('FAILSAFE_PLAY_TRIGGER');
              handlers.current.play();
          }
      }

    }, 300); 
    return () => clearInterval(interval);
  }, [isHost, logEvent, executeHardSeek, executeSoftGlide]);


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
        if (stateChanged) logEvent('HOST_STATE_CHANGED', epochRef.current);
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
    requestSync();
    for(let i=0; i<5; i++) setTimeout(measureLatency, i*100);
  }, [isHost, requestSync, measureLatency]);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, networkJitter, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate: () => {}, forceResync, manualResync: manualResyncFunc, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId: (id: string) => { currentVideoIdRef.current = id; },
  };
};
