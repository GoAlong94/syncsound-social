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
  
  const playbackEpochRef = useRef({
    isPlaying: false,
    startNetworkTime: 0,
    startVideoTime: 0,
    videoId: null as string | null
  });

  const ignoreSyncUntilRef = useRef<number>(0);
  const minRttRef = useRef<number>(9999);
  const wakeLockRef = useRef<any>(null);
  const catchupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // --- DEBUG LOGGER ---
  const syncLogs = useRef<any[]>([]);
  const logDebug = useCallback((event: string, data: any) => {
    syncLogs.current.push({
      logTime: new Date().toISOString(),
      role: isHost ? 'HOST' : 'JOINER',
      event,
      deviceInfo: deviceInfo.current,
      ...data
    });
    if (syncLogs.current.length > 2000) syncLogs.current.shift();
  }, [isHost]);

  const downloadLogs = useCallback(() => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(syncLogs.current, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `sync_debug_${isHost ? 'host' : 'joiner'}_${userId.slice(0,5)}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  }, [isHost, userId]);

  const handlersRef = useRef({ getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate });
  useEffect(() => { handlersRef.current = { getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, onVideoChange, onQueueUpdate }; });
  useEffect(() => { latencyRef.current = latency; }, [latency]);
  useEffect(() => { syncStatusRef.current = syncStatus; }, [syncStatus]);

  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        try { wakeLockRef.current = await (navigator as any).wakeLock.request('screen'); } catch (err) {}
      }
    };
    requestWakeLock();
    const handleVis = () => { if (document.visibilityState === 'visible') requestWakeLock(); };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, []);

  const measureLatency = useCallback(() => {
    if (!channelRef.current) return;
    channelRef.current.send({ type: 'broadcast', event: 'ping', payload: { timestamp: Date.now(), senderId: userId } });
  }, [userId]);

  const requestSync = useCallback(() => {
    if (!channelRef.current || isHost) return;
    channelRef.current.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } });
  }, [isHost, userId]);

  const manualResync = useCallback(() => {
    if (isHost) return;
    setSyncStatus('syncing');
    syncStatusRef.current = 'syncing';
    minRttRef.current = 9999; 
    requestSync();
    measureLatency();
  }, [isHost, requestSync, measureLatency]);

  const safeSeek = useCallback((time: number, reason: string) => {
    logDebug('SAFE_SEEK_EXECUTED', { targetTime: time, reason });
    if (catchupTimeoutRef.current) {
      clearTimeout(catchupTimeoutRef.current);
      catchupTimeoutRef.current = null;
    }
    handlersRef.current.seekTo(time);
    handlersRef.current.play(); // Force play after seeking
    ignoreSyncUntilRef.current = Date.now() + 2500; // Allow buffer to settle before evaluating again
  }, [logDebug]);

  useEffect(() => {
    logDebug('ROOM_JOINED', { roomId, userId });
    
    const channel = supabase.channel(`room:${roomId}`, {
      config: { presence: { key: userId }, broadcast: { self: false } },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const devices: PresenceState[] = Object.values(state).flat().map((p: any) => ({
        id: p.id, isHost: p.isHost, joinedAt: p.joinedAt, ping: p.ping, os: p.os || 'Unknown', browser: p.browser || 'Unknown', syncStatus: p.syncStatus || 'unsynced', latency: p.latency || 0, lastSyncDelta: p.lastSyncDelta || 0,
      }));
      setConnectedDevices(devices);
    });

    // 🏆 THE NEW FORWARD-SEEK EXACT-TIME SYNC LOGIC
    channel.on('broadcast', { event: 'sync' }, ({ payload }: { payload: any }) => {
      if (isHost) return;
      
      if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
        requestSync();
        return;
      }

      const networkTime = Date.now() + clockOffsetRef.current;
      let newStatus: SyncStatus = 'synced';

      if (payload.isPlaying) {
        // ONLY bypass drift evaluation if we are actively buffering a previous correction
        if (Date.now() < ignoreSyncUntilRef.current) return;

        let hardwareOffset = 0;
        if (deviceInfo.current.os === 'iOS' || deviceInfo.current.os === 'macOS') hardwareOffset = 0.040; 
        if (deviceInfo.current.os === 'Android') hardwareOffset = 0.080; 

        const expectedVideoTime = payload.startVideoTime + ((networkTime - payload.startNetworkTime) / 1000) - hardwareOffset;
        const localTime = handlersRef.current.getCurrentTime();
        
        const drift = expectedVideoTime - localTime;
        const absDrift = Math.abs(drift);
        setLastSyncDelta(Math.round(absDrift * 1000));

        logDebug('SYNC_EVALUATION', {
          localTime, expectedVideoTime, drift, absDrift, clockOffset: clockOffsetRef.current
        });

        // TIGHT 250ms TOLERANCE
        if (absDrift > 0.25) { 
          if (drift > 0) {
             // 🔴 WE ARE BEHIND: Forward-Seek Compensation
             // We calculate how much time we will lose to the spinning loading wheel.
             // We seek into the future so that when buffering finishes, we land exactly on the Host's time.
             const bufferPenalty = Math.min(Math.max(absDrift, 0.3), 0.8);
             const targetTime = expectedVideoTime + bufferPenalty;
             safeSeek(targetTime, `Forward-Seek: Behind by ${absDrift.toFixed(2)}s`);
          } else {
             // 🟢 WE ARE AHEAD: Pause Catch-up
             // We pause briefly to let the Host time naturally catch up to our local time.
             logDebug('PAUSE_CATCHUP', { reason: `Ahead by ${absDrift.toFixed(2)}s` });
             
             if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
             handlersRef.current.pause();
             
             ignoreSyncUntilRef.current = Date.now() + (absDrift * 1000) + 1500; // Ignore evaluations while catching up
             
             catchupTimeoutRef.current = setTimeout(() => {
                handlersRef.current.play();
                catchupTimeoutRef.current = null;
             }, absDrift * 1000);
          }
          newStatus = 'syncing';
        }

        handlersRef.current.setPlaybackRate(1);

        if (handlersRef.current.getPlayerState() !== 1 && newStatus !== 'syncing') {
          handlersRef.current.play();
        }
      } else {
        // Handle Host Pauses immediately (Bypasses ignoreSync window)
        if (catchupTimeoutRef.current) {
           clearTimeout(catchupTimeoutRef.current);
           catchupTimeoutRef.current = null;
        }
        if (handlersRef.current.getPlayerState() === 1) {
          handlersRef.current.pause();
        }
        const localTime = handlersRef.current.getCurrentTime();
        if (Math.abs(localTime - payload.startVideoTime) > 0.5) {
          handlersRef.current.seekTo(payload.startVideoTime); 
        }
        setLastSyncDelta(0);
      }

      setSyncStatus(newStatus);
      syncStatusRef.current = newStatus;
    });

    channel.on('broadcast', { event: 'sync_request' }, () => {
      if (!isHost) return;
      channel.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
    });

    channel.on('broadcast', { event: 'queue_update' }, ({ payload }) => { if (!isHost && payload) handlersRef.current.onQueueUpdate?.(payload as QueueState); });

    channel.on('broadcast', { event: 'video_change' }, ({ payload }: { payload: any }) => {
      if (!isHost && payload.videoId && payload.videoTitle && payload.videoThumbnail) {
        currentVideoIdRef.current = payload.videoId;
        handlersRef.current.onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
        safeSeek(0, 'New Video Started');
        setSyncStatus('syncing');
        syncStatusRef.current = 'syncing';
      }
    });

    channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
      if (isHost && payload.senderId !== userId) {
        channel.send({ type: 'broadcast', event: 'pong', payload: { timestamp: payload.timestamp, hostTime: Date.now(), targetId: payload.senderId } });
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

        logDebug('PONG_PROCESSED', { rtt, calculatedOffset: offset, appliedOffset: clockOffsetRef.current, accepted: shouldUpdate });
        
        setLatency(rtt);
        latencyRef.current = rtt;
        
        if (shouldUpdate) {
           channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: syncStatusRef.current, latency: rtt, lastSyncDelta: 0 });
        }
      }
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ id: userId, isHost, joinedAt: Date.now(), os: deviceInfo.current.os, browser: deviceInfo.current.browser, syncStatus: isHost ? 'synced' : 'unsynced', latency: 0, lastSyncDelta: 0 });
        if (!isHost) {
          let pings = 0;
          const interval = setInterval(() => {
             if (pings++ < 8) channel.send({ type: 'broadcast', event: 'ping', payload: { timestamp: Date.now(), senderId: userId } });
             else { clearInterval(interval); channel.send({ type: 'broadcast', event: 'sync_request', payload: { senderId: userId } }); }
          }, 400);
        }
      }
    });

    channelRef.current = channel;
    return () => { 
        if (catchupTimeoutRef.current) clearTimeout(catchupTimeoutRef.current);
        channel.unsubscribe(); 
    };
  }, [roomId, userId, isHost, logDebug, safeSeek]);

  useEffect(() => {
    if (!isHost || !channelRef.current) return;
    const interval = setInterval(() => {
      const currentTime = handlersRef.current.getCurrentTime();
      const playerState = handlersRef.current.getPlayerState();
      const networkTime = Date.now() + clockOffsetRef.current;
      const isPlaying = playerState === 1;

      if (isPlaying) {
        const expectedTime = playbackEpochRef.current.startVideoTime + ((networkTime - playbackEpochRef.current.startNetworkTime) / 1000);
        if (!playbackEpochRef.current.isPlaying || Math.abs(expectedTime - currentTime) > 0.5) {
           playbackEpochRef.current = { isPlaying: true, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current };
           logDebug('HOST_EPOCH_UPDATED', playbackEpochRef.current);
        }
      } else {
         if (playbackEpochRef.current.isPlaying || Math.abs(playbackEpochRef.current.startVideoTime - currentTime) > 0.5) {
           playbackEpochRef.current = { isPlaying: false, startNetworkTime: networkTime, startVideoTime: currentTime, videoId: currentVideoIdRef.current };
           logDebug('HOST_EPOCH_UPDATED', playbackEpochRef.current);
         }
      }

      channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current });
    }, 1000);
    return () => clearInterval(interval);
  }, [isHost, logDebug]);

  const broadcastPlay = useCallback(() => { 
    if (!isHost) return;
    playbackEpochRef.current = { isPlaying: true, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current };
    logDebug('HOST_BROADCAST_PLAY', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost, logDebug]);

  const broadcastPause = useCallback(() => { 
    if (!isHost) return;
    playbackEpochRef.current = { isPlaying: false, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current };
    logDebug('HOST_BROADCAST_PAUSE', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost, logDebug]);

  const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
    currentVideoIdRef.current = videoId;
    playbackEpochRef.current = { isPlaying: true, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: 0, videoId };
    logDebug('HOST_BROADCAST_VIDEO_CHANGE', playbackEpochRef.current);
    channelRef.current?.send({ type: 'broadcast', event: 'video_change', payload: { type: 'video_change', videoId, videoTitle: title, videoThumbnail: thumbnail } });
  }, [logDebug]);

  const forceResync = useCallback(() => { 
    if (!isHost || !channelRef.current) return;
    playbackEpochRef.current = { isPlaying: handlersRef.current.getPlayerState() === 1, startNetworkTime: Date.now() + clockOffsetRef.current, startVideoTime: handlersRef.current.getCurrentTime(), videoId: currentVideoIdRef.current };
    channelRef.current.send({ type: 'broadcast', event: 'sync', payload: playbackEpochRef.current }); 
  }, [isHost]);

  const broadcastQueueUpdate = useCallback((queue: QueueState) => { channelRef.current?.send({ type: 'broadcast', event: 'queue_update', payload: queue }); }, []);
  const setCurrentVideoId = useCallback((videoId: string) => { currentVideoIdRef.current = videoId; }, []);

  return {
    connectedDevices, latency, syncStatus, lastSyncDelta, broadcastPlay, broadcastPause, broadcastVideoChange, broadcastQueueUpdate, forceResync, manualResync, measureLatency, downloadLogs,
    deviceInfo: deviceInfo.current, setCurrentVideoId,
  };
};
