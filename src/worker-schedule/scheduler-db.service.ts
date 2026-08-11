import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createLogger } from '../common/logger';

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
  localSrc: string | null;
  s3Key: string | null;
  s3Url: string | null;
  displayWidth: number;
  displayHeight: number;
  hasHtml: boolean;
}

export interface PlaylistPlaybackItem {
  id: string;
  type: 'video' | 'image' | 'audio' | 'html';
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

/**
 * Query the CMS database for active calendars: those whose time window
 * (start_time / end_time / days_of_week) includes NOW, sorted by priority.
 */
@Injectable()
export class SchedulerDbService {
  private pool: Pool;
  private closed = false;

  constructor(databaseUrl: string) {
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

  /**
   * Get the rendered playlist MP4 for a given playlist (its S3 key from
   * the playlist-render worker's tracking table).
   */
  async getPlaylistRenderOutput(playlistId: string): Promise<{
    localSrc: string;
    s3Key: string;
    s3Url: string;
    displayWidth: number;
    displayHeight: number;
  } | null> {
    const query = `
      SELECT
        output_path     AS "localSrc",
        s3_key          AS "s3Key",
        s3_url          AS "s3Url",
        p.display_width AS "displayWidth",
        p.display_height AS "displayHeight"
      FROM player_playlist_render r
      INNER JOIN playlists p ON p.id = r.playlist_id
      WHERE r.playlist_id = $1
        AND r.render_status = 'completed'
    `;

    const result = await this.pool.query(query, [playlistId]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  async getPlaylistPlaybackItems(playlistId: string): Promise<PlaylistPlaybackItem[]> {
    const query = `
      SELECT
        pi.media_id AS "id",
        pi.duration_sec AS "durationSec",
        pi.fit,
        pi.object_position AS "position",
        m.filename,
        m.cdn_url AS "cdnUrl",
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
    return result.rows.map((row) => this.mapPlaybackItem(row));
  }

  async playlistContainsHtml(playlistId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM playlist_items pi
        JOIN media m ON m.id = pi.media_id
        LEFT JOIN media_types mt ON mt.id = m.media_type_id
        WHERE pi.playlist_id = $1
          AND m.status = 'READY'
          AND (
            mt.name = 'html'
            OR COALESCE(m.source_type, 'upload') = 'external_url'
            OR m.filename ~* '\\.(html|htm|zip)$'
          )
      ) AS "hasHtml"
      `,
      [playlistId],
    );
    return Boolean(result.rows[0]?.hasHtml);
  }

  async getPublishedSchedules(): Promise<PublishedSchedule[]> {
    const query = `
      SELECT
        c.id,
        c.name,
        c.playlist_id     AS "playlistId",
        c.priority,
        c.start_time AT TIME ZONE 'UTC' AS "startAt",
        c.end_time   AT TIME ZONE 'UTC' AS "endAt",
        c.days_of_week    AS "daysOfWeek",
        r.output_path     AS "localSrc",
        r.s3_key          AS "s3Key",
        r.s3_url          AS "s3Url",
        p.display_width   AS "displayWidth",
        p.display_height  AS "displayHeight",
        EXISTS (
          SELECT 1
          FROM playlist_items pi
          JOIN media m ON m.id = pi.media_id
          LEFT JOIN media_types mt ON mt.id = m.media_type_id
          WHERE pi.playlist_id = c.playlist_id
            AND m.status = 'READY'
            AND (
              mt.name = 'html'
              OR COALESCE(m.source_type, 'upload') = 'external_url'
              OR m.filename ~* '\\.(html|htm|zip)$'
            )
        ) AS "hasHtml"
      FROM calendars c
      INNER JOIN playlists p ON p.id = c.playlist_id
      LEFT JOIN player_playlist_render r ON r.playlist_id = c.playlist_id
      WHERE c.status = 'ACTIVE'
        AND (
          (r.render_status = 'completed' AND r.s3_url IS NOT NULL)
          OR EXISTS (
            SELECT 1
            FROM playlist_items pi
            JOIN media m ON m.id = pi.media_id
            LEFT JOIN media_types mt ON mt.id = m.media_type_id
            WHERE pi.playlist_id = c.playlist_id
              AND m.status = 'READY'
              AND (
                mt.name = 'html'
                OR COALESCE(m.source_type, 'upload') = 'external_url'
                OR m.filename ~* '\\.(html|htm|zip)$'
              )
          )
        )
      ORDER BY c.priority DESC, c.start_time ASC
    `;

    const result = await this.pool.query(query);
    return result.rows.map((row) => ({ ...row, hasHtml: Boolean(row.hasHtml) }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
    logger.info('Database connection closed');
  }

  private mapPlaybackItem(row: {
    id: string;
    durationSec: number | null;
    fit: PlaylistPlaybackItem['fit'] | null;
    position: PlaylistPlaybackItem['position'] | null;
    filename: string;
    cdnUrl: string | null;
    sourceType: string;
    externalUrl: string | null;
    width: number | null;
    height: number | null;
    mediaTypeName: string | null;
  }): PlaylistPlaybackItem {
    const type = this.detectPlayerType(row.mediaTypeName, row.filename);
    const sourceType = row.sourceType === 'external_url' ? 'external_url' : 'upload';
    const src = sourceType === 'external_url'
      ? row.externalUrl || ''
      : type === 'html'
        ? `media/html/${row.id}/index.html`
        : `media/${this.folderForType(type)}/${String(row.filename).replace(/[/\\]/g, '_')}`;
    const url = sourceType === 'external_url' ? row.externalUrl || src : row.cdnUrl || undefined;

    return {
      id: row.id,
      type,
      src,
      url,
      sourceType,
      fit: row.fit ?? (type === 'html' ? 'contain' : 'scale-down'),
      position: row.position ?? 'center',
      width: row.width === null ? undefined : Number(row.width),
      height: row.height === null ? undefined : Number(row.height),
      durationMs: row.durationSec ? Number(row.durationSec) * 1000 : type === 'html' ? 20000 : type === 'image' ? 8000 : undefined,
      ...(type === 'html' ? { navigationPolicy: 'same_origin' as const, reloadPolicy: 'on_each_play' as const } : {}),
    };
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
