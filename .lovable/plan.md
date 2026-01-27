

# Sync Perfection - Improvement Plan

## Issues Identified

### Issue 1: REST API Fallback Instead of WebSocket
The console warning indicates Supabase Realtime is falling back to REST API instead of using WebSocket. This introduces 50-200ms additional latency per message, making millisecond-level sync impossible.

### Issue 2: Stale Latency Value in Sync Handler
The `latency` state variable is captured in the effect closure and may not reflect the latest RTT measurement when processing sync messages.

### Issue 3: Missing Video Position on Video Change
When the host changes videos, joiners receive the video ID but not the host's current position, causing initial desync.

### Issue 4: Inefficient Playback Rate Correction
The current approach sets playback rate then uses setTimeout to reset it, which can cause audio stuttering when corrections overlap.

### Issue 5: No Sync Validation
Joiners don't verify they're playing the same video as the host before applying time corrections.

### Issue 6: Host Broadcast Frequency Too Slow
Broadcasting every 1 second allows drift up to 1 second before correction begins.

### Issue 7: No Clock Offset Compensation
Network Time Protocol (NTP)-style clock synchronization is missing. Device clocks may differ by seconds.

---

## Technical Solutions

### Solution 1: Force WebSocket Transport
Modify the Supabase channel configuration to explicitly use WebSocket transport and add connection monitoring.

```text
Location: src/hooks/useSyncEngine.ts

Changes:
- Add explicit WebSocket transport configuration
- Add connection state monitoring
- Implement reconnection logic with exponential backoff
```

### Solution 2: Use Refs for Latency in Sync Handler
Replace state-based latency with a ref to ensure the sync handler always uses the latest value.

```text
Location: src/hooks/useSyncEngine.ts

Changes:
- Create latencyRef = useRef<number>(0)
- Update latencyRef.current in pong handler
- Use latencyRef.current in sync calculation
```

### Solution 3: Include Video Position in Video Change Broadcast
When host changes video, include the current playback position so joiners start at the right time.

```text
Location: src/hooks/useSyncEngine.ts

Changes:
- Add startTime and videoId to sync payloads
- On video_change, include currentTime
- Joiners seek to host position after loading video
```

### Solution 4: Implement Smooth Drift Correction Algorithm
Replace the timeout-based playback rate reset with a continuous correction system that gradually returns to 1.0x.

```text
Location: src/hooks/useSyncEngine.ts

New Algorithm:
1. Calculate drift every sync message (every 500ms instead of 1000ms)
2. Apply graduated playback rate:
   - Drift < 40ms: Rate 1.0 (synced)
   - Drift 40-100ms: Rate 1.02 or 0.98 (micro-correction)
   - Drift 100-500ms: Rate 1.05 or 0.95 (standard correction)
   - Drift 500ms-2s: Rate 1.10 or 0.90 (aggressive correction)
   - Drift > 2s: Hard seek
3. Maintain rate until drift decreases, no timeout reset
```

### Solution 5: Add Video ID Validation
Before applying sync corrections, verify the joiner is playing the same video as the host.

```text
Location: src/hooks/useSyncEngine.ts

Changes:
- Store currentVideoId in ref
- Include videoId in all sync broadcasts
- Skip sync corrections if videoId doesn't match
- Request full sync when videoId mismatch detected
```

### Solution 6: Increase Broadcast Frequency
Change host broadcast from 1000ms to 500ms for tighter sync.

```text
Location: src/hooks/useSyncEngine.ts

Changes:
- Change setInterval from 1000 to 500
- Add throttling to prevent message flooding
```

### Solution 7: Implement Clock Offset Calculation
Calculate the difference between host and joiner device clocks to improve accuracy.

```text
Location: src/hooks/useSyncEngine.ts

New Logic:
- Host sends: { currentTime, timestamp: Date.now() }
- Joiner receives at localTime = Date.now()
- Network delay = latency / 2
- Clock offset = (timestamp + networkDelay) - localTime
- Corrected host time = currentTime + ((Date.now() - timestamp) / 1000) + networkDelay
```

---

## Implementation Details

### File: `src/hooks/useSyncEngine.ts`

**Changes Overview:**

1. Add refs for mutable values used in handlers:
```typescript
const latencyRef = useRef<number>(0);
const currentVideoIdRef = useRef<string | null>(null);
const clockOffsetRef = useRef<number>(0);
```

2. Improve sync message handler with graduated correction:
```typescript
// In sync handler
const networkDelay = latencyRef.current / 2000;
const timeSinceBroadcast = (Date.now() - payload.timestamp) / 1000;
const estimatedHostTime = payload.currentTime + networkDelay + timeSinceBroadcast;
const localTime = getCurrentTime();
const drift = estimatedHostTime - localTime;

// Validate same video
if (payload.videoId && payload.videoId !== currentVideoIdRef.current) {
  requestSync(); // Request full state
  return;
}

// Graduated correction
const absDrift = Math.abs(drift);
let targetRate = 1;

if (absDrift < 0.04) {
  targetRate = 1;
  setSyncStatus('synced');
} else if (absDrift < 0.1) {
  targetRate = drift > 0 ? 1.02 : 0.98;
  setSyncStatus('syncing');
} else if (absDrift < 0.5) {
  targetRate = drift > 0 ? 1.05 : 0.95;
  setSyncStatus('syncing');
} else if (absDrift < 2) {
  targetRate = drift > 0 ? 1.10 : 0.90;
  setSyncStatus('syncing');
} else {
  seekTo(estimatedHostTime);
  targetRate = 1;
  setSyncStatus('syncing');
}

setPlaybackRate(targetRate);
```

3. Enhanced host broadcast with video ID and faster interval:
```typescript
syncIntervalRef.current = setInterval(() => {
  const currentTime = getCurrentTime();
  const playerState = getPlayerState();
  
  channelRef.current?.send({
    type: 'broadcast',
    event: 'sync',
    payload: {
      type: 'sync',
      currentTime,
      videoId: currentVideoIdRef.current,
      isPlaying: playerState === 1,
      timestamp: Date.now(),
    },
  });
}, 500); // Changed from 1000 to 500
```

4. Update video change broadcast to include position:
```typescript
const broadcastVideoChange = useCallback((videoId: string, title: string, thumbnail: string) => {
  currentVideoIdRef.current = videoId;
  const currentTime = getCurrentTime();
  
  channelRef.current?.send({
    type: 'broadcast',
    event: 'video_change',
    payload: {
      type: 'video_change',
      videoId,
      videoTitle: title,
      videoThumbnail: thumbnail,
      startTime: currentTime,
      timestamp: Date.now(),
    },
  });
}, [getCurrentTime]);
```

5. Handle video change with position sync:
```typescript
channel.on('broadcast', { event: 'video_change' }, ({ payload }) => {
  if (!isHost && payload.videoId) {
    currentVideoIdRef.current = payload.videoId;
    onVideoChange?.(payload.videoId, payload.videoTitle, payload.videoThumbnail);
    
    // Wait for video to load, then seek to host position
    setTimeout(() => {
      if (payload.startTime !== undefined) {
        const networkDelay = latencyRef.current / 2000;
        const timeSinceBroadcast = (Date.now() - payload.timestamp) / 1000;
        const targetTime = payload.startTime + networkDelay + timeSinceBroadcast;
        seekTo(targetTime);
      }
    }, 1500); // Wait for video load
    
    setSyncStatus('syncing');
  }
});
```

### File: `src/types/room.ts`

Add videoId to SyncMessage:
```typescript
export interface SyncMessage {
  type: 'sync' | 'play' | 'pause' | 'seek' | 'video_change';
  currentTime?: number;
  isPlaying?: boolean;
  videoId?: string;
  videoTitle?: string;
  videoThumbnail?: string;
  startTime?: number;
  timestamp?: number;
  senderId?: string;
}
```

### File: `src/pages/Room.tsx`

Track current video ID for validation:
```typescript
// Update handleVideoChange to track videoId
const handleVideoChange = useCallback((newVideoId: string, title: string, thumbnail: string) => {
  setVideoId(newVideoId);
  // ... rest of existing logic
}, [isSynced, isHost]);
```

---

## Summary of Changes

| File | Changes |
|------|---------|
| `src/hooks/useSyncEngine.ts` | Refs for latency/videoId, graduated correction algorithm, faster broadcasts, video position in video_change, clock offset calculation |
| `src/types/room.ts` | Add videoId and startTime to SyncMessage interface |
| `src/pages/Room.tsx` | Minor updates to track video state |

---

## Expected Results After Implementation

1. **Tighter sync tolerance** - From 40ms to <40ms consistently
2. **Faster drift correction** - 500ms feedback loop instead of 1000ms
3. **No sudden audio jumps** - Graduated playback rate changes
4. **Instant video change sync** - Joiners seek to host position immediately
5. **Reliable sync validation** - Only correct when on same video
6. **Accurate time estimation** - Account for network delay and clock offset

