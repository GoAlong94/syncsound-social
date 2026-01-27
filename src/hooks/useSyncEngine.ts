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
  
  // REFS
  const latencyRef = useRef<number>(0);
  const clockOffsetRef = useRef<number>(0); 
  const currentVideoIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>('unsynced');
  const lastSyncTimeRef = useRef<number>(0);
  const deviceInfo = useRef(getDeviceInfo());
  
  // MOBILE FIX 1: Lowest RTT tracking (The "Best Connection" Filter)
  // On mobile, latency spikes are common. We only trust the Lowest RTT.
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

  // MOBILE FIX 2: Request Wake Lock
  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        try {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
          console.log('Wake Lock active!');
        } catch (err) {
          console.log('Wake Lock rejected:', err);
        }
      }
    };
    requestWakeLock();
    // Re-request on visibility change (tabs drop wake lock when hidden)
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
    // Reset MinRTT on manual resync to allow fresh calibration
    minRttRef.current = 9999; 
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  // --- MAIN EFFECT ---
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

      const localNow = Date.now();
      const hostNow = localNow + clockOffsetRef.current;
      
      // MOBILE FIX 3: Hardware Offset
      // Android/iOS often process audio slower. We subtract a buffer.
      let hardwareOffset = 0;
      if (deviceInfo.current.os === 'iOS') hardwareOffset = 0.015; // 15ms
      if (deviceInfo.current.os === 'Android') hardwareOffset = 0.040; // 40ms

      const timeSinceBroadcast = Math.max(0, (hostNow - (payload.timestamp || 0))) / 1000;
      
      // Estimated Host Time adjusted for Hardware Latency
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

      // Aggressive catch-up for Mobile
      if (absDrift < 0.05) { 
        targetRate = 1;
        newStatus = 'synced';
      } else if (absDrift < 0.15) { 
        // 50ms-150ms: Micro-correct
        targetRate = drift > 0 ? 1.02 : 0.98;
        newStatus = 'syncing';
      } else if (absDrift < 0.8) { 
        // 150ms-800ms: Strong correct
        targetRate = drift > 0 ? 1.08 : 0.92;
        newStatus = 'syncing';
      } else {
        // > 800ms: Jump
        handlersRef.current.seekTo(estimatedHostTime);
        targetRate = 1;
        newStatus = 'syncing';
      }

      handlersRef.current.setPlaybackRate(targetRate);
      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;

      // Force play/pause state
      const localState = handlersRef.current.getPlayerState();
      if (payload.isPlaying && localState !== 1) handlersRef.current.play();
      else if (!payload.isPlaying && localState === 1) handlersRef.current.pause();
    });

    // ... (Force Sync, Video Change handlers - same as before) ...
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
            handlersRef.current.seekTo(targetTime);
          }
        }, 1500);
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    // PING/PONG logic
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
        
        // MOBILE LOGIC: Only update if this is a "good" ping (Low RTT)
        // If RTT is 300ms, it's garbage (jitter). If 50ms, it's gold.
        
        let shouldUpdate = false;

        // If this is our best RTT yet (or close to it), trust it 100%
        if (rtt <= minRttRef.current) {
          minRttRef.current = rtt;
          clockOffsetRef.current = offset; // Snap directly to best sample
          shouldUpdate = true;
          console.log(`[Clock] New Best RTT: ${rtt}ms. Offset updated to ${Math.round(offset)}ms`);
        } 
        // If RTT is within 20% of our best, smooth it in
        else if (rtt < minRttRef.current * 1.2) {
          const prev = clockOffsetRef.current;
          clockOffsetRef.current = prev * 0.8 + offset * 0.2;
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
          // Burst pings for initial clock sync
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 8) { // More pings for mobile to find a "lucky" low-latency packet
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

  // ... (broadcast methods same as before)
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
