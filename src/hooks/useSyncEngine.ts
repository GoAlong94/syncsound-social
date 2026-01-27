import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { SyncMessage, PresenceState, SyncStatus } from '@/types/room';
import { QueueState } from '@/types/queue';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getDeviceInfo } from '@/utils/deviceInfo';

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
  const [latency, setLatency] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unsynced');
  const [lastSyncDelta, setLastSyncDelta] = useState<number>(0);
  
  const latencyRef = useRef<number>(0);
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const lastSyncTimeRef = useRef<number>(0);
  const deviceInfo = useRef(getDeviceInfo());
  
  // 🔥 CRITICAL MOBILE FIX 1: The "Cooldown" Timer
  // Prevents the "Rubber Band" loop by ignoring updates while buffering
  const ignoreSyncUntilRef = useRef<number>(0);

  // 🔥 CRITICAL MOBILE FIX 2: MinRTT Filter
  // Ignores 4G/WiFi lag spikes
  const minRttRef = useRef<number>(9999);
  
  // 🔥 CRITICAL MOBILE FIX 3: Wake Lock
  const wakeLockRef = useRef<any>(null);

  const handlersRef = useRef({
    getCurrentTime,
    seekTo,
    setPlaybackRate,
    play,
    pause,
    getPlayerState,
    onVideoChange,
    onQueueUpdate
  });

  // Expose offset for debugging
  useEffect(() => {
    (window as any)._debug_clock_offset = clockOffsetRef.current;
  });

  useEffect(() => {
    handlersRef.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate };
  });

  useEffect(() => { latencyRef.current = latency; }, [latency]);
  useEffect(() => { syncStatusRef.current = syncStatus; }, [syncStatus]);

  // Mobile Wake Lock Implementation
  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        try {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        } catch (err) {
          console.log('Wake Lock rejected:', err);
        }
      }
    };
    requestWakeLock();
    const handleVis = () => {
      if (document.visibilityState === 'visible') requestWakeLock();
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, []);

  const measureLatency = useCallback(() => {
    if (!channelRef.current) return;
    const pingTime = Date.now();
    channelRef.current.send({
      type: 'broadcast',
      event: 'ping',
      payload: { timestamp: pingTime, senderId: userId },
    });
  }, [userId]);

  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'sync_request',
      payload: { senderId: userId },
    });
  }, [isHost, userId]);

  const manualResync = useCallback(() => {
    if (isHost) return;
    setSyncStatus('syncing');
    syncStatusRef.current = 'syncing';
    minRttRef.current = 9999; 
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  // 🔥 CRITICAL MOBILE FIX 4: SafeSeek
  // Pauses sync checks for 2.5 seconds after a jump
  const safeSeek = useCallback((time: number) => {
    console.log(`[Sync] 🛑 HARD SEEK to ${time.toFixed(2)}s. Pausing checks for 2.5s.`);
    handlersRef.current.seekTo(time);
    ignoreSyncUntilRef.current = Date.now() + 2500; 
  }, []);

  useEffect(() => {
    console.log("[SyncEngine] Mobile Optimized Init..."); 
    
    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        presence: { key: userId },
        broadcast: { self: false },
      },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const devices: PresenceState[] = Object.values(state)
        .flat()
        .map((p: any) => ({
          id: p.id,
          isHost: p.isHost,
          joinedAt: p.joinedAt,
          ping: p.ping,
          os: p.os || 'Unknown',
          browser: p.browser || 'Unknown',
          syncStatus: p.syncStatus || 'unsynced',
          latency: p.latency || 0,
          lastSyncDelta: p.lastSyncDelta || 0,
        }));
      setConnectedDevices(devices);
    });

    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage & { videoId?: string } }) => {
      if (isHost) return;

      // 1. CHECK COOLDOWN: If we just jumped, ignore everything!
      if (Date.now() < ignoreSyncUntilRef.current) {
        return;
      }

      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      
      // 🔥 CRITICAL MOBILE FIX 5: Hardware Offsets
      let hardwareOffset = 0;
      if (deviceInfo.current.os === 'iOS') hardwareOffset = 0.015; 
      if (deviceInfo.current.os === 'Android') hardwareOffset = 0.040; 

      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      const estimatedHostTime = (payload.currentTime || 0) + timeSinceBroadcast - hardwareOffset;
      const localTime = handlersRef.current.getCurrentTime();
      
      const drift = estimatedHostTime - localTime;
      const absDrift = Math.abs(drift);
      const diffMs = Math.round(drift * 1000);

      setLastSyncDelta(diffMs);

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      let targetRate = 1;
      let newStatus: SyncStatus = 'synced';

      // --- MOBILE-TUNED THRESHOLDS ---
      
      // 1. Excellent (< 60ms)
      if (absDrift < 0.06) { 
        targetRate = 1;
        newStatus = 'synced';
      } 
      // 2. Micro-Correction (60ms - 200ms)
      else if (absDrift < 0.20) { 
        targetRate = drift > 0 ? 1.02 : 0.98;
        newStatus = 'syncing';
      } 
      // 3. Fast-Catchup (200ms - 1500ms)
      // Use Speed instead of Jump for gaps up to 1.5 seconds!
      else if (absDrift < 1.50) { 
        targetRate = drift > 0 ? 1.10 : 0.90;
        newStatus = 'syncing';
      } 
      // 4. Emergency Jump (> 1.5s)
      else {
        safeSeek(estimatedHostTime);
        targetRate = 1;
        newStatus = 'syncing';
      }

      handlersRef.current.setPlaybackRate(targetRate);
      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;

      const localState = handlersRef.current.getPlayerState();
      if (payload.isPlaying && localState !== 1) handlersRef.current.play();
      else if (!payload.isPlaying && localState === 1) handlersRef.current.pause();
    });

    channel.on('broadcast', { event: 'force_sync' }, ({ payload }) => {
      if (isHost) return;
      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      const targetTime = payload.currentTime + timeSinceBroadcast;
      
      if (payload.videoId) currentVideoIdRef.current = payload.videoId;
      
      safeSeek(targetTime); 
      handlersRef.current.setPlaybackRate(1);
      payload.isPlaying ? handlersRef.current.play() : handlersRef.current.pause();
      setSyncStatus('syncing');
      syncStatusRef.current = 'syncing';
    });

    channel.on('broadcast', { event: 'sync_request' }, () => {
      if (!isHost) return;
      const currentTime = handlersRef.current.getCurrentTime();
      const playerState = handlersRef.current.getPlayerState();
      channel.send({
        type: 'broadcast',
        event: 'sync',
        payload: {
          type: 'sync',
          currentTime,
          videoId: currentVideoIdRef.current,
          isPlaying: playerState === 1,
          timestamp: Date.now(),
        },
      });
    });

    channel.on('broadcast', { event: 'play' }, () => { if (!isHost) handlersRef.current.play(); });
    channel.on('broadcast', { event: 'pause' }, () => { if (!isHost) handlersRef.current.pause(); });
    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => { if (!isHost && payload) handlersRef.current.onQueueUpdate?.(payload as QueueState); });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: SyncMessage }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlersRef.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        setTimeout(() => {
          if (payload.startTime !== undefined && payload.timestamp) {
            const localNow = Date.now();
            const hostNow = localNow + clockOffsetRef.current;
            const timeSinceBroadcast = Math.max(0, (hostNow - payload.timestamp)) / 1000;
            const targetTime = payload.startTime + timeSinceBroadcast;
            safeSeek(targetTime);
          }
        }, 1500);
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.senderId !== userId) {
        channel.send({
          type: 'broadcast',
          event: 'pong',
          payload: { 
            timestamp: payload.timestamp,
            hostTime: Date.now(),
            targetId: payload.senderId,
            responderId: userId 
          },
        });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.targetId === userId) {
        const now = Date.now();
        const rtt = now - payload.timestamp;
        const offset = payload.hostTime - payload.timestamp - (rtt / 2);
        
        // 🔥 CRITICAL MOBILE FIX 6: MinRTT Filter
        // Only trust low-latency pings
        let shouldUpdate = false;
        if (rtt <= minRttRef.current) {
          minRttRef.current = rtt;
          clockOffsetRef.current = offset; 
          shouldUpdate = true;
          (window as any)._debug_clock_offset = offset; 
        } 
        else if (rtt < minRttRef.current * 1.2) {
          const prev = clockOffsetRef.current;
          clockOffsetRef.current = prev * 0.8 + offset * 0.2;
          shouldUpdate = true;
          (window as any)._debug_clock_offset = clockOffsetRef.current; 
        }
        
        setLatency(rtt);
        latencyRef.current = rtt;
        
        if (shouldUpdate) {
           channel.track({
            id: userId,
            isHost,
            joinedAt: Date.now(),
            os: deviceInfo.current.os,
            browser: deviceInfo.current.browser,
            syncStatus: syncStatusRef.current,
            latency: rtt,
            lastSyncDelta: 0
          });
        }
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
          lastSyncDelta: 0,
        });
        
        if (!isHost) {
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 8) {
                const pingTime = Date.now();
                channel.send({ type: 'broadcast', event: 'ping', payload: { timestamp: pingTime, senderId: userId } });
             } else {
                clearInterval(interval);
                channel.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } });
             }
          }, 400);
        }
      }
    });

    channelRef.current = channel;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isHost) {
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
        requestSync();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost]);

  // Host Broadcast Loop
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const currentTime = handlersRef.current.getCurrentTime();
      const playerState = handlersRef.current.getPlayerState();
      if (currentTime !== lastSyncTimeRef.current || playerState === 1) {
        channelRef.current?.send({
          type: 'broadcast',
          event: 'sync',
          payload: {
            type: 'sync',
            currentTime,
            videoId: currentVideoIdRef.current,
            isPlaying: playerState === 1,
            timestamp: Date.now(),
          },
        });
        lastSyncTimeRef.current = currentTime;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isHost]);

  const broadcastPlay = useCallback(() => { channelRef.current?.send({ type: 'broadcast', event: 'play', payload: { type: 'play' } }); }, []);
  const broadcastPause = useCallback(() => { channelRef.current?.send({ type: 'broadcast', event: 'pause', payload: { type: 'pause' } }); }, []);
  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    const currentTime = handlersRef.current.getCurrentTime();
    channelRef.current?.send({
      type: 'broadcast',
      event: 'video_change',
      payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail, startTime: currentTime, timestamp: Date.now() },
    });
  }, []);
  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);
  const forceResync = useCallback(() => { if (channelRef.current && isHost) { const currentTime = handlersRef.current.getCurrentTime(); const playerState = handlersRef.current.getPlayerState(); channelRef.current.send({ type: 'broadcast', event: 'force_sync', payload: { currentTime, videoId: currentVideoIdRef.current, isPlaying: playerState === 1, timestamp: Date.now() } }); } }, [isHost]);

  return {
    connectedDevices,
    latency,
    syncStatus,
    lastSyncDelta,
    broadcastPlay,
    broadcastPause,
    broadcastVideoChange,
    broadcastQueueUpdate,
    forceResync,
    manualResync,
    measureLatency,
    deviceInfo: deviceInfo.current,
    setCurrentVideoId,
  };
};
