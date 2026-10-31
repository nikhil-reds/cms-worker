import type { PlaylistPlaybackItem } from './scheduler-db.service';

interface SensorTriggerBase {
  id: string;
  sensorId: string;
  name: string;
  serialPort?: string;
  targetPlaylistItemId: string;
  cooldownMs: number;
  debounceMs: number;
  enabled: boolean;
  sensorEnabled: boolean;
  connectionEnabled: boolean;
  x: number;
  y: number;
}

export interface GpioSensorTrigger extends SensorTriggerBase {
  transport: 'gpio';
  port: string;
  operator: 'equals';
  value: boolean;
}

export interface SerialMessageSensorTrigger extends SensorTriggerBase {
  transport: 'serial-message';
  serialPort: string;
  matchMode: 'exact';
  matchValue: string;
}

export type SensorTrigger = GpioSensorTrigger | SerialMessageSensorTrigger;

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
  matchMode?: string | null;
  matchValue?: string | null;
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
  const usedConditions = new Set<string>();
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
    if (row.connectionType !== 'gpio' || row.operator !== 'equals' ||
      !row.sensorName.trim() || !Number.isFinite(row.x) || !Number.isFinite(row.y)) {
      throw new Error(`${label}: unsupported sensor condition`);
    }
    const isMessage = row.matchMode != null || row.matchValue != null;
    if (isMessage) {
      if (row.matchMode !== 'exact' || typeof row.matchValue !== 'string' ||
        row.matchValue !== row.matchValue.trim() || !/^[\x20-\x7E]{1,128}$/.test(row.matchValue) ||
        !row.serialPort || row.port != null || row.expectedValue != null) {
        throw new Error(`${label}: unsupported serial message condition`);
      }
    } else if (!/^(?:[2-9]|1\d|2[0-7])$/.test(row.port ?? '') ||
      typeof row.expectedValue !== 'boolean') {
      throw new Error(`${label}: unsupported GPIO condition`);
    }
    if (!Number.isInteger(row.cooldownMs) || row.cooldownMs < 0 || row.cooldownMs > 600000 ||
      !Number.isInteger(row.debounceMs) || row.debounceMs < 0 || row.debounceMs > 60000) {
      throw new Error(`${label}: invalid cooldown or debounce`);
    }
    if (usedSensors.has(row.sensorId)) throw new Error(`${label}: sensor has multiple targets`);
    usedSensors.add(row.sensorId);
    const controllerPort = row.serialPort && /^COM/i.test(row.serialPort) ? row.serialPort.toUpperCase() : row.serialPort;
    const condition = isMessage
      ? `message:${controllerPort}:${row.matchValue}`
      : `gpio:${row.port}`;
    if (usedConditions.has(condition)) throw new Error(`${label}: duplicate sensor condition`);
    usedConditions.add(condition);
    const target = playable.get(row.targetPlaylistItemId);
    if (!target || target.type !== 'video' || !target.url) {
      throw new Error(`${label}: target video ${row.targetPlaylistItemId} is not READY and downloadable`);
    }
    const common = {
      id: row.id,
      sensorId: row.sensorId,
      name: row.sensorName,
      ...(row.serialPort ? { serialPort: row.serialPort } : {}),
      targetPlaylistItemId: row.targetPlaylistItemId,
      cooldownMs: row.cooldownMs,
      debounceMs: row.debounceMs,
      enabled: Boolean(row.sensorEnabled && row.edgeEnabled),
      sensorEnabled: Boolean(row.sensorEnabled),
      connectionEnabled: Boolean(row.edgeEnabled),
      x: row.x,
      y: row.y,
    };
    triggers.push(isMessage
      ? { ...common, transport: 'serial-message', serialPort: row.serialPort!, matchMode: 'exact', matchValue: row.matchValue! }
      : { ...common, transport: 'gpio', port: row.port!, operator: 'equals', value: row.expectedValue as boolean });
  }

  const activePorts = new Set(triggers.filter(trigger => trigger.enabled && trigger.serialPort).map(trigger => trigger.serialPort));
  if (activePorts.size > 1) throw new Error(`Playlist ${playlistId}: use one controller serial port per playlist`);
  return triggers.sort((a, b) => a.id.localeCompare(b.id));
}
