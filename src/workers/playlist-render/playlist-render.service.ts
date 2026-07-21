import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { createLogger } from '../../common/logger';
import { PlayerConfigService } from '../media-sync/player-config.service';
import { PlaylistDbService } from './playlist-db.service';
import { PlaylistS3Service } from './playlist-s3.service';
import { FfmpegRenderService } from './ffmpeg-render.service';
import type {
  MediaKind,
  PendingPlaylist,
  PlaylistJson,
  PlaylistRenderConfig,
  ResolvedItem,
} from './playlist-render.types';

const logger = createLogger('PlaylistRenderService');

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|ogg)$/i;

@Injectable()
export class PlaylistRenderService implements OnApplicationShutdown {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private activeRender: Promise<void> | null = null;

  constructor(
    private db: PlaylistDbService,
    private s3: PlaylistS3Service,
    private renderer: FfmpegRenderService,
    private playerConfig: PlayerConfigService,
    private config: PlaylistRenderConfig,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Playlist render worker already running');
      return;
    }

    logger.info('Starting Playlist Render Worker');
    this.isRunning = true;

    await this.db.initialize();

    mkdirSync(join(this.config.playerMediaRootPath, 'videos'), {
      recursive: true,
    });
    mkdirSync(this.config.scratchDir, { recursive: true });
    // work/ holds per-render intermediates; anything left over is from a crash
    rmSync(join(this.config.scratchDir, 'work'), {
      recursive: true,
      force: true,
    });

    this.startPollingLoop();
    logger.info(
      `Playlist Render Worker started (bucket=${this.config.playlistBucket}, ` +
        `mode=${this.config.playerConfigMode}, ${this.config.resolution.width}x${this.config.resolution.height}@${this.config.fps})`,
    );
  }

  private startPollingLoop(): void {
    logger.info(
      `Starting polling loop (interval: ${this.config.pollIntervalMs}ms)`,
    );

    this.pollAndRender().catch((error) =>
      logger.error('Error in polling', error),
    );
    this.pollingInterval = setInterval(() => {
      this.pollAndRender().catch((error) =>
        logger.error('Error in polling', error),
      );
    }, this.config.pollIntervalMs);
  }

  private async pollAndRender(): Promise<void> {
    if (this.activeRender) {
      logger.debug('Render already in progress, skipping poll cycle');
      return;
    }

    this.activeRender = this.doPollAndRender();
    try {
      await this.activeRender;
    } finally {
      this.activeRender = null;
    }
  }

  private async doPollAndRender(): Promise<void> {
    await this.cleanupDeletedPlaylists();

    const pending = await this.db.pollForChanges();
    if (pending.length === 0) {
      logger.debug('No playlists need rendering');
      return;
    }

    logger.info(`Found ${pending.length} playlist(s) to render`);

    // Renders run one at a time — ffmpeg saturates the machine on its own.
    for (const playlist of pending) {
      if (!this.isRunning) break;
      await this.renderPlaylist(playlist).catch((error) =>
        logger.error(`Render error for ${playlist.id}: ${error}`),
      );
    }
  }

  private async renderPlaylist(pending: PendingPlaylist): Promise<void> {
    const startTime = Date.now();
    logger.info(
      `Rendering playlist "${pending.name}" (${pending.id}, ${pending.itemCount} items)`,
    );

    await this.db.markAsRendering(pending.id, pending.sourceHash);

    try {
      // The DB is the change signal; the S3 JSON is the render input, with a
      // DB fallback so a missed CMS upload never blocks a render.
      const playlist =
        (await this.s3.fetchPlaylistJson(
          this.config.playlistBucket,
          pending.id,
        )) ?? (await this.db.loadPlaylistFromDb(pending.id));

      if (!playlist || playlist.playlistItems.length === 0) {
        throw new Error(
          'Playlist has no items (S3 JSON missing and DB row empty)',
        );
      }

      const items = await this.resolveItems(playlist);
      if (items.length === 0) {
        throw new Error(
          'No renderable items (all media missing, unsupported, or not READY)',
        );
      }

      const rendered = await this.renderer.renderPlaylist(pending.id, items);

      // Upload the finished video to the processed bucket BEFORE installing
      // locally — a failed upload marks the render failed and retries without
      // ever touching the player.
      const s3Key = `playlists/${pending.id}.mp4`;
      const s3Url = await this.s3.uploadFile(
        this.config.processedBucket,
        s3Key,
        rendered.outputPath,
        'video/mp4',
      );

      const installedSrc = await this.installIntoPlayer(
        pending.id,
        rendered.outputPath,
      );
      await this.updatePlayerConfig(pending.id, installedSrc);

      await this.db.markAsCompleted(
        pending.id,
        pending.sourceHash,
        installedSrc,
        rendered.durationSec,
        s3Key,
        s3Url,
      );
      logger.info(
        `✓ Rendered "${pending.name}" → ${installedSrc} + s3://${this.config.processedBucket}/${s3Key} ` +
          `(${rendered.durationSec}s, ${Date.now() - startTime}ms)`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.db.markAsFailed(pending.id, errorMsg);
    }
  }

  /**
   * Locate every item's media on local disk: files already synced by the
   * media-sync worker are reused; anything else is downloaded from the media
   * bucket by s3Key. Unusable items are skipped, not fatal.
   */
  private async resolveItems(playlist: PlaylistJson): Promise<ResolvedItem[]> {
    const sorted = [...playlist.playlistItems].sort(
      (a, b) => a.position - b.position,
    );
    const localPaths = await this.db.getLocalMediaPaths(
      sorted.map((i) => i.mediaId),
    );

    const resolved: ResolvedItem[] = [];
    for (const item of sorted) {
      if (item.media.status !== 'READY') {
        logger.warn(
          `Skipping item ${item.mediaId} (${item.media.filename}): status=${item.media.status}`,
        );
        continue;
      }

      const kind = this.detectKind(item.media.filename);
      if (!kind) {
        logger.warn(
          `Skipping item ${item.mediaId} (${item.media.filename}): not a renderable type`,
        );
        continue;
      }

      let localPath = localPaths.get(item.mediaId);
      if (!localPath || !existsSync(localPath)) {
        localPath = join(
          this.config.scratchDir,
          'sources',
          item.mediaId,
          item.media.filename,
        );
        if (!existsSync(localPath)) {
          logger.info(
            `Downloading ${item.media.filename} from s3://${this.config.mediaBucket}/${item.media.s3Key}`,
          );
          await this.s3.downloadFile(
            this.config.mediaBucket,
            item.media.s3Key,
            localPath,
          );
        }
      }

      resolved.push({
        mediaId: item.mediaId,
        position: item.position,
        durationSec: item.durationSec,
        kind,
        localPath,
      });
    }

    return resolved;
  }

  private detectKind(filename: string): MediaKind | null {
    if (VIDEO_EXT.test(filename)) return 'video';
    if (IMAGE_EXT.test(filename)) return 'image';
    if (AUDIO_EXT.test(filename)) return 'audio';
    return null;
  }

  /**
   * Move the rendered MP4 into the player's media folder. Copy to a tmp name
   * in the target dir, then rename — atomic on the player's filesystem, so
   * the player never reads a torn file even mid-replace.
   */
  private async installIntoPlayer(
    playlistId: string,
    renderedPath: string,
  ): Promise<string> {
    const relativeSrc = `media/videos/playlist-${playlistId}.mp4`;

    if (this.playerConfig.isRemote) {
      const remoteSrc = await this.playerConfig.uploadMediaFile(
        renderedPath,
        'videos',
        `playlist-${playlistId}.mp4`,
      );
      unlinkSync(renderedPath);
      return remoteSrc;
    }

    const finalPath = join(this.config.playerRootPath, relativeSrc);
    const tmpPath = `${finalPath}.tmp`;

    copyFileSync(renderedPath, tmpPath);
    renameSync(tmpPath, finalPath);
    unlinkSync(renderedPath);

    return relativeSrc;
  }

  private async updatePlayerConfig(
    playlistId: string,
    src: string,
  ): Promise<void> {
    const entry = {
      id: playlistId,
      type: 'video' as const,
      src,
      loop: true,
      muted: false,
    };

    if (this.config.playerConfigMode === 'exclusive') {
      await this.playerConfig.replacePlaylist([entry]);
    } else {
      await this.playerConfig.addToPlaylist(entry);
    }
  }

  /** Playlists deleted in the CMS: remove the local MP4, the uploaded S3
   *  copy, the player config entry, and the tracking row. */
  private async cleanupDeletedPlaylists(): Promise<void> {
    const deleted = await this.db.findDeletedPlaylists();

    for (const { playlistId, outputPath, s3Key } of deleted) {
      logger.info(`Playlist ${playlistId} was deleted in the CMS, cleaning up`);

      const src = outputPath ?? `media/videos/playlist-${playlistId}.mp4`;
      const absolutePath = join(this.config.playerRootPath, src);

      await this.playerConfig.removeFromPlaylist(src);
      if (existsSync(absolutePath)) {
        unlinkSync(absolutePath);
        logger.info(`Removed ${absolutePath}`);
      }
      if (s3Key) {
        await this.s3
          .deleteObject(this.config.processedBucket, s3Key)
          .catch((error) =>
            logger.warn(
              `Could not delete s3://${this.config.processedBucket}/${s3Key}: ${error}`,
            ),
          );
      }
      await this.db.deleteTracking(playlistId);
    }
  }

  async getStats(): Promise<any> {
    return this.db.getRenderStats();
  }

  async stop(): Promise<void> {
    logger.info('Stopping Playlist Render Worker');
    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.activeRender) {
      logger.info('Waiting for active render to finish');
      await this.activeRender.catch(() => undefined);
    }

    await this.db.close();
    logger.info('Playlist Render Worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
