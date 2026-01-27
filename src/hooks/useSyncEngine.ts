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
  
  // Refs for fresh values in handlers (avoid stale closures)
  const latencyRef = useRef<number>(0);
  // clockOffset = HostTime - LocalTime
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncTimeRef = useRef<number>(0);
  const deviceInfo = useRef(getDeviceInfo());

  // Keep refs in sync with state
  useEffect(() => {
    latencyRef.current = latency;
  }, [latency]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  // Update presence with current sync status
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
      payload: { 
        timestamp: pingTime, 
        senderId: userId 
      },
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
        videoId: currentVideoIdRef.current,
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
    syncStatusRef.current = 'syncing';
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

    // Handle sync broadcasts from host - GRADUATED CORRECTION ALGORITHM
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: SyncMessage & { videoId?: string } }) => {
      if (isHost) return;

      // CORE SYNC LOGIC with Clock Offset Compensation
      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      
      // Time passed since host sent the message (in seconds)
      // hostNow - payload.timestamp gives us the exact flight time + processing time
      // using the synchronized clock timeline
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      
      // One-way delay estimate (half RTT)
      const networkDelay = latencyRef.current / 2000; 
      
      // Calculate where the host is NOW
      const estimatedHostTime = (payload.currentTime || 0) + timeSinceBroadcast;
      const localTime = getCurrentTime();
      
      const drift = estimatedHostTime - localTime;
      const absDrift = Math.abs(drift);
      const diffMs = Math.round(drift * 1000);

      setLastSyncDelta(diffMs);

      // Validate same video - if mismatch, request full sync
      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      // Graduated drift correction algorithm
      let targetRate = 1;
      let newStatus: SyncStatus = 'synced';

      if (absDrift < 0.04) { // 40ms threshold
        // Perfect sync, normal speed
        targetRate = 1;
        newStatus = 'synced';
      } else if (absDrift < 0.1) {
        // 40-100ms: Micro-correction (imperceptible pitch shift)
        targetRate = drift > 0 ? 1.02 : 0.98;
        newStatus = 'syncing';
      } else if (absDrift < 0.5) {
        // 100-500ms: Stronger correction
        targetRate = drift > 0 ? 1.05 : 0.95;
        newStatus = 'syncing';
      } else if (absDrift < 2) {
        // 500ms-2s: Aggressive correction
        targetRate = drift > 0 ? 1.10 : 0.90;
        newStatus = 'syncing';
      } else {
        // > 2s: Hard seek required
        seekTo(estimatedHostTime);
        targetRate = 1;
        newStatus = 'syncing';
      }

      setPlaybackRate(targetRate);
      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;

      // Sync play/pause state
      const localState = getPlayerState();
      if (payload.isPlaying && localState !== 1) {
        play();
      } else if (!payload.isPlaying && localState === 1) {
        pause();
      }

      // Update presence with new sync status
      updatePresence({
        syncStatus: newStatus,
        lastSyncDelta: diffMs,
      });
    });

    // Handle force sync from host
    channel.on('broadcast', { event: 'force_sync' }, ({ payload }) => {
      if (isHost) return;

      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      
      const targetTime = payload.currentTime + timeSinceBroadcast;
      
      // Update video ID if provided
      if (payload.videoId) {
        currentVideoIdRef.current = payload.videoId;
      }
      
      seekTo(targetTime);
      setPlaybackRate(1);
      
      if (payload.isPlaying) {
        play();
      } else {
        pause();
      }
      
      setSyncStatus('syncing');
      syncStatusRef.current = 'syncing';
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
          videoId: currentVideoIdRef.current,
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

    // Handle video change with position sync
    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: SyncMessage }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        
        // Wait for video to load, then seek to host position
        setTimeout(() => {
          if (payload.startTime !== undefined && payload.timestamp) {
            const localNow = Date.now();
            const hostNow = localNow + clockOffsetRef.current;
            const timeSinceBroadcast = Math.max(0, (hostNow - payload.timestamp)) / 1000;
            
            const targetTime = payload.startTime + timeSinceBroadcast;
            seekTo(targetTime);
          }
        }, 1500); // Wait for video load
        
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => {
      if (!isHost && payload) {
        onQueueUpdate?.(payload as QueueState);
      }
    });

    // PING HANDLER (Host side)
    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      // Host responds to ping, adding its own timestamp for clock sync
      if (isHost && payload.senderId !== userId) {
        const hostTime = Date.now();
        channel.send({
          type: 'broadcast',
          event: 'pong',
          payload: { 
            timestamp: payload.timestamp, // Echo client's T0
            hostTime: hostTime,           // Host's T1
            targetId: payload.senderId,   // Ensure only sender processes this
            responderId: userId 
          },
        });
      }
    });

    // PONG HANDLER (Joiner side) - CLOCK SYNC & LATENCY
    channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
      // Only process pongs intended for me
      if (!isHost && payload.targetId === userId) {
        const now = Date.now(); // T3
        const rtt = now - payload.timestamp; // T3 - T0
        
        // NTP Clock Offset Calculation
        // Offset = (HostReceiveTime - ClientSendTime) - (RTT / 2)
        // This assumes symmetric network delay, which is the standard assumption
        const hostTime = payload.hostTime;
        const clientSendTime = payload.timestamp;
        
        // Offset: Add this to LocalTime to get HostTime
        const computedOffset = hostTime - clientSendTime - (rtt / 2);
        
        // Smooth the offset using a moving average to reduce jitter
        const previousOffset = clockOffsetRef.current;
        // If it's the first measurement (offset is 0), take it directly. Otherwise smooth.
        const newOffset = previousOffset === 0 ? computedOffset : (previousOffset * 0.8 + computedOffset * 0.2);
        
        clockOffsetRef.current = newOffset;
        
        setLatency(rtt);
        latencyRef.current = rtt;
        updatePresence({ latency: rtt });
        
        // console.log(`Sync Stats: RTT=${rtt}ms, Offset=${Math.round(newOffset)}ms`);
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
          // Rapid initial ping burst for quick clock convergence
          let pings = 0;
          const initialPingInterval = setInterval(() => {
            if (pings < 5) {
              measureLatency();
              pings++;
            } else {
              clearInterval(initialPingInterval);
              requestSync();
            }
          }, 1000);
        }
      }
    });

    channelRef.current = channel;

    // Handle tab visibility for joiners - immediate resync when returning
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isHost) {
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
        requestSync();
        measureLatency();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      channel.unsubscribe();
    };
  }, [roomId, userId, isHost, getCurrentTime, seekTo, setPlaybackRate, play, pause, onVideoChange, onQueueUpdate, getPlayerState, updatePresence, requestSync, measureLatency]);

  // Host broadcasts current time every 500ms (faster for tighter sync)
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
            videoId: currentVideoIdRef.current,
            isPlaying: playerState === 1,
            timestamp: Date.now(), // Host time
          },
        });
        lastSyncTimeRef.current = currentTime;
      }
    }, 500); // 500ms for tighter sync feedback loop

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
    currentVideoIdRef.current = videoId;
    const currentTime = getCurrentTime();
    
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
  }, [getCurrentTime]);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => {
    channelRef.current?.send({
      type: 'broadcast',
      event: 'queue_update',
      payload: queue,
    });
  }, []);

  // Track video ID when host changes video locally
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
