import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface YouTubeLinkInputProps {
  onAdd: (videoId: string, title: string, thumbnail: string) => void;
}

export const YouTubeLinkInput = ({ onAdd }: YouTubeLinkInputProps) => {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const extractVideoId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };

  const handleAdd = async () => {
    const videoId = extractVideoId(url);
    if (!videoId) {
      toast.error('Invalid YouTube URL');
      return;
    }

    setIsLoading(true);
    try {
      // Fetch metadata using noembed (No API Key required)
      const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
      const data = await response.json();
      
      if (data.error) throw new Error('Video not found');

      const title = data.title || `Video ${videoId}`;
      const thumbnail = data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

      onAdd(videoId, title, thumbnail);
      setUrl('');
      toast.success('Added to queue');
    } catch (error) {
      // Fallback if fetch fails
      onAdd(videoId, `Video ${videoId}`, `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`);
      toast.error('Could not fetch title, but added anyway');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAdd();
    }
  };

  return (
    <div className="flex gap-2">
      <Input
        type="text"
        placeholder="Paste YouTube URL..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        className="bg-white/5 border-white/10 text-white placeholder:text-white/40 focus:border-primary/50"
      />
      <Button 
        onClick={handleAdd}
        disabled={isLoading || !url}
        className="bg-primary hover:bg-primary/90 text-background font-semibold"
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
      </Button>
    </div>
  );
};
