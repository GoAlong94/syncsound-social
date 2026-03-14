import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Music, Users, Sparkles, ArrowRight, QrCode } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DOMAIN_URL = "https://syncsound.lovable.app";

const Home = () => {
  const [roomId, setRoomId] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const navigate = useNavigate();

  const handleCreateRoom = () => {
    const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    navigate(`/room/${newRoomId}?host=true`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      setIsJoining(true);
      setTimeout(() => {
        navigate(`/room/${roomId.toUpperCase()}`);
      }, 500);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Gradients */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[128px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-[128px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="z-10 w-full max-w-md space-y-8"
      >
        <div className="text-center space-y-4">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", bounce: 0.5 }}
            className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-primary/20 border border-primary/20"
          >
            <Music className="w-10 h-10 text-primary" />
          </motion.div>
          <h1 className="text-5xl font-black tracking-tight text-white drop-shadow-md">
            Sync<span className="text-primary">Sound</span>
          </h1>
          <p className="text-lg text-muted-foreground font-medium">
            Flawless synchronized playback across all devices.
          </p>
        </div>

        <div className="glass p-8 rounded-3xl shadow-2xl space-y-6 border border-white/5 relative">
          
          <Button
            onClick={handleCreateRoom}
            className="w-full h-14 text-lg font-semibold rounded-2xl group transition-all duration-300 hover:shadow-primary/25 hover:shadow-xl"
            size="lg"
          >
            <Sparkles className="w-5 h-5 mr-2 group-hover:rotate-12 transition-transform" />
            Start a Party
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[#0f1115] px-4 text-muted-foreground font-semibold tracking-wider">
                Or join existing
              </span>
            </div>
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-4">
            <Input
              type="text"
              placeholder="Enter Room Code"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="h-14 text-center text-2xl font-mono tracking-[0.2em] uppercase bg-black/50 border-white/10 focus:border-primary/50 rounded-2xl"
              maxLength={6}
            />
            <Button
              type="submit"
              variant="secondary"
              className="w-full h-14 text-lg font-semibold rounded-2xl group transition-all"
              disabled={roomId.length < 3 || isJoining}
            >
              {isJoining ? (
                "Connecting..."
              ) : (
                <>
                  <Users className="w-5 h-5 mr-2" />
                  Join Room
                  <ArrowRight className="w-5 h-5 ml-2 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </>
              )}
            </Button>
          </form>
        </div>

        {/* QR CODE QUICK SCAN PORTAL */}
        <div className="flex flex-col items-center justify-center mt-8">
           <button 
              onClick={() => setShowQr(!showQr)}
              className="flex items-center gap-2 text-sm text-zinc-500 hover:text-white transition-colors"
           >
              <QrCode className="w-4 h-4" />
              {showQr ? "Hide QR Code" : "Show Quick-Scan QR"}
           </button>
           
           <AnimatePresence>
             {showQr && (
                <motion.div 
                   initial={{ opacity: 0, height: 0 }}
                   animate={{ opacity: 1, height: 'auto' }}
                   exit={{ opacity: 0, height: 0 }}
                   className="mt-6 flex flex-col items-center bg-white p-4 rounded-2xl shadow-2xl"
                >
                   <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(DOMAIN_URL)}`} 
                      alt="Scan to join"
                      className="w-32 h-32"
                   />
                   <p className="text-black font-bold mt-2 text-xs uppercase tracking-widest">Scan to Open</p>
                </motion.div>
             )}
           </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
};

export default Home;
