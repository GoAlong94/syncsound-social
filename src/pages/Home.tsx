import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Users, ArrowRight, Zap, Radio, Smartphone } from 'lucide-react';
import { motion } from 'framer-motion';
import { Input } from '@/components/ui/input';

const Home = () => {
  const navigate = useNavigate();
  const [roomId, setRoomId] = useState('');

  const generateRoomId = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  };

  const handleStartParty = useCallback(() => {
    const newRoomId = generateRoomId();
    navigate(`/room/${newRoomId}?host=true`);
  }, [navigate]);

  const handleJoinParty = useCallback(() => {
    if (roomId.trim()) {
      navigate(`/room/${roomId.toUpperCase()}`);
    }
  }, [navigate, roomId]);

  const features = [
    {
      icon: Radio,
      title: 'Perfect Sync',
      description: 'Millisecond-level audio synchronization across all devices',
    },
    {
      icon: Smartphone,
      title: 'Multi-Device',
      description: 'Turn every phone into a synchronized speaker',
    },
    {
      icon: Zap,
      title: 'Zero Latency',
      description: 'Smart calibration compensates for network delays',
    },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      {/* Background Effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-primary/5 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-lg mx-auto">
        {/* Logo & Title */}
        <motion.div
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <motion.div
            animate={{ rotate: [0, 5, -5, 0] }}
            transition={{ duration: 4, repeat: Infinity }}
            className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/20 mb-6 glow-primary"
          >
            <Sparkles className="w-10 h-10 text-primary" />
          </motion.div>
          
          <h1 className="text-4xl md:text-5xl font-bold mb-3">
            <span className="text-gradient">Social Sync</span>
          </h1>
          <p className="text-muted-foreground text-lg">
            YouTube Audio Party
          </p>
        </motion.div>

        {/* Action Cards */}
        <div className="space-y-4 mb-12">
          {/* Start Party */}
          <motion.button
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            whileHover={{ scale: 1.02, x: 5 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleStartParty}
            className="w-full group"
          >
            <div className="relative p-6 rounded-2xl bg-gradient-primary glow-primary overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
              <div className="relative flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary-foreground/20 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-primary-foreground" />
                  </div>
                  <div className="text-left">
                    <h2 className="text-xl font-bold text-primary-foreground">
                      Start Party
                    </h2>
                    <p className="text-primary-foreground/70 text-sm">
                      Create a new room as host
                    </p>
                  </div>
                </div>
                <ArrowRight className="w-6 h-6 text-primary-foreground group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </motion.button>

          {/* Join Party */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="p-6 rounded-2xl glass"
          >
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">
                  Join Party
                </h2>
                <p className="text-muted-foreground text-sm">
                  Enter a room code to join
                </p>
              </div>
            </div>
            
            <div className="flex gap-3">
              <Input
                type="text"
                placeholder="Room Code"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinParty()}
                maxLength={6}
                className="flex-1 bg-secondary border-border text-center text-lg tracking-widest uppercase font-mono"
              />
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleJoinParty}
                disabled={!roomId.trim()}
                className="px-6 rounded-xl bg-primary text-primary-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Join
              </motion.button>
            </div>
          </motion.div>
        </div>

        {/* Features */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="grid grid-cols-3 gap-4"
        >
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 + index * 0.1 }}
              className="text-center p-4"
            >
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center mx-auto mb-3">
                <feature.icon className="w-5 h-5 text-primary" />
              </div>
              <h3 className="text-sm font-medium text-foreground mb-1">
                {feature.title}
              </h3>
              <p className="text-xs text-muted-foreground">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  );
};

export default Home;
