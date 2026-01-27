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
  startTime?: number;
  timestamp?: number;
  senderId?: string;
  // New fields for robust sync
  targetId?: string;    // To ensure pongs go to the right person
  hostTime?: number;    // The host's system time when receiving a ping
}

export type SyncStatus = 'synced' | 'syncing' | 'unsynced' | 'error';

export interface PresenceState {
  id: string;
  isHost: boolean;
  joinedAt: number;
  ping?: number;
  os: string;
  browser: string;
  syncStatus: SyncStatus;
  latency: number;
  lastSyncDelta: number;
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  duration?: string;
}
