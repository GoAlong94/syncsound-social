export interface Room {
  id: string;
  hostId: string;
  videoId: string | null;
  videoTitle: string | null;
  videoThumbnail: string | null;
  isPlaying: boolean;
  createdAt: number;
}

export interface SyncMessage {
  type: 'sync' | 'play' | 'pause' | 'seek' | 'video_change' | 'ping' | 'pong';
  currentTime?: number;
  isPlaying?: boolean;
  videoId?: string;
  videoTitle?: string;
  videoThumbnail?: string;
  timestamp?: number;
  senderId?: string;
}

export interface PresenceState {
  id: string;
  isHost: boolean;
  joinedAt: number;
  ping?: number;
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  duration?: string;
}
