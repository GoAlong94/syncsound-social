import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { SyncMessage, PresenceState } from '@/types/room';
import { RealtimeChannel } from '@supabase/supabase-js';

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
}: UseSyncEngineProps) => {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<PresenceState[]>([]);
  const [latency, setLatency] = useState<number>(0);
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncTimeRef = useRef<number>(0);

  // Calculate latency via ping/pong
  const measureLatency = useCallback(() => {
    if (!channelRef.current || !isHost) return;

    const pingTime = Date.now();
    channelRef.current.send({
      type: 'broadcast',
      event: 'ping',
      payload: { timestamp: pingTime, senderId: userId },
    });
  }, [isHost, userId]);

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
        }));
      setConnectedDevices(devices);
    });

    // Handle broadcast messages
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage }) => {
      if (isHost) return; // Host doesn't sync to itself

      const hostTime = payload.currentTime || 0;
      const localTime = getCurrentTime();
      const diff = hostTime - localTime;

      // Smooth sync: adjust playback rate if diff > 40ms
      if (Math.abs(diff) > 0.04) {
        if (Math.abs(diff) > 2) {
          // Large desync: jump to position
          seekTo(hostTime + (latency / 2000)); // Account for half RTT
        } else {
          // Small desync: adjust playback rate
          const rate = diff > 0 ? 1.05 : 0.95;
          setPlaybackRate(rate);
          // Reset rate after correction
          setTimeout(() => setPlaybackRate(1), Math.abs(diff) * 1000);
        }
      }
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
      }
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (!isHost && payload.senderId !== userId) {
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
      }
    });

    // Subscribe and track presence
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          id: userId,
          isHost,
          joinedAt: Date.now(),
        });
      }
    });

    channelRef.current = channel;

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost, getCurrentTime, seekTo, setPlaybackRate, play, pause, latency, onVideoChange]);

  // Host broadcasts current time every second
  useEffect(() => {
    if (!isHost || !channelRef.current) return;

    syncIntervalRef.current = setInterval(() => {
      const currentTime = getCurrentTime();
      if (currentTime !== lastSyncTimeRef.current) {
        channelRef.current?.send({
          type: 'broadcast',
          event: 'sync',
          payload: {
            type: 'sync',
            currentTime,
            timestamp: Date.now(),
          },
        });
        lastSyncTimeRef.current = currentTime;
      }
    }, 1000);

    // Also measure latency periodically
    const latencyInterval = setInterval(measureLatency, 5000);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      clearInterval(latencyInterval);
    };
  }, [isHost, getCurrentTime, measureLatency]);

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

  return {
    connectedDevices,
    latency,
    broadcastPlay,
    broadcastPause,
    broadcastVideoChange,
  };
};
