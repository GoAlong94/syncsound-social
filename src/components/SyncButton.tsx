import { Volume2, VolumeX } from 'lucide-react';
import { motion } from 'framer-motion';

interface SyncButtonProps {
  onSync: () => void;
  isSynced: boolean;
}

export const SyncButton = ({ onSync, isSynced }: SyncButtonProps) => {
  if (isSynced) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex items-center gap-3 px-6 py-3 rounded-full bg-sync-success/20 border border-sync-success/40"
      >
        <Volume2 className="w-5 h-5 text-sync-success" />
        <span className="text-sync-success font-medium">Audio Synced</span>
      </motion.div>
    );
  }

  return (
    <motion.button
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSync}
      className="relative w-full max-w-md mx-auto group"
    >
      {/* Pulsing ring effect */}
      <div className="absolute inset-0 rounded-2xl bg-primary/30 animate-pulse-ring" />
      <div className="absolute inset-0 rounded-2xl bg-primary/20 animate-pulse-ring [animation-delay:0.5s]" />
      
      {/* Main button */}
      <div className="relative flex flex-col items-center gap-4 px-8 py-8 rounded-2xl bg-gradient-primary glow-primary transition-all duration-300">
        <div className="relative">
          <VolumeX className="w-12 h-12 text-primary-foreground" />
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-sync-warning"
          />
        </div>
        
        <div className="text-center">
          <h3 className="text-xl font-bold text-primary-foreground mb-1">
            TAP TO SYNC & UNMUTE
          </h3>
          <p className="text-sm text-primary-foreground/70">
            Required for audio playback on mobile
          </p>
        </div>
      </div>
    </motion.button>
  );
};
