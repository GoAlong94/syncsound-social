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
  
  // STATE REFS
  const latencyRef = useRef<number>(0);
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const lastSyncTimeRef = useRef<number>(0);
  const deviceInfo = useRef(getDeviceInfo());

  // HANDLER REF
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

  useEffect(() => {
    handlersRef.current = {
      getCurrentTime,
      seekTo,
      setPlaybackRate,
      play,
      pause,
      getPlayerState,
      onVideoChange,
      onQueueUpdate
    };
  });

  useEffect(() => {
    latencyRef.current = latency;
  }, [latency]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

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
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  // --- MAIN EFFECT ---
  useEffect(() => {
    console.log("[SyncEngine] Initializing..."); 
    
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

    // SYNC HANDLER (The Critical Part)
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage & { videoId?: string } }) => {
      if (isHost) return;

      // 1. Calculate Absolute Host Time
      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      
      // 2. Calculate Travel Time
      // How long ago (in Host Time) was this message sent?
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      
      // 3. Estimate where Host is RIGHT NOW
      const estimatedHostTime = (payload.currentTime || 0) + timeSinceBroadcast;
      const localTime = handlersRef.current.getCurrentTime();
      
      const drift = estimatedHostTime - localTime;
      const absDrift = Math.abs(drift);
      const diffMs = Math.round(drift * 1000);

      setLastSyncDelta(diffMs);

      // DEBUG LOGGING
      console.log(`[Sync] Drift: ${diffMs}ms | HostTime: ${estimatedHostTime.toFixed(3)} | LocalTime: ${localTime.toFixed(3)} | Offset: ${Math.round(clockOffsetRef.current)}ms`);

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      let targetRate = 1;
      let newStatus: SyncStatus = 'synced';

      // --- NEW AGGRESSIVE THRESHOLDS ---
      if (absDrift < 0.045) { // 45ms: Perfect
        targetRate = 1;
        newStatus = 'synced';
      } else if (absDrift < 0.1) { // 45ms - 100ms: Micro adjustment
        targetRate = drift > 0 ? 1.02 : 0.98;
        newStatus = 'syncing';
      } else if (absDrift < 0.6) { // 100ms - 600ms: Strong adjustment
        // If we are +700ms ahead (drift is negative), we need 0.90 speed
        // If we are -700ms behind (drift is positive), we need 1.10 speed
        targetRate = drift > 0 ? 1.08 : 0.92;
        newStatus = 'syncing';
      } else {
        // > 600ms: JUMP (Snap to position)
        // This fixes the "700ms lag" issue by forcing a seek
        console.log(`[Sync] Large drift detected (${diffMs}ms). Seeking to ${estimatedHostTime}`);
        handlersRef.current.seekTo(estimatedHostTime);
        targetRate = 1;
        newStatus = 'syncing';
      }

      handlersRef.current.setPlaybackRate(targetRate);
      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;

      const localState = handlersRef.current.getPlayerState();
      if (payload.isPlaying && localState !== 1) {
        handlersRef.current.play();
      } else if (!payload.isPlaying && localState === 1) {
        handlersRef.current.pause();
      }
    });

    channel.on('broadcast', { event: 'force_sync' }, ({ payload }) => {
      if (isHost) return;
      console.log("[Sync] Force Sync received");
      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      const targetTime = payload.currentTime + timeSinceBroadcast;
      
      if (payload.videoId) currentVideoIdRef.current = payload.videoId;
      
      handlersRef.current.seekTo(targetTime);
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
            handlersRef.current.seekTo(targetTime);
          }
        }, 1500);
        
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => {
      if (!isHost && payload) {
        handlersRef.current.onQueueUpdate?.(payload as QueueState);
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
        
        // LOGGING CLOCK SYNC
        console.log(`[ClockSync] RTT: ${rtt}ms | Computed Offset: ${offset}ms`);

        const prev = clockOffsetRef.current;
        // Faster convergence on startup (if offset is 0, take new value immediately)
        clockOffsetRef.current = prev === 0 ? offset : (prev * 0.8 + offset * 0.2);
        
        setLatency(rtt);
        latencyRef.current = rtt;
        
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
          // Burst pings for initial clock sync
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 5) {
                const pingTime = Date.now();
                channel.send({ type: 'broadcast', event: 'ping', payload: { timestamp: pingTime, senderId: userId } });
             } else {
                clearInterval(interval);
                channel.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } });
             }
          }, 500);
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

  // Methods
  const forceResync = useCallback(() => {
    if (!channelRef.current || !isHost) return;
    const currentTime = handlersRef.current.getCurrentTime();
    const playerState = handlersRef.current.getPlayerState();
    channelRef.current.send({
      type: 'broadcast',
      event: 'force_sync',
      payload: {
        currentTime,
        videoId: currentVideoIdRef.current,
        isPlaying: playerState === 1,
        timestamp: Date.now(),
      },
    });
  }, [isHost]);

  const broadcastPlay = useCallback(() => { channelRef.current?.send({ type: 'broadcast', event: 'play', payload: { type: 'play' } }); }, []);
  const broadcastPause = useCallback(() => { channelRef.current?.send({ type: 'broadcast', event: 'pause', payload: { type: 'pause' } }); }, []);
  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    const currentTime = handlersRef.current.getCurrentTime();
    channelRef.current?.send({
      type: 'broadcast',
      event: 'video_change',
      payload: {
        type: 'video_change',
        videoId,
        videoTitle: title,
        videoThumbnail: thumbnail,
        startTime: currentTime,
        timestamp: Date.now(),
      },
    });
  }, []);
  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);

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
