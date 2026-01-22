import { useState } from 'react';
import { Link, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';

interface YouTubeLinkInputProps {
  onVideoSelect: (videoId: string, title: string, thumbnail: string) => void;
}

// Extract video ID from various YouTube URL formats
const extractVideoId = (url: string): string | null => {
  const patterns = [
    // Standard YouTube URLs
    /(?:youtube\.com\/watch\?v=|youtube\.com\/watch\?.+&v=)([^&]+)/,
    // Short YouTube URLs
    /(?:youtu\.be\/)([^?&]+)/,
    // Embedded URLs
    /(?:youtube\.com\/embed\/)([^?&]+)/,
    // YouTube Music URLs
    /(?:music\.youtube\.com\/watch\?v=)([^&]+)/,
    // Mobile URLs
    /(?:m\.youtube\.com\/watch\?v=)([^&]+)/,
    // Direct video ID (11 characters)
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
};

export const YouTubeLinkInput = ({ onVideoSelect }: YouTubeLinkInputProps) => {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async () => {
    if (!url.trim()) {
      setError('Please paste a YouTube link');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(false);

    const videoId = extractVideoId(url.trim());

    if (!videoId) {
      setError('Invalid YouTube link. Please paste a valid YouTube URL.');
      setIsLoading(false);
      return;
    }

    // Generate thumbnail and basic title from video ID
    const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    const title = `YouTube Video (${videoId})`;

    // Simulate brief loading for UX
    await new Promise(resolve => setTimeout(resolve, 300));

    onVideoSelect(videoId, title, thumbnail);
    setSuccess(true);
    setIsLoading(false);
    
    // Clear input after successful load
    setTimeout(() => {
      setUrl('');
      setSuccess(false);
    }, 1500);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const pastedText = e.clipboardData.getData('text');
    setUrl(pastedText);
    
    // Auto-submit on paste if it looks like a valid URL
    if (pastedText.includes('youtube') || pastedText.includes('youtu.be')) {
      setTimeout(() => {
        const videoId = extractVideoId(pastedText.trim());
        if (videoId) {
          const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
          const title = `YouTube Video (${videoId})`;
          onVideoSelect(videoId, title, thumbnail);
          setSuccess(true);
          setTimeout(() => {
            setUrl('');
            setSuccess(false);
          }, 1500);
        }
      }, 100);
    }
  };

  return (
    <div className="w-full space-y-2">
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Link className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Paste YouTube link here..."
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="pl-12 pr-4 py-6 bg-secondary border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
          />
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleSubmit}
          disabled={isLoading}
          className="px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
        >
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : success ? (
            <CheckCircle className="w-5 h-5" />
          ) : (
            'Load'
          )}
        </motion.button>
      </div>

      {/* Error message */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 text-sm text-destructive"
        >
          <AlertCircle className="w-4 h-4" />
          {error}
        </motion.div>
      )}

      {/* Success message */}
      {success && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 text-sm text-sync-success"
        >
          <CheckCircle className="w-4 h-4" />
          Video loaded! Starting playback...
        </motion.div>
      )}
    </div>
  );
};
