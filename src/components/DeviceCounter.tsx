import { Smartphone, Wifi } from 'lucide-react';
import { motion } from 'framer-motion';
import { PresenceState } from '@/types/room';

interface DeviceCounterProps {
  devices: PresenceState[];
  latency: number;
}

export const DeviceCounter = ({ devices, latency }: DeviceCounterProps) => {
  const hostCount = devices.filter(d => d.isHost).length;
  const joinerCount = devices.filter(d => !d.isHost).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-6 px-5 py-3 rounded-xl glass"
    >
      <div className="flex items-center gap-2">
        <div className="relative">
          <Smartphone className="w-5 h-5 text-primary" />
          <motion.div
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sync-success"
          />
        </div>
        <span className="text-foreground font-medium">
          {devices.length} Device{devices.length !== 1 ? 's' : ''}
        </span>
      </div>
      
      <div className="w-px h-5 bg-border" />
      
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-primary" />
          {hostCount} Host
        </span>
        <span className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-sync-success" />
          {joinerCount} Joiner{joinerCount !== 1 ? 's' : ''}
        </span>
      </div>

      {latency > 0 && (
        <>
          <div className="w-px h-5 bg-border" />
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Wifi className="w-4 h-4" />
            <span>{latency}ms</span>
          </div>
        </>
      )}
    </motion.div>
  );
};
