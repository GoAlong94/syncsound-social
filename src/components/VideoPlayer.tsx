import { useEffect, useRef, useState, useCallback } from 'react';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { Loader2, Music, CheckCircle2, Zap, ShieldAlert, Eye, EyeOff } from 'lucide-react';
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
  onPreloadReady?: (vidId: string) => void;
}

type Deck = 'A' | 'B';

export const VideoPlayer = ({
  videoId, nextVideoId, videoTitle, videoThumbnail, isHost, isPlaying, isSynced, onPlay, onPause, onPlayerReady, onPreloadReady
}: VideoPlayerProps) => {
  
  const [activeDeck, setActiveDeck] = useState<Deck>('A');
  const [preloadedVideo, setPreloadedVideo] = useState<string | null>(null);
  
  // Host defaults to showing video (dataSaver = false). Joiners default to Data Saver (dataSaver = true).
  const [dataSaver, setDataSaver] = useState<boolean>(!isHost); 
  
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

  // Determine if the physical iframes should be hidden
  // We hide them if Data Saver is ON, OR if there is no video loaded yet.
  const shouldHideIframes = dataSaver || !videoId;

  return (
    <div className="flex flex-col gap-3">
      {/* BANDWIDTH ANNIHILATION HACK (1x1 Pixel)
         If shouldHideIframes is true, the actual YouTube iframe is squished to 1px off-screen.
         This prevents the "2 boxes" from bleeding through when the room is empty.
      */}
      <div className={cn(
        "relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10 group transition-all duration-500",
        shouldHideIframes ? "w-[1px] h-[1px] opacity-0 absolute top-[-9999px]" : "w-full aspect-video"
      )}>
        <div className={cn("absolute inset-0 transition-opacity", activeDeck === 'A' ? "opacity-100 z-10" : "opacity-0 -z-10")}>
            <div id="deck-a" className="w-full h-full" />
        </div>
        <div className={cn("absolute inset-0 transition-opacity", activeDeck === 'B' ? "opacity-100 z-10" : "opacity-0 -z-10")}>
            <div id="deck-b" className="w-full h-full" />
        </div>

        {/* Video Info Overlay (Only visible when video is physically showing) */}
        <AnimatePresence>
          {videoTitle && !shouldHideIframes && (
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

      {/* DATA SAVER UI REPLACEMENT */}
      {dataSaver && videoId && (
        <div className="w-full aspect-video bg-zinc-950 rounded-2xl flex flex-col items-center justify-center border border-zinc-800 relative overflow-hidden shadow-2xl ring-1 ring-white/5">
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-green-500/20 via-transparent to-transparent animate-pulse" />
          <ShieldAlert className="w-10 h-10 text-green-500 mb-3 opacity-90 drop-shadow-[0_0_15px_rgba(34,197,94,0.5)]" />
          <h3 className="text-green-500 font-mono text-base tracking-widest font-bold">DATA SAVER ACTIVE</h3>
          <p className="text-zinc-500 text-sm mt-2 font-medium">Video stream disabled (144p Audio-Only)</p>
          
          {videoTitle && (
              <p className="text-zinc-400 text-xs mt-4 max-w-[80%] text-center line-clamp-1 px-4 py-2 bg-zinc-900/50 rounded-lg border border-zinc-800">
                  <Music className="w-3 h-3 inline mr-2 text-zinc-500" />
                  {videoTitle}
              </p>
          )}
        </div>
      )}

      {/* OVERLAY FOR EMPTY STATE (No video playing)
          FIX: Changed from translucent to solid black bg-zinc-950 to hide anything behind it.
      */}
      {!videoId && (
        <div className="w-full aspect-video flex flex-col items-center justify-center bg-zinc-950 rounded-2xl border border-white/10 shadow-2xl z-30">
          <div className="p-6 rounded-full bg-white/5 mb-4 animate-pulse-glow">
              <Music className="w-12 h-12 text-primary" />
          </div>
          <p className="text-xl font-semibold text-white">No video playing</p>
        </div>
      )}
      
      {/* UNIVERSAL TOGGLE CONTROLS (Host & Joiner) */}
      {videoId && (
        <div className="flex justify-end w-full px-2">
           {dataSaver ? (
              <button 
                onClick={() => setDataSaver(false)} 
                className="flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 rounded-lg border border-zinc-800 transition-all"
              >
                <Eye className="w-3.5 h-3.5" /> Show Video (Uses Data)
              </button>
           ) : (
              <button 
                onClick={() => setDataSaver(true)} 
                className="flex items-center gap-2 text-xs font-medium text-green-500 hover:text-green-400 bg-green-500/10 hover:bg-green-500/20 px-3 py-1.5 rounded-lg border border-green-500/20 transition-all"
              >
                <EyeOff className="w-3.5 h-3.5" /> Enable Data Saver
              </button>
           )}
        </div>
      )}
    </div>
  );
};
