import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createLogger } from '../common/logger';
import { mapSensorTriggers, type SensorFlowRow, type SensorTrigger } from './sensor-triggers';

const logger = createLogger('SchedulerDbService');

export interface ActiveCalendar {
  id: string;
  name: string;
  playlistId: string;
  priority: number;
}

export interface PublishedSchedule {
  id: string;
  name: string;
  playlistId: string;
  priority: number;
  startAt: Date;
  endAt: Date;
  daysOfWeek: number[];
}

export interface TargetDevice {
  id: string;
  name: string;
  tenantId: string;
}

export interface AuthenticatedPlayerDevice {
  id: string;
  tenantId: string;
}

export interface PlaylistPlaybackItem {
  id: string;
  mediaId?: string;
  mediaVersion?: string;
  sha256?: string;
  sizeBytes?: number;
  type: 'video' | 'image' | 'audio' | 'html';
  zoneId?: string;
  x?: number;
  y?: number;
  src: string;
  url?: string;
  sourceType?: 'upload' | 'external_url';
  fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  width?: number;
  height?: number;
  durationMs?: number;
  navigationPolicy?: 'same_origin' | 'allowlist' | 'allow_all';
  reloadPolicy?: 'on_each_play' | 'once_per_playlist' | 'interval' | 'never';
}

export interface PlaylistZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaylistPlaybackManifest {
  playlistId: string;
  canvas: { width: number; height: number };
  zones: PlaylistZone[];
  items: PlaylistPlaybackItem[];
  sensorTriggers: SensorTrigger[];
}

/**
 * Query the CMS database for active calendars: those whose time window
 * (start_time / end_time / days_of_week) includes NOW, sorted by priority.
 */
@Injectable()
export class SchedulerDbService {
  private pool: Pool;
  private closed = false;

  constructor(databaseUrl: string, private readonly mediaCdnBaseUrl = '') {
    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'cms-worker-scheduler',
      max: 2,
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    logger.info('Database connection successful');
  }

  /**
   * Find the highest-priority calendar that's active RIGHT NOW.
   * Active = status='ACTIVE' + current time in [start_time, end_time] +
   * current day-of-week in days_of_week array.
   */
  async getActiveCalendar(): Promise<ActiveCalendar | null> {
    const query = `
      SELECT
        c.id,
        c.name,
        c.playlist_id     AS "playlistId",
        c.priority
      FROM calendars c
      WHERE c.status = 'ACTIVE'
        AND NOW() >= c.start_time
        AND NOW() < c.end_time
        AND EXTRACT(DOW FROM NOW())::int = ANY(c.days_of_week)
      ORDER BY c.priority DESC
      LIMIT 1
    `;

    const result = await this.pool.query(query);
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async getPlaylistPlaybackItems(playlistId: string): Promise<PlaylistPlaybackItem[]> {
    return (await this.getPlaylistPlaybackManifest(playlistId)).items;
  }

  async getPlaylistPlaybackManifest(playlistId: string): Promise<PlaylistPlaybackManifest> {
    const playlistResult = await this.pool.query(
      `
      SELECT
        id,
        display_width AS "displayWidth",
        display_height AS "displayHeight",
        zones_json AS "zonesJson"
      FROM playlists
      WHERE id = $1
      `,
      [playlistId],
    );
    const playlist = playlistResult.rows[0];
    const canvas = {
      width: Number(playlist?.displayWidth) || 1920,
      height: Number(playlist?.displayHeight) || 1080,
    };
    const zones = this.normalizeZones(playlist?.zonesJson, canvas);
    const zoneMap = new Map(zones.map((zone) => [zone.id, zone]));

    const query = `
      SELECT
        pi.id AS "id",
        pi.media_id AS "mediaId",
        pi.duration_sec AS "durationSec",
        pi.fit,
        pi.object_position AS "position",
        COALESCE(pi.zone_id, 'full-screen') AS "zoneId",
        m.filename,
        m.cdn_url AS "cdnUrl",
        m.s3_key AS "s3Key",
        m.size_bytes AS "sizeBytes",
        m.updated_at AS "mediaUpdatedAt",
        COALESCE(m.source_type, 'upload') AS "sourceType",
        m.external_url AS "externalUrl",
        m.width,
        m.height,
        mt.name AS "mediaTypeName"
      FROM playlist_items pi
      JOIN media m ON m.id = pi.media_id
      LEFT JOIN media_types mt ON mt.id = m.media_type_id
      WHERE pi.playlist_id = $1
        AND m.status = 'READY'
      ORDER BY pi.position ASC
    `;

    const result = await this.pool.query(query, [playlistId]);
    const items = result.rows.map((row) =>
      this.mapPlaybackItem(row, zoneMap, zones[0]),
    );

    const flowResult = await this.pool.query(`
      SELECT
        e.id,
        s.playlist_id AS "playlistId",
        e.playlist_id AS "edgePlaylistId",
        e.source_node_id AS "sourceNodeId",
        e.target_node_id AS "targetNodeId",
        s.id AS "sensorId",
        s.playlist_id AS "sensorPlaylistId",
        s.kind AS "sensorKind",
        s.name AS "sensorName",
        s.x,
        s.y,
        s.connection_type AS "connectionType",
        s.port,
        to_jsonb(s)->>'serial_port' AS "serialPort",
        s.operator,
        s.expected_value AS "expectedValue",
        to_jsonb(s)->>'match_mode' AS "matchMode",
        to_jsonb(s)->>'match_value' AS "matchValue",
        s.enabled AS "sensorEnabled",
        t.playlist_id AS "targetPlaylistId",
        t.kind AS "targetKind",
        t.playlist_item_id AS "targetPlaylistItemId",
        pi.playlist_id AS "itemPlaylistId",
        e.cooldown_ms AS "cooldownMs",
        e.debounce_ms AS "debounceMs",
        e.enabled AS "edgeEnabled"
      FROM playlist_flow_nodes s
      LEFT JOIN playlist_flow_edges e ON e.source_node_id = s.id
      LEFT JOIN playlist_flow_nodes t ON t.id = e.target_node_id
      LEFT JOIN playlist_items pi ON pi.id = t.playlist_item_id
      WHERE s.playlist_id = $1 AND s.kind = 'SENSOR'
      ORDER BY e.id
    `, [playlistId]);
    const sensorTriggers = mapSensorTriggers(playlistId, flowResult.rows as SensorFlowRow[], items);

    return {
      playlistId,
      canvas,
      zones,
      items,
      sensorTriggers,
    };
  }

  /**
   * Screens the worker publishes manifests for: devices that actually have a
   * player installed. Manual placeholder screens have no install and cannot
   * pull a manifest, so they are skipped.
   */
  async getTargetDevices(): Promise<TargetDevice[]> {
    const result = await this.pool.query(`
      SELECT d.id, d.name, d.tenant_id AS "tenantId"
      FROM devices d
      WHERE d.install_id IS NOT NULL
      ORDER BY d.name ASC
    `);
    return result.rows;
  }

  /**
   * Validates the per-device credential sent by a Player when it opens its
   * WebSocket. Device tokens are issued by the CMS at installation time; do
   * not replace this with a shared gateway secret.
   */
  async authenticatePlayerDevice(
    deviceId: string,
    deviceToken: string,
  ): Promise<AuthenticatedPlayerDevice | null> {
    if (!deviceId || !deviceToken) return null;

    const result = await this.pool.query(
      `
        SELECT d.id, d.tenant_id AS "tenantId"
        FROM devices d
        WHERE d.id = $1
          AND d.device_token = $2
          AND d.install_id IS NOT NULL
        LIMIT 1
      `,
      [deviceId, deviceToken],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Active calendars with no screen selected. These publish to nothing, so the
   * worker logs them rather than silently dropping the content.
   */
  async getUntargetedActiveCalendars(): Promise<ActiveCalendar[]> {
    const result = await this.pool.query(`
      SELECT c.id, c.name, c.playlist_id AS "playlistId", c.priority
      FROM calendars c
      WHERE c.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM "_CalendarToDevice" cd WHERE cd."A" = c.id
        )
    `);
    return result.rows;
  }

  async getPublishedSchedules(deviceId: string): Promise<PublishedSchedule[]> {
    const query = `
      SELECT
        c.id,
        c.name,
        c.playlist_id     AS "playlistId",
        c.priority,
        c.start_time AT TIME ZONE 'UTC' AS "startAt",
        c.end_time   AT TIME ZONE 'UTC' AS "endAt",
        c.days_of_week    AS "daysOfWeek"
      FROM calendars c
      INNER JOIN playlists p ON p.id = c.playlist_id
      WHERE c.status = 'ACTIVE'
        AND EXISTS (
          SELECT 1
          FROM "_CalendarToDevice" cd
          WHERE cd."A" = c.id AND cd."B" = $1
        )
        AND EXISTS (
          SELECT 1
          FROM playlist_items pi
          JOIN media m ON m.id = pi.media_id
          WHERE pi.playlist_id = c.playlist_id
            AND m.status = 'READY'
        )
      ORDER BY c.priority DESC, c.start_time ASC
    `;

    const result = await this.pool.query(query, [deviceId]);
    return result.rows;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
    logger.info('Database connection closed');
  }

  private mapPlaybackItem(row: {
    id: string;
    mediaId: string;
    durationSec: number | null;
    fit: PlaylistPlaybackItem['fit'] | null;
    position: PlaylistPlaybackItem['position'] | null;
    zoneId: string | null;
    filename: string;
    cdnUrl: string | null;
    s3Key: string | null;
    sourceType: string;
    externalUrl: string | null;
    width: number | null;
    height: number | null;
    mediaTypeName: string | null;
    sizeBytes: string | number | null;
    mediaUpdatedAt: Date | string | null;
  }, zoneMap: Map<string, PlaylistZone>, fallbackZone: PlaylistZone): PlaylistPlaybackItem {
    const type = this.detectPlayerType(row.mediaTypeName, row.filename);
    const sourceType = row.sourceType === 'external_url' ? 'external_url' : 'upload';
    const sizeBytes = row.sizeBytes === null ? undefined : Number(row.sizeBytes);
    const zone = zoneMap.get(row.zoneId || '') ?? fallbackZone;
    const src = sourceType === 'external_url'
      ? row.externalUrl || ''
      : type === 'html'
        ? `media/html/${row.id}/index.html`
        : `media/${this.folderForType(type)}/${String(row.filename).replace(/[/\\]/g, '_')}`;
    const mediaCdn = this.mediaCdnBaseUrl.trim().replace(/\/+$/, '');
    const cdnKey = row.s3Key?.replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    const url = sourceType === 'external_url'
      ? row.externalUrl || src
      : mediaCdn && cdnKey
        ? `${mediaCdn}/${cdnKey}`
        : row.cdnUrl || undefined;

    return {
      id: row.id,
      mediaId: row.mediaId,
      mediaVersion: row.mediaUpdatedAt ? new Date(row.mediaUpdatedAt).toISOString() : undefined,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
      type,
      zoneId: zone.id,
      x: zone.x,
      y: zone.y,
      src,
      url,
      sourceType,
      fit: row.fit ?? (type === 'html' ? 'contain' : 'scale-down'),
      position: row.position ?? 'center',
      width: zone.width,
      height: zone.height,
      durationMs: row.durationSec ? Number(row.durationSec) * 1000 : type === 'html' ? 20000 : type === 'image' ? 8000 : undefined,
      ...(type === 'html' ? { navigationPolicy: 'same_origin' as const, reloadPolicy: 'on_each_play' as const } : {}),
    };
  }

  private normalizeZones(rawZones: unknown, canvas: { width: number; height: number }): PlaylistZone[] {
    const fallback: PlaylistZone = {
      id: 'full-screen',
      name: 'Full Screen',
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    };

    const parsed = Array.isArray(rawZones)
      ? rawZones
      : typeof rawZones === 'string'
        ? this.parseZonesJson(rawZones)
        : [];

    const zones = parsed
      .map((zone: any): PlaylistZone | null => {
        const id = String(zone?.id || '').trim();
        const x = Number(zone?.x ?? zone?.left ?? 0);
        const y = Number(zone?.y ?? zone?.top ?? 0);
        const width = Number(zone?.width ?? zone?.w);
        const height = Number(zone?.height ?? zone?.h);
        if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return null;
        }
        return {
          id,
          name: String(zone?.name || id),
          x,
          y,
          width,
          height,
        };
      })
      .filter((zone): zone is PlaylistZone => Boolean(zone));

    return zones.length > 0 ? zones : [fallback];
  }

  private parseZonesJson(raw: string): unknown[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private detectPlayerType(mediaTypeName: string | null, filename: string): 'video' | 'image' | 'audio' | 'html' {
    const name = String(mediaTypeName || '').toLowerCase();
    const ext = String(filename || '').split('.').pop()?.toLowerCase();
    if (name.startsWith('html') || ['html', 'htm', 'zip'].includes(ext || '')) return 'html';
    if (name.startsWith('image') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext || '')) return 'image';
    if (name.startsWith('audio') || ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext || '')) return 'audio';
    return 'video';
  }

  private folderForType(type: 'video' | 'image' | 'audio' | 'html'): 'videos' | 'images' | 'audio' | 'html' {
    if (type === 'image') return 'images';
    if (type === 'audio') return 'audio';
    if (type === 'html') return 'html';
    return 'videos';
  }
}
