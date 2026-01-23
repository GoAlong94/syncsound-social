export interface QueueItem {
  id: string;
  videoId: string;
  title: string;
  thumbnail: string;
  addedAt: number;
}

export interface QueueState {
  items: QueueItem[];
  currentIndex: number;
}
