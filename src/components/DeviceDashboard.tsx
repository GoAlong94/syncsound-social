import { RefreshCw, Zap, Smartphone, Crown } from 'lucide-react';
import { motion } from 'framer-motion';
import { PresenceState } from '@/types/room';
import { getOsIcon, getBrowserIcon } from '@/utils/deviceInfo';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

interface DeviceDashboardProps {
  devices: PresenceState[];
  currentUserId: string;
  onForceResync: () => void;
  onRefreshPing: () => void;
}

const getSyncStatusColor = (status: string, delta: number): string => {
  if (status === 'synced' || Math.abs(delta) < 40) return 'text-sync-success';
  if (status === 'syncing' || Math.abs(delta) < 500) return 'text-sync-warning';
  return 'text-destructive';
};

const getSyncStatusDot = (status: string, delta: number): string => {
  if (status === 'synced' || Math.abs(delta) < 40) return 'bg-sync-success';
  if (status === 'syncing' || Math.abs(delta) < 500) return 'bg-sync-warning';
  return 'bg-destructive';
};

export const DeviceDashboard = ({
  devices,
  currentUserId,
  onForceResync,
  onRefreshPing,
}: DeviceDashboardProps) => {
  const sortedDevices = [...devices].sort((a, b) => {
    // Host first
    if (a.isHost && !b.isHost) return -1;
    if (!a.isHost && b.isHost) return 1;
    // Then by join time
    return a.joinedAt - b.joinedAt;
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass rounded-xl p-4"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">Connected Devices</h3>
          <span className="text-xs text-muted-foreground">({devices.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefreshPing}
            className="h-8 px-2"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Ping
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onForceResync}
            className="h-8 px-2"
          >
            <Zap className="w-3 h-3 mr-1" />
            Force Resync
          </Button>
        </div>
      </div>

      <div className="rounded-lg overflow-hidden border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="text-xs">Device</TableHead>
              <TableHead className="text-xs">OS</TableHead>
              <TableHead className="text-xs">Browser</TableHead>
              <TableHead className="text-xs text-right">Latency</TableHead>
              <TableHead className="text-xs text-center">Status</TableHead>
              <TableHead className="text-xs text-right">Drift</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedDevices.map((device, index) => (
              <TableRow key={device.id} className="text-xs">
                <TableCell className="py-2">
                  <div className="flex items-center gap-2">
                    {device.isHost && (
                      <Crown className="w-3 h-3 text-sync-warning" />
                    )}
                    <span className="font-medium">
                      {device.id === currentUserId
                        ? 'You'
                        : device.isHost
                        ? 'Host'
                        : `Device ${index + 1}`}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-2">
                  <span className="flex items-center gap-1">
                    {getOsIcon(device.os)} {device.os}
                  </span>
                </TableCell>
                <TableCell className="py-2">
                  <span className="flex items-center gap-1">
                    {getBrowserIcon(device.browser)} {device.browser}
                  </span>
                </TableCell>
                <TableCell className="py-2 text-right">
                  {device.isHost ? '—' : `${device.latency}ms`}
                </TableCell>
                <TableCell className="py-2">
                  <div className="flex items-center justify-center gap-1.5">
                    <div
                      className={`w-2 h-2 rounded-full ${getSyncStatusDot(
                        device.syncStatus,
                        device.lastSyncDelta
                      )}`}
                    />
                    <span
                      className={getSyncStatusColor(
                        device.syncStatus,
                        device.lastSyncDelta
                      )}
                    >
                      {device.isHost
                        ? 'Host'
                        : device.syncStatus === 'synced'
                        ? 'Synced'
                        : device.syncStatus === 'syncing'
                        ? 'Syncing'
                        : 'Unsynced'}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-2 text-right">
                  {device.isHost ? (
                    '—'
                  ) : (
                    <span
                      className={getSyncStatusColor(
                        device.syncStatus,
                        device.lastSyncDelta
                      )}
                    >
                      {device.lastSyncDelta >= 0 ? '+' : ''}
                      {device.lastSyncDelta}ms
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </motion.div>
  );
};
