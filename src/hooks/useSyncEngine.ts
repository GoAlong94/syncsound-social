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
  const deviceInfo = useRef(getDeviceInfo());
  
  // The "Epoch" state - tracks absolute exact network start time
  const playbackEpochRef = useRef({
    isPlaying: false,
    startNetworkTime: 0,
    startVideoTime: 0,
    videoId: null as string | null
  });

  const ignoreSyncUntilRef = useRef<number>(0);
  const minRttRef = useRef<number>(9999);
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
    channelRef.current.send({
      type: 'broadcast',
      event: 'ping',
      payload: { timestamp: Date.now(), senderId: userId },
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

  const safeSeek = useCallback((time: number) => {
    handlersRef.current.seekTo(time);
    ignoreSyncUntilRef.current = Date.now() + 2500; // Pause sync checks while buffering
  }, []);

  useEffect(() => {
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

    // 🏆 THE NEW EXACT-TIME SYNC LOGIC
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: any }) => {
      if (isHost) return;

      // Ignore updates if we just jumped to let the player buffer
      if (Date.now() < ignoreSyncUntilRef.current) return;

      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      const networkTime = Date.now() + clockOffsetRef.current;
      let newStatus: SyncStatus = 'synced';

      if (payload.isPlaying) {
        // Hardware latency compensators
        let hardwareOffset = 0;
        if (deviceInfo.current.os === 'iOS') hardwareOffset = 0.015; 
        if (deviceInfo.current.os === 'Android') hardwareOffset = 0.040; 

        // Calculate exact target time using the UTC offset
        const expectedVideoTime = payload.startVideoTime + ((networkTime - payload.startNetworkTime) / 1000) - hardwareOffset;
        const localTime = handlersRef.current.getCurrentTime();
        
        const drift = expectedVideoTime - localTime;
        const absDrift = Math.abs(drift);
        setLastSyncDelta(Math.round(absDrift * 1000));

        // If drift exceeds 500ms, jump EXACTLY to the calculated time
        if (absDrift > 0.5) { 
          safeSeek(expectedVideoTime);
          newStatus = 'syncing';
        }

        handlersRef.current.setPlaybackRate(1); // Enforce normal speed

        if (handlersRef.current.getPlayerState() !== 1) {
          handlersRef.current.play();
        }
      } else {
        // Handle Pauses
        if (handlersRef.current.getPlayerState() === 1) {
          handlersRef.current.pause();
        }
        const localTime = handlersRef.current.getCurrentTime();
        if (Math.abs(localTime - payload.startVideoTime) > 0.5) {
          safeSeek(payload.startVideoTime);
        }
        setLastSyncDelta(0);
      }

      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;
    });

    channel.on('broadcast', { event: 'sync_request' }, () => {
      if (!isHost) return;
      channel.send({
        type: 'broadcast',
        event: 'sync',
        payload: playbackEpochRef.current,
      });
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => { 
      if (!isHost && payload) handlersRef.current.onQueueUpdate?.(payload as QueueState); 
    });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: any }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlersRef.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        safeSeek(0);
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.senderId !== userId) {
        channel.send({
          type: 'broadcast',
          event: 'pong',
          payload: { timestamp: payload.timestamp, hostTime: Date.now(), targetId: payload.senderId },
        });
      }
    });

    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      if (!isHost && payload.targetId === userId) {
        const now = Date.now();
        const rtt = now - payload.timestamp;
        const offset = payload.hostTime - payload.timestamp - (rtt / 2);
        
        let shouldUpdate = false;
        if (rtt <= minRttRef.current) {
          minRttRef.current = rtt;
          clockOffsetRef.current = offset; 
          shouldUpdate = true;
        } else if (rtt < minRttRef.current * 1.2) {
          clockOffsetRef.current = clockOffsetRef.current * 0.8 + offset * 0.2;
          shouldUpdate = true;
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
                channel.send({ type: 'broadcast', event: 'ping', payload: { timestamp: Date.now(), senderId: userId } });
             } else {
                clearInterval(interval);
                channel.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } });
             }
          }, 400);
        }
      }
    });

    channelRef.current = channel;

    return () => { channel.unsubscribe(); };
  }, [roomId, userId, isHost]);

  // Host Broadcast Loop: Checks for state/scrub changes and updates the Epoch
  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const currentTime = handlersRef.current.getCurrentTime();
      const playerState = handlersRef.current.getPlayerState();
      const networkTime = Date.now() + clockOffsetRef.current;
      const isPlaying = playerState === 1;

      if (isPlaying) {
        const expectedTime = playbackEpochRef.current.startVideoTime + ((networkTime - playbackEpochRef.current.startNetworkTime) / 1000);
        // If the host scrubbed/skipped, recalculate the exact Start Time Epoch
        if (!playbackEpochRef.current.isPlaying || Math.abs(expectedTime - currentTime) > 0.5) {
           playbackEpochRef.current = {
             isPlaying: true,
             startNetworkTime: networkTime,
             startVideoTime: currentTime,
             videoId: currentVideoIdRef.current
           };
        }
      } else {
         if (playbackEpochRef.current.isPlaying || Math.abs(playbackEpochRef.current.startVideoTime - currentTime) > 0.5) {
           playbackEpochRef.current = {
             isPlaying: false,
             startNetworkTime: networkTime,
             startVideoTime: currentTime,
             videoId: currentVideoIdRef.current
           };
         }
      }

      channelRef.current?.send({
        type: 'broadcast',
        event: 'sync',
        payload: playbackEpochRef.current,
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isHost]);

  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    playbackEpochRef.current = {
      isPlaying: true,
      startNetworkTime: Date.now() + clockOffsetRef.current,
      startVideoTime: handlersRef.current.getCurrentTime(),
      videoId: currentVideoIdRef.current
    };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    playbackEpochRef.current = {
      isPlaying: false,
      startNetworkTime: Date.now() + clockOffsetRef.current,
      startVideoTime: handlersRef.current.getCurrentTime(),
      videoId: currentVideoIdRef.current
    };
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    playbackEpochRef.current = {
      isPlaying: true, 
      startNetworkTime: Date.now() + clockOffsetRef.current,
      startVideoTime: 0,
      videoId
    };
    channelRef.current?.send({
      type: 'broadcast',
      event: 'video_change',
      payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail },
    });
  }, []);

  const forceResync = useCallback(() => { 
    if (!isHost || !channelRef.current) return;
    playbackEpochRef.current = {
      isPlaying: handlersRef.current.getPlayerState() === 1,
      startNetworkTime: Date.now() + clockOffsetRef.current,
      startVideoTime: handlersRef.current.getCurrentTime(),
      videoId: currentVideoIdRef.current
    };
    channelRef.current.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

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
