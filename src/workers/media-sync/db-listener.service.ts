import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createLogger } from '../../common/logger';
import { Media } from './media-sync.types';

const logger = createLogger('DbListenerService');

const MAX_SYNC_ATTEMPTS = 3;

/**
 * Listens to the CMS `media` table in Neon PostgreSQL.
 *
 * The CMS schema (Prisma-managed) is not modified. Sync state is tracked
 * in a separate worker-owned table `player_media_sync`, so "new media"
 * simply means: a READY row in `media` with no completed sync record.
 */
@Injectable()
export class DbListenerService {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      application_name: 'cms-worker-media-sync',
      max: 5,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client: %s', err.message);
    });
  }

  /**
   * Connect and make sure the worker's sync-state table exists.
   * Only creates `player_media_sync` — never alters CMS tables.
   */
  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    logger.info('Database connection successful');

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS player_media_sync (
        media_id      TEXT PRIMARY KEY,
        local_path    TEXT,
        sync_status   VARCHAR(20) NOT NULL DEFAULT 'pending',
        sync_error    TEXT,
        sync_attempts INT NOT NULL DEFAULT 0,
        synced_at     TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('player_media_sync tracking table ready');
  }

  /**
   * Find READY media that has not been synced to the player yet
   * (or failed fewer than MAX_SYNC_ATTEMPTS times).
   */
  async pollForChanges(): Promise<Media[]> {
    const query = `
      SELECT
        m.id,
        m.tenant_id                 AS "tenantId",
        m.filename                  AS "fileName",
        m.s3_key                    AS "s3Key",
        m.size_bytes                AS "fileSize",
        mt.name                     AS "mediaTypeName",
        COALESCE(s.sync_attempts,0) AS "syncAttempts",
        m.created_at                AS "createdAt"
      FROM media m
      LEFT JOIN media_types mt ON mt.id = m.media_type_id
      LEFT JOIN player_media_sync s ON s.media_id = m.id
      WHERE m.status = 'READY'
        AND m.s3_key IS NOT NULL
        AND (
          s.media_id IS NULL
          OR (s.sync_status = 'failed' AND s.sync_attempts < $1)
        )
      ORDER BY m.created_at ASC
      LIMIT 100
    `;

    const result = await this.pool.query(query, [MAX_SYNC_ATTEMPTS]);

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      fileName: row.fileName,
      s3Key: row.s3Key,
      fileSize: Number(row.fileSize),
      mimeType: this.toMimeHint(row.mediaTypeName),
      syncAttempts: Number(row.syncAttempts),
      createdAt: row.createdAt,
    }));
  }

  /** Map the CMS media_types.name (e.g. "image", "video") to a mime hint. */
  private toMimeHint(mediaTypeName?: string): string | undefined {
    if (!mediaTypeName) return undefined;
    const name = mediaTypeName.toLowerCase();
    if (name.startsWith('image')) return 'image/unknown';
    if (name.startsWith('video')) return 'video/unknown';
    if (name.startsWith('audio')) return 'audio/unknown';
    return undefined; // fall back to file-extension detection
  }

  async markAsSyncing(mediaId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO player_media_sync (media_id, sync_status, updated_at)
      VALUES ($1, 'syncing', NOW())
      ON CONFLICT (media_id)
      DO UPDATE SET sync_status = 'syncing', updated_at = NOW()
      `,
      [mediaId],
    );
  }

  async markAsCompleted(mediaId: string, localPath: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO player_media_sync (media_id, sync_status, local_path, synced_at, updated_at)
      VALUES ($1, 'completed', $2, NOW(), NOW())
      ON CONFLICT (media_id)
      DO UPDATE SET
        sync_status = 'completed',
        local_path = $2,
        sync_error = NULL,
        synced_at = NOW(),
        updated_at = NOW()
      `,
      [mediaId, localPath],
    );
    logger.info(`Marked ${mediaId} completed → ${localPath}`);
  }

  async markAsFailed(mediaId: string, error: string): Promise<void> {
    const result = await this.pool.query(
      `
      INSERT INTO player_media_sync (media_id, sync_status, sync_error, sync_attempts, updated_at)
      VALUES ($1, 'failed', $2, 1, NOW())
      ON CONFLICT (media_id)
      DO UPDATE SET
        sync_status = 'failed',
        sync_error = $2,
        sync_attempts = player_media_sync.sync_attempts + 1,
        updated_at = NOW()
      RETURNING sync_attempts
      `,
      [mediaId, error],
    );

    const attempts = result.rows[0]?.sync_attempts ?? 1;
    if (attempts >= MAX_SYNC_ATTEMPTS) {
      logger.warn(`✗ ${mediaId} failed permanently after ${attempts} attempts: ${error}`);
    } else {
      logger.warn(`✗ ${mediaId} failed (attempt ${attempts}/${MAX_SYNC_ATTEMPTS}), will retry: ${error}`);
    }
  }

  async getSyncStats(): Promise<{
    pending: number;
    syncing: number;
    completed: number;
    failed: number;
    dlq: number;
  }> {
    const result = await this.pool.query(`
      SELECT
        (
          SELECT COUNT(*) FROM media m
          LEFT JOIN player_media_sync ps ON ps.media_id = m.id
          WHERE m.status = 'READY' AND m.s3_key IS NOT NULL AND ps.media_id IS NULL
        ) AS pending,
        COUNT(*) FILTER (WHERE s.sync_status = 'syncing')                            AS syncing,
        COUNT(*) FILTER (WHERE s.sync_status = 'completed')                          AS completed,
        COUNT(*) FILTER (WHERE s.sync_status = 'failed' AND s.sync_attempts < $1)    AS failed,
        COUNT(*) FILTER (WHERE s.sync_status = 'failed' AND s.sync_attempts >= $1)   AS dlq
      FROM player_media_sync s
    `, [MAX_SYNC_ATTEMPTS]);

    const row = result.rows[0];
    return {
      pending: Number(row.pending),
      syncing: Number(row.syncing),
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
