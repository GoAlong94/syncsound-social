import { useEffect, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { motion } from 'framer-motion';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';

interface VideoPlayerProps {
  videoId: string | null;
  videoTitle: string | null;
  videoThumbnail: string | null;
  isHost: boolean;
  isPlaying: boolean;
  isSynced: boolean;
  onPlay: () => void;
  onPause: () => void;
  onPlayerReady: (controls: {
    getCurrentTime: () => number;
    seekTo: (time: number) => void;
    setPlaybackRate: (rate: number) => void;
    play: () => void;
    pause: () => void;
    getPlayerState: () => number;
    loadVideo: (videoId: string) => void;
    unmute: () => void;
  }) => void;
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
  const [isMuted, setIsMuted] = useState(true);
  const [showControls, setShowControls] = useState(true);

  const handleStateChange = useCallback((state: number) => {
    // YouTube states: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
    if (state === 1) {
      onPlay();
    } else if (state === 2) {
      onPause();
    }
  }, [onPlay, onPause]);

  const {
    isReady,
    loadVideo,
    play,
    pause,
    seekTo,
    getCurrentTime,
    setPlaybackRate,
    unmute,
    mute,
    getPlayerState,
  } = useYouTubePlayer({
    containerId: 'youtube-player',
    onStateChange: handleStateChange,
  });

  useEffect(() => {
    if (isReady) {
      onPlayerReady({
        getCurrentTime,
        seekTo,
        setPlaybackRate,
        play,
        pause,
        getPlayerState,
        loadVideo,
        unmute,
      });
    }
  }, [isReady, getCurrentTime, seekTo, setPlaybackRate, play, pause, getPlayerState, loadVideo, unmute, onPlayerReady]);

  useEffect(() => {
    if (videoId && isReady) {
      loadVideo(videoId);
    }
  }, [videoId, isReady, loadVideo]);

  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
      if (isMuted) {
        unmute();
        setIsMuted(false);
      }
    }
  };

  const handleMuteToggle = () => {
    if (isMuted) {
      unmute();
    } else {
      mute();
    }
    setIsMuted(!isMuted);
  };

  return (
    <div 
      className="relative w-full aspect-video rounded-2xl overflow-hidden bg-secondary"
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      {/* YouTube Player Container */}
      <div id="youtube-player" className="absolute inset-0" />

      {/* Overlay for when no video is selected */}
      {!videoId && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-secondary">
          {videoThumbnail ? (
            <img
              src={videoThumbnail}
              alt={videoTitle || 'Video thumbnail'}
              className="absolute inset-0 w-full h-full object-cover opacity-30"
            />
          ) : null}
          <div className="relative z-10 text-center p-6">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center mb-4 mx-auto">
              <Play className="w-8 h-8 text-primary ml-1" />
            </div>
            <p className="text-muted-foreground">
              {isHost ? 'Search for a song to start the party' : 'Waiting for host to select a song...'}
            </p>
          </div>
        </div>
      )}

      {/* Host Controls Overlay */}
      {videoId && isHost && showControls && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/40 flex items-center justify-center"
        >
          <div className="flex items-center gap-4">
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={handlePlayPause}
              className="w-16 h-16 rounded-full bg-primary flex items-center justify-center glow-primary"
            >
              {isPlaying ? (
                <Pause className="w-7 h-7 text-primary-foreground" />
              ) : (
                <Play className="w-7 h-7 text-primary-foreground ml-1" />
              )}
            </motion.button>
            
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={handleMuteToggle}
              className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center"
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5 text-foreground" />
              ) : (
                <Volume2 className="w-5 h-5 text-foreground" />
              )}
            </motion.button>
          </div>
        </motion.div>
      )}

      {/* Video Info Bar */}
      {videoTitle && (
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
          <h3 className="text-foreground font-medium truncate">{videoTitle}</h3>
        </div>
      )}

      {/* Sync Status Indicator */}
      {!isHost && (
        <div className="absolute top-4 right-4">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
            isSynced 
              ? 'bg-sync-success/20 text-sync-success' 
              : 'bg-sync-warning/20 text-sync-warning'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              isSynced ? 'bg-sync-success' : 'bg-sync-warning animate-pulse'
            }`} />
            {isSynced ? 'Synced' : 'Syncing...'}
          </div>
        </div>
      )}
    </div>
  );
};
