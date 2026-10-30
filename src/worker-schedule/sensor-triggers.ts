import type { PlaylistPlaybackItem } from './scheduler-db.service';

export interface SensorTrigger {
  id: string;
  sensorId: string;
  name: string;
  transport: 'gpio';
  port: string;
  serialPort?: string;
  operator: 'equals';
  value: boolean;
  targetPlaylistItemId: string;
  cooldownMs: number;
  debounceMs: number;
  enabled: boolean;
  sensorEnabled: boolean;
  connectionEnabled: boolean;
  x: number;
  y: number;
}

export interface SensorFlowRow {
  id: string | null;
  playlistId: string;
  edgePlaylistId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  sensorId: string | null;
  sensorPlaylistId: string | null;
  sensorKind: string | null;
  sensorName: string;
  x: number;
  y: number;
  connectionType: string | null;
  port: string | null;
  serialPort?: string | null;
  operator: string | null;
  expectedValue: unknown;
  sensorEnabled: boolean | null;
  targetPlaylistId: string | null;
  targetKind: string | null;
  targetPlaylistItemId: string | null;
  itemPlaylistId: string | null;
  cooldownMs: number;
  debounceMs: number;
  edgeEnabled: boolean;
}

export function mapSensorTriggers(
  playlistId: string,
  rows: SensorFlowRow[],
  items: PlaylistPlaybackItem[],
): SensorTrigger[] {
  const playable = new Map(items.map((item) => [item.id, item]));
  const usedSensors = new Set<string>();
  const triggers: SensorTrigger[] = [];

  for (const row of rows) {
    const label = `Playlist ${playlistId}, sensor ${row.sensorId}, edge ${row.id ?? 'missing'}`;
    if (row.playlistId !== playlistId || row.edgePlaylistId !== playlistId ||
      row.sensorPlaylistId !== playlistId ||
      row.targetPlaylistId !== playlistId || row.itemPlaylistId !== playlistId ||
      row.sensorKind !== 'SENSOR' || row.targetKind !== 'MEDIA' ||
      !row.id || !row.sensorId || row.sourceNodeId !== row.sensorId ||
      !row.targetNodeId || !row.targetPlaylistItemId) {
      throw new Error(`${label}: invalid or cross-playlist flow link`);
    }
    if (row.serialPort != null && (!/^(?:COM[1-9]\d*|\/dev\/[A-Za-z0-9_./:-]+)$/i.test(row.serialPort) || row.serialPort.includes('..'))) throw new Error('Invalid sensor serial port');
    if (row.connectionType !== 'gpio' || !/^(?:[2-9]|1\d|2[0-7])$/.test(row.port ?? '') ||
      row.operator !== 'equals' || typeof row.expectedValue !== 'boolean' ||
      !row.sensorName.trim() || !Number.isFinite(row.x) || !Number.isFinite(row.y)) {
      throw new Error(`${label}: unsupported GPIO condition`);
    }
    if (!Number.isInteger(row.cooldownMs) || row.cooldownMs < 0 || row.cooldownMs > 600000 ||
      !Number.isInteger(row.debounceMs) || row.debounceMs < 0 || row.debounceMs > 60000) {
      throw new Error(`${label}: invalid cooldown or debounce`);
    }
    if (usedSensors.has(row.sensorId)) throw new Error(`${label}: sensor has multiple targets`);
    usedSensors.add(row.sensorId);
    const target = playable.get(row.targetPlaylistItemId);
    if (!target || target.type !== 'video' || !target.url) {
      throw new Error(`${label}: target video ${row.targetPlaylistItemId} is not READY and downloadable`);
    }
    triggers.push({
      id: row.id,
      sensorId: row.sensorId,
      name: row.sensorName,
      transport: 'gpio',
      port: row.port!,
      ...(row.serialPort ? { serialPort: row.serialPort } : {}),
      operator: 'equals',
      value: row.expectedValue,
      targetPlaylistItemId: row.targetPlaylistItemId,
      cooldownMs: row.cooldownMs,
      debounceMs: row.debounceMs,
      enabled: Boolean(row.sensorEnabled && row.edgeEnabled),
      sensorEnabled: Boolean(row.sensorEnabled),
      connectionEnabled: Boolean(row.edgeEnabled),
      x: row.x,
      y: row.y,
    });
  }

  return triggers.sort((a, b) => a.id.localeCompare(b.id));
}
