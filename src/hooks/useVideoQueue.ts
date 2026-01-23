import { useState, useCallback } from 'react';
import { QueueItem, QueueState } from '@/types/queue';

const MAX_QUEUE_SIZE = 10;

interface UseVideoQueueProps {
  onVideoChange: (videoId: string, title: string, thumbnail: string) => void;
  broadcastQueueUpdate?: (queue: QueueState) => void;
}

export const useVideoQueue = ({ onVideoChange, broadcastQueueUpdate }: UseVideoQueueProps) => {
  const [queue, setQueue] = useState<QueueState>({
    items: [],
    currentIndex: -1,
  });

  const addToQueue = useCallback((videoId: string, title: string, thumbnail: string) => {
    setQueue((prev) => {
      if (prev.items.length >= MAX_QUEUE_SIZE) {
        return prev; // Queue full
      }

      const newItem: QueueItem = {
        id: crypto.randomUUID(),
        videoId,
        title,
        thumbnail,
        addedAt: Date.now(),
      };

      const newQueue = {
        ...prev,
        items: [...prev.items, newItem],
        // If this is the first item and nothing is playing, start it
        currentIndex: prev.currentIndex === -1 ? 0 : prev.currentIndex,
      };

      // If this is the first item, also trigger video change
      if (prev.currentIndex === -1) {
        onVideoChange(videoId, title, thumbnail);
      }

      broadcastQueueUpdate?.(newQueue);
      return newQueue;
    });
  }, [onVideoChange, broadcastQueueUpdate]);

  const removeFromQueue = useCallback((itemId: string) => {
    setQueue((prev) => {
      const index = prev.items.findIndex((item) => item.id === itemId);
      if (index === -1) return prev;

      const newItems = prev.items.filter((item) => item.id !== itemId);
      let newIndex = prev.currentIndex;

      // Adjust current index if needed
      if (index < prev.currentIndex) {
        newIndex = prev.currentIndex - 1;
      } else if (index === prev.currentIndex) {
        // Current video removed, play next or reset
        if (newItems.length > 0 && newIndex < newItems.length) {
          const nextItem = newItems[newIndex];
          onVideoChange(nextItem.videoId, nextItem.title, nextItem.thumbnail);
        } else if (newItems.length > 0) {
          newIndex = newItems.length - 1;
          const nextItem = newItems[newIndex];
          onVideoChange(nextItem.videoId, nextItem.title, nextItem.thumbnail);
        } else {
          newIndex = -1;
        }
      }

      const newQueue = { items: newItems, currentIndex: newIndex };
      broadcastQueueUpdate?.(newQueue);
      return newQueue;
    });
  }, [onVideoChange, broadcastQueueUpdate]);

  const playNext = useCallback(() => {
    setQueue((prev) => {
      if (prev.currentIndex < prev.items.length - 1) {
        const nextIndex = prev.currentIndex + 1;
        const nextItem = prev.items[nextIndex];
        onVideoChange(nextItem.videoId, nextItem.title, nextItem.thumbnail);
        
        const newQueue = { ...prev, currentIndex: nextIndex };
        broadcastQueueUpdate?.(newQueue);
        return newQueue;
      }
      return prev;
    });
  }, [onVideoChange, broadcastQueueUpdate]);

  const playPrevious = useCallback(() => {
    setQueue((prev) => {
      if (prev.currentIndex > 0) {
        const prevIndex = prev.currentIndex - 1;
        const prevItem = prev.items[prevIndex];
        onVideoChange(prevItem.videoId, prevItem.title, prevItem.thumbnail);
        
        const newQueue = { ...prev, currentIndex: prevIndex };
        broadcastQueueUpdate?.(newQueue);
        return newQueue;
      }
      return prev;
    });
  }, [onVideoChange, broadcastQueueUpdate]);

  const playAtIndex = useCallback((index: number) => {
    setQueue((prev) => {
      if (index >= 0 && index < prev.items.length) {
        const item = prev.items[index];
        onVideoChange(item.videoId, item.title, item.thumbnail);
        
        const newQueue = { ...prev, currentIndex: index };
        broadcastQueueUpdate?.(newQueue);
        return newQueue;
      }
      return prev;
    });
  }, [onVideoChange, broadcastQueueUpdate]);

  const clearQueue = useCallback(() => {
    const newQueue = { items: [], currentIndex: -1 };
    setQueue(newQueue);
    broadcastQueueUpdate?.(newQueue);
  }, [broadcastQueueUpdate]);

  const syncQueue = useCallback((newQueue: QueueState) => {
    setQueue(newQueue);
    // Also load the current video if there is one
    if (newQueue.currentIndex >= 0 && newQueue.items[newQueue.currentIndex]) {
      const currentItem = newQueue.items[newQueue.currentIndex];
      onVideoChange(currentItem.videoId, currentItem.title, currentItem.thumbnail);
    }
  }, [onVideoChange]);

  const moveItem = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => {
      const newItems = [...prev.items];
      const [removed] = newItems.splice(fromIndex, 1);
      newItems.splice(toIndex, 0, removed);

      let newCurrentIndex = prev.currentIndex;
      if (fromIndex === prev.currentIndex) {
        newCurrentIndex = toIndex;
      } else if (fromIndex < prev.currentIndex && toIndex >= prev.currentIndex) {
        newCurrentIndex = prev.currentIndex - 1;
      } else if (fromIndex > prev.currentIndex && toIndex <= prev.currentIndex) {
        newCurrentIndex = prev.currentIndex + 1;
      }

      const newQueue = { items: newItems, currentIndex: newCurrentIndex };
      broadcastQueueUpdate?.(newQueue);
      return newQueue;
    });
  }, [broadcastQueueUpdate]);

  return {
    queue,
    addToQueue,
    removeFromQueue,
    playNext,
    playPrevious,
    playAtIndex,
    clearQueue,
    syncQueue,
    moveItem,
    isQueueFull: queue.items.length >= MAX_QUEUE_SIZE,
    hasNext: queue.currentIndex < queue.items.length - 1,
    hasPrevious: queue.currentIndex > 0,
    currentItem: queue.currentIndex >= 0 ? queue.items[queue.currentIndex] : null,
  };
};
