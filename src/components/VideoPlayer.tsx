import { useEffect, useRef } from 'react';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { Loader2, Music, WifiOff, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface VideoPlayerProps {
  videoId: string | null;
  videoTitle?: string | null;
  videoThumbnail?: string | null;
  isHost: boolean;
  isPlaying: boolean;
  isSynced: boolean;
  onPlay: () => void;
  onPause: () => void;
  onPlayerReady: (controls: any) => void;
}

export const VideoPlayer = ({
  videoId,
  videoTitle,
  videoThumbnail,
  isHost,
  isPlaying,
  isSynced,
  onPlay,
  onPause,
  onPlayerReady,
}: VideoPlayerProps) => {
  const containerId = 'youtube-player';

  // We pass the "Origin" fix directly here in the hooks options if needed,
  // but we handled it inside the hook itself.
  const { 
    isReady, 
    loadVideo, 
    play, 
    pause, 
    seekTo, 
    getCurrentTime, 
    setPlaybackRate, 
    getPlayerState,
    unmute,
    mute,
    error 
  } = useYouTubePlayer({
    containerId,
    onReady: () => {
      console.log("[VideoPlayer] Ready!");
    },
    onStateChange: (state) => {
      if (state === 1) onPlay();
      if (state === 2) onPause();
    },
  });

  // Expose controls to parent (Room.tsx)
  useEffect(() => {
    if (isReady) {
      onPlayerReady({
        getCurrentTime,
        seekTo,
        setPlaybackRate,
        play,
        pause,
        getPlayerState,
        loadVideo, // Parent can still call this if needed
        unmute,
        mute
      });
    }
  }, [isReady, onPlayerReady, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, loadVideo, unmute, mute]);

  // --- THE FIX: AUTO-LOAD VIDEO ---
  // Watch for videoId changes OR player becoming ready.
  // If we have a videoId and the player is ready, LOAD IT.
  useEffect(() => {
    if (videoId && isReady) {
      console.log(`[VideoPlayer] Auto-loading video: ${videoId}`);
      loadVideo(videoId);
    }
  }, [videoId, isReady, loadVideo]);

  return (
    <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 group">
      {/* YouTube Container */}
      <div id={containerId} className="w-full h-full" />

      {/* Overlay: No Video Selected */}
      {!videoId && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-secondary/30 backdrop-blur-sm z-10">
          <div className="p-6 rounded-full bg-background/10 mb-4 animate-pulse-glow">
            <Music className="w-12 h-12 text-primary" />
          </div>
          <p className="text-xl font-semibold text-white">No video playing</p>
          <p className="text-sm text-white/60 mt-2">
            {isHost ? 'Paste a link to start the party' : 'Waiting for host...'}
          </p>
        </div>
      )}

      {/* Overlay: Error State */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-20">
          <WifiOff className="w-12 h-12 text-destructive mb-4" />
          <p className="text-lg text-destructive font-medium">Video Unavailable</p>
        </div>
      )}

      {/* Overlay: Loading State */}
      {videoId && !isReady && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      )}

      {/* Title Overlay (Bottom) */}
      <AnimatePresence>
        {videoTitle && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none z-10"
          >
            <h3 className="text-lg font-bold text-white line-clamp-1">{videoTitle}</h3>
            {isSynced && !isHost && (
              <div className="flex items-center gap-2 mt-2 text-sync-success text-sm font-medium">
                <CheckCircle2 className="w-4 h-4" />
                Synced with Host
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
