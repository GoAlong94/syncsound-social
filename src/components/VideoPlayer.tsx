import { useEffect, useRef, useState, useCallback } from 'react';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { Loader2, Music, WifiOff, CheckCircle2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface VideoPlayerProps {
  videoId: string | null;
  nextVideoId?: string | null; 
  videoTitle?: string | null;
  videoThumbnail?: string | null;
  isHost: boolean;
  isPlaying: boolean;
  isSynced: boolean;
  onPlay: () => void;
  onPause: () => void;
  onPlayerReady: (controls: any) => void;
}

type Deck = 'A' | 'B';

export const VideoPlayer = ({
  videoId,
  nextVideoId,
  videoTitle,
  videoThumbnail,
  isHost,
  isPlaying,
  isSynced,
  onPlay,
  onPause,
  onPlayerReady,
}: VideoPlayerProps) => {
  
  const [activeDeck, setActiveDeck] = useState<Deck>('A');
  const [preloadedVideo, setPreloadedVideo] = useState<string | null>(null);
  
  const currentVidA = useRef<string | null>(null);
  const currentVidB = useRef<string | null>(null);
  const isPreloadingRef = useRef<boolean>(false);

  const handleStateChange = useCallback((deck: Deck, state: number) => {
    if (deck === activeDeck) {
      if (state === 1) onPlay();
      if (state === 2) onPause();
    }
  }, [activeDeck, onPlay, onPause]);

  const deckA = useYouTubePlayer({
    containerId: 'deck-a',
    onStateChange: (state) => handleStateChange('A', state),
  });

  const deckB = useYouTubePlayer({
    containerId: 'deck-b',
    onStateChange: (state) => handleStateChange('B', state),
  });

  useEffect(() => {
    const activeControls = activeDeck === 'A' ? deckA : deckB;
    if (activeControls.isReady) {
      onPlayerReady({
        getCurrentTime: activeControls.getCurrentTime,
        seekTo: activeControls.seekTo,
        setPlaybackRate: activeControls.setPlaybackRate,
        play: activeControls.play,
        pause: activeControls.pause,
        getPlayerState: activeControls.getPlayerState,
        loadVideo: () => {}, 
        unmute: activeControls.unmute,
        mute: activeControls.mute
      });
    }
  }, [activeDeck, deckA.isReady, deckB.isReady, onPlayerReady]);

  // --- CROSSFADER MAIN LOGIC ---
  useEffect(() => {
    if (!videoId) return;

    if (activeDeck === 'A') {
       if (currentVidB.current === videoId) {
          // Instant RAM Swap
          setActiveDeck('B');
          deckB.seekTo(0);
          deckB.unmute();
          if (isPlaying) deckB.play();
       } else if (currentVidA.current !== videoId) {
          currentVidA.current = videoId;
          deckA.loadVideo(videoId);
          deckA.unmute();
       }
    } else {
       if (currentVidA.current === videoId) {
          // Instant RAM Swap
          setActiveDeck('A');
          deckA.seekTo(0);
          deckA.unmute();
          if (isPlaying) deckA.play();
       } else if (currentVidB.current !== videoId) {
          currentVidB.current = videoId;
          deckB.loadVideo(videoId);
          deckB.unmute();
       }
    }
  }, [videoId]); 

  // --- MOBILE-SAFE PHANTOM PRE-LOADER ---
  useEffect(() => {
    if (!nextVideoId || !deckA.isReady || !deckB.isReady) return;

    const standbyDeck = activeDeck === 'A' ? deckB : deckA;
    const standbyVidRef = activeDeck === 'A' ? currentVidB : currentVidA;

    if (standbyVidRef.current !== nextVideoId && !isPreloadingRef.current) {
        isPreloadingRef.current = true;
        standbyVidRef.current = nextVideoId;
        
        console.log(`[Phantom] Pre-loading ${nextVideoId}`);
        
        // 1. MUST mute first for iOS Safari to allow background play
        standbyDeck.mute(); 
        
        // 2. Add slight delay so the mute registers, then load
        setTimeout(() => {
            standbyDeck.loadVideo(nextVideoId);
            
            // 3. Force play to trigger chunk download
            setTimeout(() => standbyDeck.play(), 500); 
            
            // 4. Give mobile networks a full 8 SECONDS to download the chunk
            setTimeout(() => {
                standbyDeck.pause();
                standbyDeck.seekTo(0);
                setPreloadedVideo(nextVideoId);
                isPreloadingRef.current = false;
                console.log(`[Phantom] Successfully cached ${nextVideoId} in RAM.`);
            }, 8000); 
        }, 100);
    }
  }, [nextVideoId, activeDeck, deckA.isReady, deckB.isReady]);


  return (
    <div className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 group">
      <div className={cn("absolute inset-0 transition-opacity duration-300", activeDeck === 'A' ? "opacity-100 z-10" : "opacity-0 -z-10 pointer-events-none")}>
        <div id="deck-a" className="w-full h-full" />
      </div>
      <div className={cn("absolute inset-0 transition-opacity duration-300", activeDeck === 'B' ? "opacity-100 z-10" : "opacity-0 -z-10 pointer-events-none")}>
        <div id="deck-b" className="w-full h-full" />
      </div>

      {!videoId && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-secondary/30 backdrop-blur-sm z-20">
          <div className="p-6 rounded-full bg-background/10 mb-4 animate-pulse-glow">
            <Music className="w-12 h-12 text-primary" />
          </div>
          <p className="text-xl font-semibold text-white">No video playing</p>
        </div>
      )}

      {videoId && ((activeDeck === 'A' && !deckA.isReady) || (activeDeck === 'B' && !deckB.isReady)) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-20">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      )}

      <AnimatePresence>
        {videoTitle && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent pointer-events-none z-20 flex justify-between items-end"
          >
            <div>
              <h3 className="text-lg font-bold text-white line-clamp-1">{videoTitle}</h3>
              {isSynced && !isHost && (
                <div className="flex items-center gap-2 mt-2 text-sync-success text-sm font-medium">
                  <CheckCircle2 className="w-4 h-4" /> Synced with Host
                </div>
              )}
            </div>
            {preloadedVideo === nextVideoId && nextVideoId && (
               <div className="flex items-center gap-1 text-xs text-blue-400 bg-blue-900/30 px-2 py-1 rounded-md backdrop-blur-md border border-blue-500/20">
                 <Zap className="w-3 h-3 fill-current" /> Next track cached
               </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
