import { useState, useEffect, useCallback, useRef } from 'react';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export interface UseYouTubePlayerProps {
  containerId: string;
  onReady?: () => void;
  onStateChange?: (state: number) => void;
  onError?: (error: any) => void;
}

export const useYouTubePlayer = ({
  containerId,
  onReady,
  onStateChange,
  onError,
}: UseYouTubePlayerProps) => {
  const [player, setPlayer] = useState<any>(null);
  const [isReady, setIsReady] = useState(false);
  const [isApiLoaded, setIsApiLoaded] = useState(false);
  const playerRef = useRef<any>(null);
  
  // FIX 1: Remember the video we wanted to play if player wasn't ready yet
  const pendingVideoIdRef = useRef<string | null>(null);

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      setIsApiLoaded(true);
      return;
    }

    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (existingScript) {
      window.onYouTubeIframeAPIReady = () => setIsApiLoaded(true);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      setIsApiLoaded(true);
    };
  }, []);

  // Initialize player when API is ready
  useEffect(() => {
    if (!isApiLoaded || playerRef.current) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    playerRef.current = new window.YT.Player(containerId, {
      height: '100%',
      width: '100%',
      // FIX 2: Add 'host' parameter
      host: 'https://www.youtube.com', 
      playerVars: {
        playsinline: 1,
        autoplay: 0, // We handle autoplay manually to avoid race conditions
        controls: 0,
        rel: 0,
        modestbranding: 1,
        fs: 0,
        iv_load_policy: 3,
        disablekb: 1,
        // FIX 3: Add 'origin' to fix postMessage security error
        origin: window.location.origin, 
      },
      events: {
        onReady: (event: any) => {
          setPlayer(event.target);
          setIsReady(true);
          onReady?.();
          
          // FIX 4: Play the pending video if one was queued while loading
          if (pendingVideoIdRef.current) {
            event.target.loadVideoById(pendingVideoIdRef.current);
            pendingVideoIdRef.current = null;
          }
        },
        onStateChange: (event: any) => {
          onStateChange?.(event.data);
        },
        onError: (event: any) => {
          onError?.(event.data);
        },
      },
    });

    return () => {
      // Cleanup logic if needed (usually safe to leave YT instance)
    };
  }, [isApiLoaded, containerId, onReady, onStateChange, onError]);

  const loadVideo = useCallback((videoId: string) => {
    if (player && isReady) {
      player.loadVideoById(videoId);
    } else {
      // If player isn't ready, queue this video to play immediately when ready
      pendingVideoIdRef.current = videoId;
    }
  }, [player, isReady]);

  const play = useCallback(() => {
    if (player && isReady) {
      player.playVideo();
    }
  }, [player, isReady]);

  const pause = useCallback(() => {
    if (player && isReady) {
      player.pauseVideo();
    }
  }, [player, isReady]);

  const seekTo = useCallback((seconds: number) => {
    if (player && isReady) {
      player.seekTo(seconds, true);
    }
  }, [player, isReady]);

  const getCurrentTime = useCallback((): number => {
    if (player && isReady && typeof player.getCurrentTime === 'function') {
      return player.getCurrentTime();
    }
    return 0;
  }, [player, isReady]);

  const setPlaybackRate = useCallback((rate: number) => {
    if (player && isReady) {
      player.setPlaybackRate(rate);
    }
  }, [player, isReady]);

  const unmute = useCallback(() => {
    if (player && isReady) {
      player.unMute();
      player.setVolume(100);
    }
  }, [player, isReady]);

  const mute = useCallback(() => {
    if (player && isReady) {
      player.mute();
    }
  }, [player, isReady]);

  const getPlayerState = useCallback((): number => {
    if (player && isReady && typeof player.getPlayerState === 'function') {
      return player.getPlayerState();
    }
    return -1;
  }, [player, isReady]);

  return {
    player,
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
  };
};
