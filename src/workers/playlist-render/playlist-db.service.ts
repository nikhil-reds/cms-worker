import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createLogger } from '../../common/logger';
import type { PendingPlaylist, PlaylistJson } from './playlist-render.types';

const logger = createLogger('PlaylistDbService');

const MAX_RENDER_ATTEMPTS = 3;

/** A 'rendering' row older than this is treated as a crashed run and re-queued. */
const STALE_RENDER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Watches the CMS playlists / playlist_items / media tables for changes.
 *
 * The CMS schema (Prisma-managed) is never modified. Render state lives in
 * one worker-owned table, `player_playlist_render`, keyed by playlist id and
 * a content fingerprint: a playlist needs rendering when its fingerprint
 * differs from the last completed render.
 */
@Injectable()
export class PlaylistDbService {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'cms-worker-playlist-render',
      max: 5,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client: %s', err.message);
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    logger.info('Database connection successful');

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS player_playlist_render (
        playlist_id     TEXT PRIMARY KEY,
        source_hash     TEXT,
        render_status   VARCHAR(20) NOT NULL DEFAULT 'pending',
        render_error    TEXT,
        render_attempts INT NOT NULL DEFAULT 0,
        output_path     TEXT,
        s3_key          TEXT,
        s3_url          TEXT,
        duration_sec    INT,
        rendered_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // migrate tables created before the processed-bucket upload existed
    await this.pool.query(`
      ALTER TABLE player_playlist_render
        ADD COLUMN IF NOT EXISTS s3_key TEXT,
        ADD COLUMN IF NOT EXISTS s3_url TEXT
    `);
    logger.info('player_playlist_render tracking table ready');

    await this.resetStaleRenders();
  }

  /** Re-queue rows stuck in 'rendering' by a crashed previous run. */
  private async resetStaleRenders(): Promise<void> {
    const result = await this.pool.query(
      `
      UPDATE player_playlist_render
      SET render_status = 'pending', updated_at = NOW()
      WHERE render_status = 'rendering'
        AND updated_at < NOW() - ($1 || ' milliseconds')::interval
      `,
      [STALE_RENDER_TIMEOUT_MS],
    );
    if (result.rowCount) {
      logger.warn(
        `Reset ${result.rowCount} stale 'rendering' row(s) from a previous run`,
      );
    }
  }

  /**
   * Find playlists whose content fingerprint differs from the last render
   * (or that were never rendered, or failed fewer than MAX_RENDER_ATTEMPTS
   * times for the same fingerprint). The fingerprint covers the playlist row,
   * item ordering/durations, and media updated_at, so media re-processing
   * also triggers a re-render.
   */
  async pollForChanges(): Promise<PendingPlaylist[]> {
    const query = `
      WITH fingerprints AS (
        SELECT
          p.id,
          p.tenant_id AS "tenantId",
          p.name,
          md5(
            p.updated_at::text || ':' || p.display_width || 'x' || p.display_height || ':' || p.display_name || '|' ||
            COALESCE(string_agg(
              pi.media_id || ':' || pi.position || ':' || pi.duration_sec || ':' ||
              COALESCE(pi.fit, 'scale-down') || ':' || COALESCE(pi.object_position, 'center') || ':' ||
              m.updated_at::text,
              ',' ORDER BY pi.position
            ), '')
          ) AS "sourceHash",
          COUNT(pi.id)::int AS "itemCount"
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        LEFT JOIN media m ON m.id = pi.media_id AND m.status = 'READY'
        GROUP BY p.id
      )
      SELECT
        f.*,
        COALESCE(r.render_attempts, 0) AS "renderAttempts"
      FROM fingerprints f
      LEFT JOIN player_playlist_render r ON r.playlist_id = f.id
      WHERE f."itemCount" > 0
        AND (
          r.playlist_id IS NULL
          OR r.source_hash IS DISTINCT FROM f."sourceHash"
          OR (r.render_status = 'failed' AND r.render_attempts < $1)
        )
        AND COALESCE(r.render_status, 'pending') <> 'rendering'
      ORDER BY f.name ASC
      LIMIT 20
    `;

    const result = await this.pool.query(query, [MAX_RENDER_ATTEMPTS]);
    return result.rows as PendingPlaylist[];
  }

  /**
   * Build the render input directly from the database. Fallback for when the
   * CMS-written S3 JSON is missing or invalid — the shape matches
   * PlaylistJsonSchema so downstream code is source-agnostic.
   */
  async loadPlaylistFromDb(playlistId: string): Promise<PlaylistJson | null> {
    const playlistResult = await this.pool.query(
      `
      SELECT
        id,
        tenant_id AS "tenantId",
        name,
        display_name AS "displayName",
        display_width AS "displayWidth",
        display_height AS "displayHeight"
      FROM playlists
      WHERE id = $1
      `,
      [playlistId],
    );
    if (playlistResult.rows.length === 0) return null;

    const itemsResult = await this.pool.query(
      `
      SELECT
        pi.id,
        pi.media_id     AS "mediaId",
        pi.position,
        pi.duration_sec AS "durationSec",
        pi.fit,
        pi.object_position AS "objectPosition",
        m.id            AS "m_id",
        m.name          AS "m_name",
        m.filename      AS "m_filename",
        m.s3_key        AS "m_s3Key",
        m.status        AS "m_status"
      FROM playlist_items pi
      JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = $1
      ORDER BY pi.position ASC
      `,
      [playlistId],
    );

    return {
      ...playlistResult.rows[0],
      playlistItems: itemsResult.rows.map((row) => ({
        id: row.id,
        mediaId: row.mediaId,
        position: row.position,
        durationSec: row.durationSec,
        fit: row.fit ?? 'scale-down',
        objectPosition: row.objectPosition ?? 'center',
        media: {
          id: row.m_id,
          name: row.m_name,
          filename: row.m_filename,
          s3Key: row.m_s3Key,
          status: row.m_status,
        },
      })),
    };
  }

  /**
   * Local file paths for media already downloaded by the media-sync worker,
   * so renders reuse them instead of re-downloading from S3.
   */
  async getLocalMediaPaths(mediaIds: string[]): Promise<Map<string, string>> {
    if (mediaIds.length === 0) return new Map();

    const result = await this.pool.query(
      `
      SELECT media_id AS "mediaId", local_path AS "localPath"
      FROM player_media_sync
      WHERE media_id = ANY($1)
        AND sync_status = 'completed'
        AND local_path IS NOT NULL
      `,
      [mediaIds],
    );

    return new Map(result.rows.map((row) => [row.mediaId, row.localPath]));
  }

  async markAsRendering(playlistId: string, sourceHash: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO player_playlist_render (playlist_id, source_hash, render_status, updated_at)
      VALUES ($1, $2, 'rendering', NOW())
      ON CONFLICT (playlist_id)
      DO UPDATE SET
        render_status = 'rendering',
        -- new fingerprint = new content: previous failures no longer count
        render_attempts = CASE
          WHEN player_playlist_render.source_hash IS DISTINCT FROM $2 THEN 0
          ELSE player_playlist_render.render_attempts
        END,
        source_hash = $2,
        updated_at = NOW()
      `,
      [playlistId, sourceHash],
    );
  }

  async markAsCompleted(
    playlistId: string,
    sourceHash: string,
    outputPath: string,
    durationSec: number,
    s3Key: string,
    s3Url: string,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE player_playlist_render
      SET render_status = 'completed',
          source_hash = $2,
          output_path = $3,
          duration_sec = $4,
          s3_key = $5,
          s3_url = $6,
          render_error = NULL,
          rendered_at = NOW(),
          updated_at = NOW()
      WHERE playlist_id = $1
      `,
      [playlistId, sourceHash, outputPath, durationSec, s3Key, s3Url],
    );
    logger.info(
      `Marked ${playlistId} completed → ${outputPath} + ${s3Url} (${durationSec}s)`,
    );
  }

  async markAsFailed(playlistId: string, error: string): Promise<void> {
    const result = await this.pool.query(
      `
      UPDATE player_playlist_render
      SET render_status = 'failed',
          render_error = $2,
          render_attempts = render_attempts + 1,
          updated_at = NOW()
      WHERE playlist_id = $1
      RETURNING render_attempts
      `,
      [playlistId, error],
    );

    const attempts = result.rows[0]?.render_attempts ?? 1;
    if (attempts >= MAX_RENDER_ATTEMPTS) {
      logger.warn(
        `✗ ${playlistId} failed permanently after ${attempts} attempts: ${error}`,
      );
    } else {
      logger.warn(
        `✗ ${playlistId} failed (attempt ${attempts}/${MAX_RENDER_ATTEMPTS}), will retry: ${error}`,
      );
    }
  }

  /** Tracked playlists that no longer exist in the CMS (deleted). */
  async findDeletedPlaylists(): Promise<
    { playlistId: string; outputPath: string | null; s3Key: string | null }[]
  > {
    const result = await this.pool.query(`
      SELECT
        r.playlist_id AS "playlistId",
        r.output_path AS "outputPath",
        r.s3_key      AS "s3Key"
      FROM player_playlist_render r
      LEFT JOIN playlists p ON p.id = r.playlist_id
      WHERE p.id IS NULL
    `);
    return result.rows;
  }

  async deleteTracking(playlistId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM player_playlist_render WHERE playlist_id = $1`,
      [playlistId],
    );
  }

  async getRenderStats(): Promise<{
    pending: number;
    rendering: number;
    completed: number;
    failed: number;
    dlq: number;
  }> {
    const result = await this.pool.query(
      `
      SELECT
        (
          SELECT COUNT(*) FROM playlists p
          LEFT JOIN player_playlist_render r ON r.playlist_id = p.id
          WHERE r.playlist_id IS NULL
            AND EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = p.id)
        ) AS pending,
        COUNT(*) FILTER (WHERE render_status = 'rendering')                              AS rendering,
        COUNT(*) FILTER (WHERE render_status = 'completed')                              AS completed,
        COUNT(*) FILTER (WHERE render_status = 'failed' AND render_attempts < $1)        AS failed,
        COUNT(*) FILTER (WHERE render_status = 'failed' AND render_attempts >= $1)       AS dlq
      FROM player_playlist_render
      `,
      [MAX_RENDER_ATTEMPTS],
    );

    const row = result.rows[0];
    return {
      pending: Number(row.pending),
      rendering: Number(row.rendering),
      completed: Number(row.completed),
      failed: Number(row.failed),
      dlq: Number(row.dlq),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database connection closed');
  }
}
