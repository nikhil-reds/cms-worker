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
  localSrc: string;
  s3Key: string;
  s3Url: string;
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
  } | null> {
    const query = `
      SELECT
        output_path     AS "localSrc",
        s3_key          AS "s3Key",
        s3_url          AS "s3Url"
      FROM player_playlist_render
      WHERE playlist_id = $1
        AND render_status = 'completed'
    `;

    const result = await this.pool.query(query, [playlistId]);
    if (result.rows.length === 0) return null;
    return result.rows[0];
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
        r.s3_url          AS "s3Url"
      FROM calendars c
      INNER JOIN player_playlist_render r ON r.playlist_id = c.playlist_id
      WHERE c.status = 'ACTIVE'
        AND r.render_status = 'completed'
        AND r.s3_url IS NOT NULL
      ORDER BY c.priority DESC, c.start_time ASC
    `;

    const result = await this.pool.query(query);
    return result.rows;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
    logger.info('Database connection closed');
  }
}
