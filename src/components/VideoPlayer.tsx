import { useEffect, useRef, useState, useCallback } from 'react';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { Loader2, Music, CheckCircle2, Zap, ShieldAlert } from 'lucide-react';
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
  onPreloadReady?: (vidId: string) => void; // Tell Convoy we have it in RAM
}

type Deck = 'A' | 'B';

export const VideoPlayer = ({
  videoId, nextVideoId, videoTitle, videoThumbnail, isHost, isPlaying, isSynced, onPlay, onPause, onPlayerReady, onPreloadReady
}: VideoPlayerProps) => {
  
  const [activeDeck, setActiveDeck] = useState<Deck>('A');
  const [preloadedVideo, setPreloadedVideo] = useState<string | null>(null);
  const [dataSaver, setDataSaver] = useState<boolean>(!isHost); // Joiners default to Audio-Only
  
  const currentVidA = useRef<string | null>(null);
  const currentVidB = useRef<string | null>(null);
  const isPreloadingRef = useRef<boolean>(false);

  const handleStateChange = useCallback((deck: Deck, state: number) => {
    if (deck === activeDeck) {
      if (state === 1) onPlay();
      if (state === 2) onPause();
    }
  }, [activeDeck, onPlay, onPause]);

  const deckA = useYouTubePlayer({ containerId: 'deck-a', onStateChange: (state) => handleStateChange('A', state) });
  const deckB = useYouTubePlayer({ containerId: 'deck-b', onStateChange: (state) => handleStateChange('B', state) });

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

  // PHASE 1: DUAL-DECK CROSSFADER
  useEffect(() => {
    if (!videoId) return;
    const isA = activeDeck === 'A';
    const activeRef = isA ? currentVidA : currentVidB;
    const inactiveRef = isA ? currentVidB : currentVidA;
    const actDeck = isA ? deckA : deckB;
    const inactDeck = isA ? deckB : deckA;

    if (inactiveRef.current === videoId) {
        // INSTANT RAM SWAP
        setActiveDeck(isA ? 'B' : 'A');
        inactDeck.seekTo(0);
        inactDeck.unmute();
        if (isPlaying) inactDeck.play();
    } else if (activeRef.current !== videoId) {
        // UNPLANNED TRACK
        activeRef.current = videoId;
        actDeck.loadVideo(videoId);
        actDeck.unmute();
    }
  }, [videoId]); 

  // PHASE 1: MOBILE-SAFE PHANTOM PRE-LOADER
  useEffect(() => {
    if (!nextVideoId || !deckA.isReady || !deckB.isReady) return;

    const standbyDeck = activeDeck === 'A' ? deckB : deckA;
    const standbyVidRef = activeDeck === 'A' ? currentVidB : currentVidA;

    if (standbyVidRef.current !== nextVideoId && !isPreloadingRef.current) {
        isPreloadingRef.current = true;
        standbyVidRef.current = nextVideoId;
        
        standbyDeck.mute(); 
        setTimeout(() => {
            standbyDeck.loadVideo(nextVideoId);
            setTimeout(() => standbyDeck.play(), 500); 
            setTimeout(() => {
                standbyDeck.pause();
                standbyDeck.seekTo(0);
                setPreloadedVideo(nextVideoId);
                isPreloadingRef.current = false;
                onPreloadReady?.(nextVideoId); // Fire Convoy Ready Packet
            }, 8000); 
        }, 100);
    }
  }, [nextVideoId, activeDeck, deckA.isReady, deckB.isReady]);

  return (
    <div className="flex flex-col gap-2">
      {/* BANDWIDTH ANNIHILATION HACK */}
      <div className={cn(
        "relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 group",
        dataSaver ? "w-[1px] h-[1px] opacity-1 absolute top-[-9999px]" : "w-full aspect-video"
      )}>
        <div className={cn("absolute inset-0 transition-opacity", activeDeck === 'A' ? "opacity-100 z-10" : "opacity-0 -z-10")}><div id="deck-a" className="w-full h-full" /></div>
        <div className={cn("absolute inset-0 transition-opacity", activeDeck === 'B' ? "opacity-100 z-10" : "opacity-0 -z-10")}><div id="deck-b" className="w-full h-full" /></div>
      </div>

      {/* DATA SAVER UI REPLACEMENT */}
      {dataSaver && videoId && (
        <div className="w-full aspect-video bg-zinc-900 rounded-2xl flex flex-col items-center justify-center border border-zinc-800 relative overflow-hidden">
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-green-500/20 via-transparent to-transparent animate-pulse" />
          <ShieldAlert className="w-8 h-8 text-green-500 mb-2 opacity-80" />
          <h3 className="text-green-500 font-mono text-sm tracking-widest font-bold">DATA SAVER ACTIVE</h3>
          <p className="text-zinc-500 text-xs mt-1">Video hidden (144p Audio-Only)</p>
          <button onClick={() => setDataSaver(false)} className="mt-4 px-3 py-1 bg-zinc-800 rounded-md text-xs text-zinc-300 hover:bg-zinc-700 transition">Show Video</button>
        </div>
      )}

      {/* Overlays */}
      {!videoId && (
        <div className="w-full aspect-video flex flex-col items-center justify-center bg-secondary/30 backdrop-blur-sm rounded-2xl ring-1 ring-white/10">
          <div className="p-6 rounded-full bg-background/10 mb-4 animate-pulse-glow"><Music className="w-12 h-12 text-primary" /></div>
          <p className="text-xl font-semibold text-white">No video playing</p>
        </div>
      )}
      
      {!dataSaver && videoId && (
        <div className="flex justify-end w-full px-2">
           <button onClick={() => setDataSaver(true)} className="text-xs text-zinc-500 hover:text-white transition">Enable Data Saver</button>
        </div>
      )}
    </div>
  );
};
