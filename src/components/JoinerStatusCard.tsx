import { Wifi, RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { SyncStatus } from '@/types/room';
import { getOsIcon, getBrowserIcon } from '@/utils/deviceInfo';
import { Button } from '@/components/ui/button';

interface JoinerStatusCardProps {
  os: string;
  browser: string;
  latency: number;
  syncStatus: SyncStatus;
  lastSyncDelta: number;
  onResync: () => void;
}

const getStatusInfo = (status: SyncStatus, delta: number) => {
  if (status === 'synced' || Math.abs(delta) < 40) {
    return {
      icon: CheckCircle,
      color: 'text-sync-success',
      bg: 'bg-sync-success/20',
      border: 'border-sync-success/40',
      label: 'Synced',
    };
  }
  if (status === 'syncing' || Math.abs(delta) < 500) {
    return {
      icon: Loader2,
      color: 'text-sync-warning',
      bg: 'bg-sync-warning/20',
      border: 'border-sync-warning/40',
      label: 'Syncing',
    };
  }
  return {
    icon: AlertCircle,
    color: 'text-destructive',
    bg: 'bg-destructive/20',
    border: 'border-destructive/40',
    label: 'Out of Sync',
  };
};

export const JoinerStatusCard = ({
  os,
  browser,
  latency,
  syncStatus,
  lastSyncDelta,
  onResync,
}: JoinerStatusCardProps) => {
  const statusInfo = getStatusInfo(syncStatus, lastSyncDelta);
  const StatusIcon = statusInfo.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">Your Device</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onResync}
          className="h-7 px-2 text-xs"
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Re-sync
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Device Info */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span>{getOsIcon(os)}</span>
            <span className="text-muted-foreground">{os}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span>{getBrowserIcon(browser)}</span>
            <span className="text-muted-foreground">{browser}</span>
          </div>
        </div>

        {/* Status Info */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Wifi className="w-4 h-4 text-primary" />
            <span className="text-muted-foreground">{latency}ms</span>
          </div>
          <div
            className={`flex items-center gap-2 px-2 py-1 rounded-lg ${statusInfo.bg} ${statusInfo.border} border`}
          >
            <StatusIcon
              className={`w-4 h-4 ${statusInfo.color} ${
                syncStatus === 'syncing' ? 'animate-spin' : ''
              }`}
            />
            <span className={`text-sm font-medium ${statusInfo.color}`}>
              {statusInfo.label}
            </span>
          </div>
        </div>
      </div>

      {/* Drift indicator */}
      {syncStatus !== 'unsynced' && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Drift from host:</span>
            <span
              className={`font-mono ${
                Math.abs(lastSyncDelta) < 40
                  ? 'text-sync-success'
                  : Math.abs(lastSyncDelta) < 500
                  ? 'text-sync-warning'
                  : 'text-destructive'
              }`}
            >
              {lastSyncDelta >= 0 ? '+' : ''}
              {lastSyncDelta}ms
            </span>
          </div>
          
          {/* Visual drift bar */}
          <div className="mt-2 h-1.5 bg-secondary rounded-full overflow-hidden">
            <motion.div
              className={`h-full ${
                Math.abs(lastSyncDelta) < 40
                  ? 'bg-sync-success'
                  : Math.abs(lastSyncDelta) < 500
                  ? 'bg-sync-warning'
                  : 'bg-destructive'
              }`}
              initial={{ width: '50%' }}
              animate={{
                width: `${Math.max(5, Math.min(95, 50 + (lastSyncDelta / 20)))}%`,
              }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>Behind</span>
            <span>Ahead</span>
          </div>
        </div>
      )}
    </motion.div>
  );
};
