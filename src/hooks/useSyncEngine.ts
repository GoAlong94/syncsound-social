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
  
  // STATE REFS (These prevent the useEffect from breaking when state changes)
  const latencyRef = useRef<number>(0);
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const lastSyncTimeRef = useRef<number>(0);
  const deviceInfo = useRef(getDeviceInfo());

  // HANDLER REF (The Magic Fix: Access latest functions without breaking dependencies)
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

  // Keep handlers up to date on every render
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

  // Keep state refs in sync
  useEffect(() => {
    latencyRef.current = latency;
  }, [latency]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  const updatePresence = useCallback(async (updates: Partial<PresenceState>) => {
    if (!channelRef.current) return;
    
    await channelRef.current.track({
      id: userId,
      isHost,
      joinedAt: Date.now(),
      os: deviceInfo.current.os,
      browser: deviceInfo.current.browser,
      syncStatus: syncStatusRef.current,
      latency: latencyRef.current,
      lastSyncDelta,
      ...updates,
    });
  }, [userId, isHost, lastSyncDelta]);

  // Measure latency via ping/pong
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

  // --- MAIN EFFECT: ONE-TIME SETUP ---
  useEffect(() => {
    console.log("Initializing Sync Engine..."); // Should only see this ONCE per room join
    
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

    // SYNC HANDLER
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage & { videoId?: string } }) => {
      if (isHost) return;

      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      
      const estimatedHostTime = (payload.currentTime || 0) + timeSinceBroadcast;
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

      if (absDrift < 0.045) { // 45ms tolerance
        targetRate = 1;
        newStatus = 'synced';
      } else if (absDrift < 0.1) {
        targetRate = drift > 0 ? 1.02 : 0.98;
        newStatus = 'syncing';
      } else if (absDrift < 0.5) {
        targetRate = drift > 0 ? 1.05 : 0.95;
        newStatus = 'syncing';
      } else if (absDrift < 2) {
        targetRate = drift > 0 ? 1.10 : 0.90;
        newStatus = 'syncing';
      } else {
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

      // We DON'T update presence here to avoid spamming the channel
      // Only update presence on status change or significant events
    });

    channel.on('broadcast', { event: 'force_sync' }, ({ payload }) => {
      if (isHost) return;
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
        
        // Simple smoothing
        const prev = clockOffsetRef.current;
        clockOffsetRef.current = prev === 0 ? offset : (prev * 0.8 + offset * 0.2);
        
        setLatency(rtt);
        latencyRef.current = rtt;
        
        // Update presence with latency (but throttled)
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
    // CRITICAL: Empty dependency array mostly. 
    // We only reconnect if the ROOM or USER changes.
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

  // Public Methods (Memoized)
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

  const broadcastPlay = useCallback(() => {
    channelRef.current?.send({ type: 'broadcast', event: 'play', payload: { type: 'play' } });
  }, []);

  const broadcastPause = useCallback(() => {
    channelRef.current?.send({ type: 'broadcast', event: 'pause', payload: { type: 'pause' } });
  }, []);

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

  const broadcastQueueUpdate = useCallback((queue: QueueState) => {
    channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue });
  }, []);

  const setCurrentVideoId = useCallback((videoId: string) => {
    currentVideoIdRef.current = videoId;
  }, []);

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
