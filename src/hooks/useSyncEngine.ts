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
  
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncTimeRef = useRef<number>(0);
  const rateResetTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const deviceInfo = useRef(getDeviceInfo());

  // Update presence with current sync status
  const updatePresence = useCallback(async (updates: Partial<PresenceState>) => {
    if (!channelRef.current) return;
    
    await channelRef.current.track({
      id: userId,
      isHost,
      joinedAt: Date.now(),
      os: deviceInfo.current.os,
      browser: deviceInfo.current.browser,
      syncStatus,
      latency,
      lastSyncDelta,
      ...updates,
    });
  }, [userId, isHost, syncStatus, latency, lastSyncDelta]);

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

  // Force all joiners to resync
  const forceResync = useCallback(() => {
    if (!channelRef.current || !isHost) return;

    const currentTime = getCurrentTime();
    const playerState = getPlayerState();
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'force_sync',
      payload: {
        currentTime,
        isPlaying: playerState === 1,
        timestamp: Date.now(),
      },
    });
  }, [isHost, getCurrentTime, getPlayerState]);

  // Request sync from host (for joiners)
  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'sync_request',
      payload: { senderId: userId },
    });
  }, [isHost, userId]);

  // Manual resync for joiners
  const manualResync = useCallback(() => {
    if (isHost) return;
    
    setSyncStatus('syncing');
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  // Initialize Realtime channel
  useEffect(() => {
    const channel = supabase.channel(`room:${roomId}`, {
      config: {
        presence: { key: userId },
        broadcast: { self: false },
      },
    });

    // Handle presence sync
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

    // Handle sync broadcasts from host
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage }) => {
      if (isHost) return;

      const networkDelay = latency / 2000; // Half RTT in seconds
      const hostTime = (payload.currentTime || 0) + networkDelay;
      const localTime = getCurrentTime();
      const diff = hostTime - localTime;
      const diffMs = Math.round(diff * 1000);

      setLastSyncDelta(diffMs);

      // Determine sync status based on drift
      if (Math.abs(diff) < 0.04) {
        setSyncStatus('synced');
        // Reset playback rate if we're synced
        if (rateResetTimeoutRef.current) {
          clearTimeout(rateResetTimeoutRef.current);
          rateResetTimeoutRef.current = null;
        }
        setPlaybackRate(1);
      } else if (Math.abs(diff) <= 2) {
        setSyncStatus('syncing');
        // Smooth correction via playback rate
        const rate = diff > 0 ? 1.05 : 0.95;
        setPlaybackRate(rate);
        
        // Reset rate after correction period
        if (rateResetTimeoutRef.current) {
          clearTimeout(rateResetTimeoutRef.current);
        }
        rateResetTimeoutRef.current = setTimeout(() => {
          setPlaybackRate(1);
        }, Math.min(Math.abs(diff) * 1000, 2000));
      } else {
        // Major desync: hard seek
        setSyncStatus('syncing');
        seekTo(hostTime);
        setPlaybackRate(1);
      }

      // Sync play/pause state
      const localState = getPlayerState();
      if (payload.isPlaying && localState !== 1) {
        play();
      } else if (!payload.isPlaying && localState === 1) {
        pause();
      }

      // Update presence with new sync status
      updatePresence({
        syncStatus: Math.abs(diff) < 0.04 ? 'synced' : 'syncing',
        lastSyncDelta: diffMs,
      });
    });

    // Handle force sync from host
    channel.on('broadcast', { event: 'force_sync' }, ({ payload }) => {
      if (isHost) return;

      const networkDelay = latency / 2000;
      const targetTime = payload.currentTime + networkDelay;
      
      seekTo(targetTime);
      setPlaybackRate(1);
      
      if (payload.isPlaying) {
        play();
      } else {
        pause();
      }
      
      setSyncStatus('syncing');
      setLastSyncDelta(0);
    });

    // Handle sync request from joiners (host responds)
    channel.on('broadcast', { event: 'sync_request' }, ({ payload }) => {
      if (!isHost) return;

      const currentTime = getCurrentTime();
      const playerState = getPlayerState();
      
      channel.send({
        type: 'broadcast',
        event: 'sync',
        payload: {
          type: 'sync',
          currentTime,
          isPlaying: playerState === 1,
          timestamp: Date.now(),
        },
      });
    });

    channel.on('broadcast', { event: 'play' }, () => {
      if (!isHost) {
        play();
      }
    });

    channel.on('broadcast', { event: 'pause' }, () => {
      if (!isHost) {
        pause();
      }
    });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: SyncMessage }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        setSyncStatus('syncing');
      }
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => {
      if (!isHost && payload) {
        onQueueUpdate?.(payload as QueueState);
      }
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (payload.senderId !== userId) {
        channel.send({
          type: 'broadcast',
          event: 'pong',
          payload: { timestamp: payload.timestamp, responderId: userId },
        });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (isHost) {
        const rtt = Date.now() - payload.timestamp;
        setLatency(rtt);
      } else if (payload.responderId !== userId) {
        // Joiners can also track their latency
        const rtt = Date.now() - payload.timestamp;
        setLatency(rtt);
        updatePresence({ latency: rtt });
      }
    });

    // Subscribe and track presence
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
        
        // Joiner: request initial sync
        if (!isHost) {
          setTimeout(() => {
            requestSync();
            measureLatency();
          }, 500);
        }
      }
    });

    channelRef.current = channel;

    // Handle tab visibility for joiners
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isHost) {
        requestSync();
        measureLatency();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      if (rateResetTimeoutRef.current) {
        clearTimeout(rateResetTimeoutRef.current);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost, getCurrentTime, seekTo, setPlaybackRate, play, pause, latency, onVideoChange, onQueueUpdate, getPlayerState, updatePresence, requestSync, measureLatency]);

  // Host broadcasts current time every second
  useEffect(() => {
    if (!isHost || !channelRef.current) return;

    syncIntervalRef.current = setInterval(() => {
      const currentTime = getCurrentTime();
      const playerState = getPlayerState();
      
      if (currentTime !== lastSyncTimeRef.current || playerState === 1) {
        channelRef.current?.send({
          type: 'broadcast',
          event: 'sync',
          payload: {
            type: 'sync',
            currentTime,
            isPlaying: playerState === 1,
            timestamp: Date.now(),
          },
        });
        lastSyncTimeRef.current = currentTime;
      }
    }, 1000);

    // Measure latency periodically
    const latencyInterval = setInterval(measureLatency, 5000);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      clearInterval(latencyInterval);
    };
  }, [isHost, getCurrentTime, getPlayerState, measureLatency]);

  const broadcastPlay = useCallback(() => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'play',
      payload: { type: 'play' },
    });
  }, []);

  const broadcastPause = useCallback(() => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'pause',
      payload: { type: 'pause' },
    });
  }, []);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'video_change',
      payload: {
        type: 'video_change',
        videoId,
        videoTitle: title,
        videoThumbnail: thumbnail,
      },
    });
  }, []);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'queue_update',
      payload: queue,
    });
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
  };
};
