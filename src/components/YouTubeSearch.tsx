import { useState } from 'react';
import { Search, Music, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Input } from '@/components/ui/input';
import { YouTubeSearchResult } from '@/types/room';

interface YouTubeSearchProps {
  onVideoSelect: (video: YouTubeSearchResult) => void;
}

// Mock search function - in production, you'd use YouTube Data API
const mockSearch = async (query: string): Promise<YouTubeSearchResult[]> => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 800));
  
  // Return mock results based on query
  const mockResults: YouTubeSearchResult[] = [
    {
      videoId: 'dQw4w9WgXcQ',
      title: `${query} - Best Mix`,
      thumbnail: `https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg`,
      channelTitle: 'Music Channel',
      duration: '3:32',
    },
    {
      videoId: 'jNQXAC9IVRw',
      title: `${query} - Top Hits`,
      thumbnail: `https://img.youtube.com/vi/jNQXAC9IVRw/mqdefault.jpg`,
      channelTitle: 'Top Charts',
      duration: '4:15',
    },
    {
      videoId: '9bZkp7q19f0',
      title: `${query} - Party Mix`,
      thumbnail: `https://img.youtube.com/vi/9bZkp7q19f0/mqdefault.jpg`,
      channelTitle: 'Party Hits',
      duration: '5:01',
    },
  ];
  
  return mockResults;
};

export const YouTubeSearch = ({ onVideoSelect }: YouTubeSearchProps) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    
    setIsSearching(true);
    setShowResults(true);
    
    try {
      const searchResults = await mockSearch(query);
      setResults(searchResults);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelect = (video: YouTubeSearchResult) => {
    onVideoSelect(video);
    setShowResults(false);
    setQuery('');
    setResults([]);
  };

  return (
    <div className="relative w-full">
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search for music..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-12 pr-4 py-6 bg-secondary border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
          />
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleSearch}
          disabled={isSearching}
          className="px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isSearching ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            'Search'
          )}
        </motion.button>
      </div>

      <AnimatePresence>
        {showResults && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute top-full left-0 right-0 mt-2 rounded-xl glass overflow-hidden z-50"
          >
            {isSearching ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : results.length > 0 ? (
              <div className="max-h-80 overflow-y-auto">
                {results.map((video, index) => (
                  <motion.button
                    key={video.videoId}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.1 }}
                    onClick={() => handleSelect(video)}
                    className="w-full flex items-center gap-4 p-4 hover:bg-secondary/50 transition-colors text-left"
                  >
                    <div className="relative w-24 h-16 rounded-lg overflow-hidden flex-shrink-0">
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="w-full h-full object-cover"
                      />
                      {video.duration && (
                        <span className="absolute bottom-1 right-1 px-1.5 py-0.5 text-xs bg-black/80 rounded">
                          {video.duration}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-foreground truncate">
                        {video.title}
                      </h4>
                      <p className="text-sm text-muted-foreground truncate">
                        {video.channelTitle}
                      </p>
                    </div>
                    <Music className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                  </motion.button>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                No results found
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
