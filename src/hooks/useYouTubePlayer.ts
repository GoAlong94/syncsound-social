import { useEffect, useRef, useState, useCallback } from 'react';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

interface UseYouTubePlayerProps {
  videoId: string | null;
  elementId: string;
  onReady?: (event: any) => void;
  onStateChange?: (event: any) => void;
  playerVars?: any;
}

export const useYouTubePlayer = ({
  videoId,
  elementId,
  onReady,
  onStateChange,
  playerVars,
}: UseYouTubePlayerProps) => {
  const playerRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load YouTube API script
  useEffect(() => {
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

      window.onYouTubeIframeAPIReady = () => {
        setIsReady(true);
      };
    } else {
      setIsReady(true);
    }
  }, []);

  // Initialize Player
  useEffect(() => {
    if (!isReady || !videoId || playerRef.current) return;

    try {
      playerRef.current = new window.YT.Player(elementId, {
        videoId,
        // THE FIX IS HERE: 'origin' must match your domain
        host: 'https://www.youtube.com',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin, // <--- CRITICAL FIX
          enablejsapi: 1,
          ...playerVars,
        },
        events: {
          onReady: (event: any) => {
            onReady?.(event);
          },
          onStateChange: (event: any) => {
            onStateChange?.(event);
          },
          onError: (event: any) => {
            console.error('YouTube Player Error:', event.data);
            setError('Video playback error');
          }
        },
      });
    } catch (err) {
      console.error("Failed to init player", err);
    }

    return () => {
      // Cleanup is tricky with YouTube API, usually best to leave instance
      // or destroy if really navigating away
    };
  }, [isReady, elementId, onReady, onStateChange, playerVars]);

  // Handle Video ID changes
  useEffect(() => {
    if (playerRef.current && playerRef.current.loadVideoById && videoId) {
      playerRef.current.loadVideoById({
        videoId,
        startSeconds: 0,
      });
    }
  }, [videoId]);

  // Expose controls
  const controls = {
    play: () => playerRef.current?.playVideo(),
    pause: () => playerRef.current?.pauseVideo(),
    seekTo: (seconds: number) => playerRef.current?.seekTo(seconds, true),
    getCurrentTime: () => {
      // Safety check: if player isn't ready, return 0 to prevent crashes
      return playerRef.current && typeof playerRef.current.getCurrentTime === 'function' 
        ? playerRef.current.getCurrentTime() 
        : 0;
    },
    getPlayerState: () => {
      return playerRef.current && typeof playerRef.current.getPlayerState === 'function'
        ? playerRef.current.getPlayerState()
        : -1;
    },
    setPlaybackRate: (rate: number) => playerRef.current?.setPlaybackRate(rate),
    getDuration: () => playerRef.current?.getDuration() || 0,
    loadVideo: (id: string) => playerRef.current?.loadVideoById(id),
    unmute: () => playerRef.current?.unMute(),
    mute: () => playerRef.current?.mute(),
  };

  return { player: playerRef.current, ...controls, error };
};
