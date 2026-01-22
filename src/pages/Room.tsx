import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Crown, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

import { VideoPlayer } from '@/components/VideoPlayer';
import { YouTubeLinkInput } from '@/components/YouTubeLinkInput';
import { SyncButton } from '@/components/SyncButton';
import { DeviceCounter } from '@/components/DeviceCounter';
import { useSyncEngine } from '@/hooks/useSyncEngine';
import { PresenceState } from '@/types/room';

const Room = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isHost = searchParams.get('host') === 'true';
  
  const [userId] = useState(() => crypto.randomUUID());
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState<string | null>(null);
  const [videoThumbnail, setVideoThumbnail] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const playerControlsRef = useRef<{
    getCurrentTime: () => number;
    seekTo: (time: number) => void;
    setPlaybackRate: (rate: number) => void;
    play: () => void;
    pause: () => void;
    getPlayerState: () => number;
    loadVideo: (videoId: string) => void;
    unmute: () => void;
  } | null>(null);

  const handleVideoChange = useCallback((newVideoId: string, title: string, thumbnail: string) => {
    setVideoId(newVideoId);
    setVideoTitle(title);
    setVideoThumbnail(thumbnail);
    if (playerControlsRef.current) {
      playerControlsRef.current.loadVideo(newVideoId);
    }
  }, []);

  const {
    connectedDevices,
    latency,
    broadcastPlay,
    broadcastPause,
    broadcastVideoChange,
  } = useSyncEngine({
    roomId: roomId || '',
    isHost,
    userId,
    getCurrentTime: () => playerControlsRef.current?.getCurrentTime() || 0,
    seekTo: (time) => playerControlsRef.current?.seekTo(time),
    setPlaybackRate: (rate) => playerControlsRef.current?.setPlaybackRate(rate),
    play: () => playerControlsRef.current?.play(),
    pause: () => playerControlsRef.current?.pause(),
    getPlayerState: () => playerControlsRef.current?.getPlayerState() || -1,
    onVideoChange: handleVideoChange,
  });

  const handlePlayerReady = useCallback((controls: typeof playerControlsRef.current) => {
    playerControlsRef.current = controls;
  }, []);

  const handleVideoSelect = useCallback((videoId: string, title: string, thumbnail: string) => {
    setVideoId(videoId);
    setVideoTitle(title);
    setVideoThumbnail(thumbnail);
    broadcastVideoChange(videoId, title, thumbnail);
    // Auto-load and play for host
    if (playerControlsRef.current) {
      playerControlsRef.current.loadVideo(videoId);
    }
  }, [broadcastVideoChange]);

  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    if (isHost) {
      broadcastPlay();
    }
  }, [isHost, broadcastPlay]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
    if (isHost) {
      broadcastPause();
    }
  }, [isHost, broadcastPause]);

  const handleSync = useCallback(() => {
    if (playerControlsRef.current) {
      playerControlsRef.current.play();
      playerControlsRef.current.unmute();
      setIsSynced(true);
      toast.success('Audio synced and unmuted!');
    }
  }, []);

  const copyRoomCode = async () => {
    if (roomId) {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      toast.success('Room code copied!');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shareRoom = async () => {
    const shareUrl = window.location.href.replace('?host=true', '');
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Social Sync party!',
          text: `Join my audio party! Room code: ${roomId}`,
          url: shareUrl,
        });
      } catch (error) {
        // User cancelled share
      }
    } else {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied!');
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-6">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between mb-6"
      >
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
          <span className="hidden sm:inline">Leave Room</span>
        </button>

        <div className="flex items-center gap-3">
          {/* Room Code */}
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl glass">
            {isHost && <Crown className="w-4 h-4 text-sync-warning" />}
            <span className="text-foreground font-mono font-bold tracking-wider">
              {roomId}
            </span>
            <button
              onClick={copyRoomCode}
              className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
            >
              {copied ? (
                <Check className="w-4 h-4 text-sync-success" />
              ) : (
                <Copy className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          </div>

          {/* Share Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={shareRoom}
            className="p-3 rounded-xl bg-primary text-primary-foreground"
          >
            <Share2 className="w-5 h-5" />
          </motion.button>
        </div>
      </motion.header>

      {/* Device Counter */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="flex justify-center mb-6"
      >
        <DeviceCounter devices={connectedDevices} latency={latency} />
      </motion.div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
        {/* Video Player */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="mb-6"
        >
          <VideoPlayer
            videoId={videoId}
            videoTitle={videoTitle}
            videoThumbnail={videoThumbnail}
            isHost={isHost}
            isPlaying={isPlaying}
            isSynced={isSynced}
            onPlay={handlePlay}
            onPause={handlePause}
            onPlayerReady={handlePlayerReady}
          />
        </motion.div>

        {/* Host: Search Bar */}
        {isHost && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mb-6"
          >
            <YouTubeLinkInput onVideoSelect={handleVideoSelect} />
          </motion.div>
        )}

        {/* Joiner: Sync Button */}
        <AnimatePresence>
          {!isHost && videoId && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mt-auto py-8"
            >
              <SyncButton onSync={handleSync} isSynced={isSynced} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Host Instructions */}
        {isHost && !videoId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-8"
          >
            <p className="text-muted-foreground">
              Paste a YouTube link above to start the party.
              <br />
              Share the room code with friends to join!
            </p>
          </motion.div>
        )}

        {/* Joiner Waiting */}
        {!isHost && !videoId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-8"
          >
            <div className="inline-flex items-center gap-3 px-6 py-4 rounded-xl glass">
              <div className="w-3 h-3 rounded-full bg-primary animate-pulse" />
              <span className="text-muted-foreground">
                Waiting for host to select a video...
              </span>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default Room;
