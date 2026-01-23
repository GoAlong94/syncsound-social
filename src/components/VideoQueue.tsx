import { X, Play, ChevronUp, ChevronDown, Music } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QueueItem, QueueState } from '@/types/queue';
import { ScrollArea } from '@/components/ui/scroll-area';

interface VideoQueueProps {
  queue: QueueState;
  onRemove: (id: string) => void;
  onPlay: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  isHost: boolean;
}

export const VideoQueue = ({ queue, onRemove, onPlay, onMove, isHost }: VideoQueueProps) => {
  if (queue.items.length === 0) {
    return (
      <div className="glass rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Music className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">Queue</h3>
          <span className="text-xs text-muted-foreground">(0/10)</span>
        </div>
        <p className="text-sm text-muted-foreground text-center py-4">
          No videos in queue
        </p>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Music className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-medium text-foreground">Queue</h3>
        <span className="text-xs text-muted-foreground">({queue.items.length}/10)</span>
      </div>
      
      <ScrollArea className="h-[200px]">
        <div className="space-y-2 pr-2">
          <AnimatePresence mode="popLayout">
            {queue.items.map((item, index) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${
                  index === queue.currentIndex
                    ? 'bg-primary/20 border border-primary/40'
                    : 'bg-secondary/50 hover:bg-secondary'
                }`}
              >
                {/* Thumbnail */}
                <div className="relative w-12 h-9 rounded overflow-hidden flex-shrink-0">
                  <img
                    src={item.thumbnail}
                    alt={item.title}
                    className="w-full h-full object-cover"
                  />
                  {index === queue.currentIndex && (
                    <div className="absolute inset-0 bg-primary/40 flex items-center justify-center">
                      <Play className="w-4 h-4 text-primary-foreground fill-current" />
                    </div>
                  )}
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {index === queue.currentIndex ? 'Now Playing' : `#${index + 1}`}
                  </p>
                </div>

                {/* Actions */}
                {isHost && (
                  <div className="flex items-center gap-1">
                    {/* Move up */}
                    <button
                      onClick={() => onMove(index, index - 1)}
                      disabled={index === 0}
                      className="p-1 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronUp className="w-3 h-3 text-muted-foreground" />
                    </button>
                    
                    {/* Move down */}
                    <button
                      onClick={() => onMove(index, index + 1)}
                      disabled={index === queue.items.length - 1}
                      className="p-1 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    </button>

                    {/* Play this */}
                    {index !== queue.currentIndex && (
                      <button
                        onClick={() => onPlay(index)}
                        className="p-1 rounded hover:bg-primary/20"
                      >
                        <Play className="w-3 h-3 text-primary" />
                      </button>
                    )}

                    {/* Remove */}
                    <button
                      onClick={() => onRemove(item.id)}
                      className="p-1 rounded hover:bg-destructive/20"
                    >
                      <X className="w-3 h-3 text-destructive" />
                    </button>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </ScrollArea>
    </div>
  );
};
