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
  const pendingVideoIdRef = useRef<string | null>(null);

  // 1. SAFE MULTI-INSTANCE API LOADING
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      setIsApiLoaded(true);
      return;
    }

    const handleApiLoaded = () => setIsApiLoaded(true);
    window.addEventListener('youtube-api-ready', handleApiLoaded);

    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
      
      window.onYouTubeIframeAPIReady = () => { 
        window.dispatchEvent(new Event('youtube-api-ready'));
      };
    }

    return () => window.removeEventListener('youtube-api-ready', handleApiLoaded);
  }, []);

  // 2. PLAYER INITIALIZATION
  useEffect(() => {
    if (!isApiLoaded || playerRef.current) return;
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
      playerRef.current = new window.YT.Player(containerId, {
        height: '100%',
        width: '100%',
        host: 'https://www.youtube.com',
        playerVars: {
          playsinline: 1,
          autoplay: 0,
          controls: 0,
          rel: 0,
          modestbranding: 1,
          fs: 0,
          iv_load_policy: 3,
          disablekb: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: any) => {
            setPlayer(event.target);
            setIsReady(true);
            onReady?.();
            
            if (pendingVideoIdRef.current) {
              event.target.loadVideoById(pendingVideoIdRef.current);
              pendingVideoIdRef.current = null;
            }
          },
          onStateChange: (event: any) => { onStateChange?.(event.data); },
          onError: (event: any) => { onError?.(event.data); },
        },
      });
    } catch (e) { console.error("YT Init Error", e); }
  }, [isApiLoaded, containerId, onReady, onStateChange, onError]);

  const loadVideo = useCallback((videoId: string) => {
    if (player && isReady) player.loadVideoById(videoId);
    else pendingVideoIdRef.current = videoId;
  }, [player, isReady]);

  const play = useCallback(() => { if (player && isReady) player.playVideo(); }, [player, isReady]);
  const pause = useCallback(() => { if (player && isReady) player.pauseVideo(); }, [player, isReady]);
  const seekTo = useCallback((seconds: number) => { if (player && isReady) player.seekTo(seconds, true); }, [player, isReady]);
  const getCurrentTime = useCallback((): number => { return (player && isReady && player.getCurrentTime) ? player.getCurrentTime() : 0; }, [player, isReady]);
  const setPlaybackRate = useCallback((rate: number) => { if (player && isReady) player.setPlaybackRate(rate); }, [player, isReady]);
  const unmute = useCallback(() => { if (player && isReady) { player.unMute(); player.setVolume(100); } }, [player, isReady]);
  const mute = useCallback(() => { if (player && isReady) player.mute(); }, [player, isReady]);
  const getPlayerState = useCallback((): number => { return (player && isReady) ? player.getPlayerState() : -1; }, [player, isReady]);

  return { player, isReady, loadVideo, play, pause, seekTo, getCurrentTime, setPlaybackRate, unmute, mute, getPlayerState };
};
