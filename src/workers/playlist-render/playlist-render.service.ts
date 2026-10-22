import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { mkdirSync, rmSync } from 'fs';
import { basename, join } from 'path';
import { createLogger } from '../../common/logger';
import { PlayerConfigService } from '../media-sync/player-config.service';
import { PlaylistDbService } from './playlist-db.service';
import { PlaylistS3Service } from './playlist-s3.service';
import { SchedulerEvaluatePublisherService } from './scheduler-evaluate-publisher.service';
import type {
  MediaKind,
  PendingPlaylist,
  PlaylistJson,
  PlaylistRenderConfig,
} from './playlist-render.types';

const logger = createLogger('PlaylistRenderService');

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|ogg)$/i;

@Injectable()
export class PlaylistRenderService implements OnApplicationShutdown {
  private isRunning = false;
  private activeRender: Promise<void> | null = null;

  constructor(
    private db: PlaylistDbService,
    private s3: PlaylistS3Service,
    private playerConfig: PlayerConfigService,
    private schedulerPublisher: SchedulerEvaluatePublisherService,
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

    logger.info(
      `Playlist Publish Worker started in RabbitMQ event mode (bucket=${this.config.playlistBucket}, ` +
        `delivery=native-playlist)`,
    );
  }

  /** Publish exactly the playlist named in a RabbitMQ job. */
  async renderRequested(playlistId: string): Promise<void> {
    if (this.activeRender) {
      throw new Error(`Cannot publish ${playlistId}: another playlist publish is active`);
    }

    this.activeRender = this.doRenderRequested(playlistId);
    try {
      await this.activeRender;
    } finally {
      this.activeRender = null;
    }
  }

  private async doRenderRequested(playlistId: string): Promise<void> {
    if (!this.isRunning) throw new Error('Playlist render worker is not running');

    const playlist = (await this.db.pollForChanges(playlistId))[0];
    if (!playlist) {
      logger.info(`Playlist ${playlistId} does not need publishing; acknowledging job`);
      return;
    }

    await this.renderPlaylist(playlist);
  }

  private async renderPlaylist(pending: PendingPlaylist): Promise<void> {
    const startTime = Date.now();
    logger.info(
      `Publishing playlist "${pending.name}" (${pending.id}, ${pending.itemCount} items)`,
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

      const items = this.toNativePlaylistItems(playlist);
      if (items.length === 0) {
        throw new Error(
          'No playable items (all media missing, unsupported, or not READY)',
        );
      }

      await this.updatePlayerConfig(items);

      await this.db.markAsCompleted(
        pending.id,
        pending.sourceHash,
        null,
        items.reduce((total, item) => total + Math.ceil((item.durationMs ?? 0) / 1000), 0),
        '',
        '',
      );
      await this.schedulerPublisher
        .publishRenderCompleted(pending.id)
        .catch((error) => {
          logger.warn(
            `Playlist published for ${pending.id}, but scheduler manifest refresh could not be queued: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      logger.info(
        `✓ Published native playlist "${pending.name}" (${items.length} item(s), ${Date.now() - startTime}ms)`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.db.markAsFailed(pending.id, errorMsg);
      throw error;
    }
  }

  /**
   * Convert playlist rows to the native Player playlist contract. The Player
   * downloads and caches each URL, then plays the sequence locally.
   */
  private toNativePlaylistItems(playlist: PlaylistJson): Array<{
    id: string;
    type: MediaKind;
    src: string;
    url: string;
    muted: boolean;
    fit: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
    position: 'center' | 'top' | 'bottom' | 'left' | 'right';
    width: number;
    height: number;
    durationMs?: number;
  }> {
    const sorted = [...playlist.playlistItems].sort(
      (a, b) => a.position - b.position,
    );

    const items: Array<{
      id: string;
      type: MediaKind;
      src: string;
      url: string;
      muted: boolean;
      fit: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
      position: 'center' | 'top' | 'bottom' | 'left' | 'right';
      width: number;
      height: number;
      durationMs?: number;
    }> = [];
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

      items.push({
        id: item.id,
        type: kind,
        src: `media/${this.folderForKind(kind)}/${basename(item.media.filename).replace(/[/\\]/g, '_')}`,
        url: this.s3.publicUrlFor(this.config.mediaBucket, item.media.s3Key),
        muted: kind !== 'audio',
        fit: item.fit,
        position: item.objectPosition,
        width: playlist.displayWidth,
        height: playlist.displayHeight,
        durationMs: kind === 'image' || kind === 'audio' ? item.durationSec * 1000 : undefined,
      });
    }

    return items;
  }

  private detectKind(filename: string): MediaKind | null {
    if (VIDEO_EXT.test(filename)) return 'video';
    if (IMAGE_EXT.test(filename)) return 'image';
    if (AUDIO_EXT.test(filename)) return 'audio';
    return null;
  }

  private folderForKind(kind: MediaKind): 'videos' | 'images' | 'audio' {
    if (kind === 'image') return 'images';
    if (kind === 'audio') return 'audio';
    return 'videos';
  }

  private async updatePlayerConfig(items: Parameters<PlayerConfigService['replacePlaylist']>[0]): Promise<void> {
    if (this.config.playerConfigMode === 'exclusive') {
      await this.playerConfig.replacePlaylist(items);
    } else {
      for (const item of items) {
        await this.playerConfig.addToPlaylist(item);
      }
    }
  }

  /** Playlists deleted in the CMS: remove tracking. Native media assets are
   * shared by playlists, so the Player cache owns asset cleanup. */
  private async cleanupDeletedPlaylists(): Promise<void> {
    const deleted = await this.db.findDeletedPlaylists();

    for (const { playlistId, s3Key } of deleted) {
      logger.info(`Playlist ${playlistId} was deleted in the CMS, cleaning up`);

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
