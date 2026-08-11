import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { dirname, basename, join } from 'path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../common/logger';
import { DbListenerService } from './db-listener.service';
import { S3ClientService } from './s3-client.service';
import { FileSystemService } from './file-system.service';
import { PlayerConfigService } from './player-config.service';
import type { Media, MediaSyncConfig, SyncResult } from './media-sync.types';

const logger = createLogger('MediaSyncService');
const execFileAsync = promisify(execFile);

@Injectable()
export class MediaSyncService implements OnApplicationShutdown {
  private syncing = new Map<string, Promise<SyncResult>>();
  private pollingInterval: NodeJS.Timeout | null = null;
  private diskCheckInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private dbListener: DbListenerService,
    private s3Client: S3ClientService,
    private fileSystem: FileSystemService,
    private playerConfig: PlayerConfigService,
    private config: MediaSyncConfig,
  ) {}

  /**
   * Start the sync loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Media sync already running');
      return;
    }

    logger.info('Starting Media Sync Worker');

    try {
      this.isRunning = true;

      // Initialize database connection
      await this.dbListener.initialize();

      // Ensure media root directory exists
      await this.fileSystem.ensureDirectory(this.config.playerMediaRootPath);

      // Start polling loop
      this.startPollingLoop();

      // Start disk check loop
      this.startDiskCheckLoop();

      // Log stats
      const stats = await this.dbListener.getSyncStats();
      logger.info('Sync stats', stats);

      logger.info('Media Sync Worker started successfully');
    } catch (error) {
      logger.error('Failed to start Media Sync Worker', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Start polling for new media files
   */
  private startPollingLoop(): void {
    logger.info(`Starting polling loop (interval: ${this.config.syncIntervalMs}ms)`);

    // Poll immediately on start
    this.pollAndSync().catch((error) => logger.error('Error in polling', error));

    // Then poll at regular intervals
    this.pollingInterval = setInterval(() => {
      this.pollAndSync().catch((error) => logger.error('Error in polling', error));
    }, this.config.syncIntervalMs);
  }

  /**
   * Poll database and sync media files
   */
  private async pollAndSync(): Promise<void> {
    try {
      const mediaList = await this.dbListener.pollForChanges();

      if (mediaList.length === 0) {
        logger.debug('No pending media to sync');
        return;
      }

      logger.info(`Found ${mediaList.length} media items to sync`);

      // Sync with a fixed pool of workers (concurrency limit)
      const queue = [...mediaList];
      const workers = Array.from(
        { length: Math.min(this.config.syncConcurrency, queue.length) },
        async () => {
          while (queue.length > 0) {
            const media = queue.shift();
            if (!media) break;
            await this.syncMediaFile(media).catch((error) =>
              logger.error(`Sync error for ${media.id}: ${error}`),
            );
          }
        },
      );

      await Promise.all(workers);
      logger.debug('Polling cycle complete');
    } catch (error) {
      logger.error('Error in polling loop', error);
    }
  }

  /**
   * Sync a single media file
   */
  async syncMediaFile(media: Media): Promise<SyncResult> {
    const mediaId = media.id;

    // Prevent concurrent syncs of same file
    if (this.syncing.has(mediaId)) {
      logger.debug(`Already syncing ${mediaId}`);
      return this.syncing.get(mediaId)!;
    }

    const syncPromise = this._performSync(media);
    this.syncing.set(mediaId, syncPromise);

    try {
      const result = await syncPromise;
      return result;
    } finally {
      this.syncing.delete(mediaId);
    }
  }

  /**
   * Perform actual sync with error handling and retries
   */
  private async _performSync(media: Media): Promise<SyncResult> {
    const startTime = Date.now();
    const mediaId = media.id;

    try {
      // Mark as syncing
      await this.dbListener.markAsSyncing(mediaId);

      const typeFolder = this.fileSystem.getMediaTypeFolder(media.mimeType, media.fileName);
      const mediaType = typeFolder === 'videos' ? 'video' : typeFolder === 'images' ? 'image' : typeFolder === 'html' ? 'html' : 'audio';

      if (media.sourceType === 'external_url') {
        const externalUrl = this.validateHttpUrl(media.externalUrl);
        if (!externalUrl) {
          throw new Error(`External HTML media ${mediaId} is missing a valid http(s) URL`);
        }

        await this.dbListener.markAsCompleted(mediaId, externalUrl);
        await this.playerConfig.addToPlaylist({
          id: mediaId,
          type: 'html',
          sourceType: 'external_url',
          src: externalUrl,
          muted: true,
          fit: 'contain',
          position: 'center',
          durationMs: this.durationMs(media.durationSec, 20000),
          width: media.width ?? undefined,
          height: media.height ?? undefined,
          navigationPolicy: 'same_origin',
          reloadPolicy: 'on_each_play',
        });

        const duration = Date.now() - startTime;
        logger.info(`✓ Registered external HTML ${mediaId} (${externalUrl}) in ${duration}ms`);
        return {
          mediaId,
          success: true,
          localPath: externalUrl,
          fileSize: 0,
          duration,
        };
      }

      // Generate a download path. In local mode this is the player's media
      // folder; in remote mode this is a worker-side staging folder before
      // upload to the player over the LAN API.
      const htmlPackageRoot = typeFolder === 'html'
        ? this.fileSystem.generateHtmlPackageRoot(this.config.playerMediaRootPath, mediaId)
        : null;
      const localPath = typeFolder === 'html'
        ? join(htmlPackageRoot!, media.fileName.toLowerCase().endsWith('.zip') ? `${mediaId}.zip` : 'index.html')
        : this.fileSystem.generateLocalPath(
            this.config.playerMediaRootPath,
            media.fileName,
            media.mimeType,
          );

      logger.info(`Syncing: ${mediaId} (${media.s3Key} → ${localPath})`);

      // Ensure directory exists
      await this.fileSystem.ensureDirectory(dirname(localPath));

      // Download from S3 (bucket comes from worker config; the CMS
      // media table stores only the object key)
      const downloadResult = await this.s3Client.downloadFile(
        this.config.s3Bucket,
        media.s3Key,
        localPath,
        (progress) => {
          const percent = Math.round((progress.loaded / progress.total) * 100);
          logger.debug(`Downloading ${mediaId}: ${percent}%`);
        },
      );

      // Verify checksum if provided
      if (media.contentHash && this.config.enableChecksumValidation) {
        const isValid = await this.fileSystem.verifyChecksum(localPath, media.contentHash);

        if (!isValid) {
          throw new Error(
            `Checksum mismatch for ${mediaId}: expected ${media.contentHash}`,
          );
        }
      }

      // Mark as completed
      const playableHtmlSrc = typeFolder === 'html'
        ? await this.prepareHtmlForPlayback(media, localPath, htmlPackageRoot!)
        : null;
      await this.dbListener.markAsCompleted(mediaId, playableHtmlSrc ? join(this.config.playerMediaRootPath, playableHtmlSrc.replace(/^media\//, '')) : localPath);

      // Add to the player's playlist so it auto-plays — but only files the
      // player can actually render (skip .txt, .zip, .pdf, ... uploads).
      if (this.isPlayable(media.fileName)) {
        const src = playableHtmlSrc ?? (this.playerConfig.isRemote
          ? await this.playerConfig.uploadMediaFile(localPath, typeFolder, basename(localPath))
          : join('media', typeFolder, basename(localPath)).split('\\').join('/'));

        await this.playerConfig.addToPlaylist({
          id: mediaId,
          type: mediaType,
          src,
          ...(mediaType === 'html' ? {
            sourceType: 'upload' as const,
            navigationPolicy: 'same_origin' as const,
            reloadPolicy: 'on_each_play' as const,
          } : {}),
          muted: true,
          fit: mediaType === 'html' ? 'contain' : 'scale-down',
          position: 'center',
          ...(mediaType === 'image' ? { durationMs: 8000 } : {}),
          ...(mediaType === 'html' ? { durationMs: this.durationMs(media.durationSec, 20000), width: media.width ?? undefined, height: media.height ?? undefined } : {}),
        });
      } else {
        logger.warn(`Synced ${media.fileName} but did not add it to the playlist (not a playable media type)`);
      }

      const duration = Date.now() - startTime;
      logger.info(`✓ Synced ${mediaId} in ${duration}ms and added to player playlist`);

      return {
        mediaId,
        success: true,
        localPath,
        fileSize: downloadResult.size,
        duration,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startTime;

      await this.dbListener.markAsFailed(mediaId, errorMsg);

      return {
        mediaId,
        success: false,
        duration,
        error: errorMsg,
      };
    }
  }

  /**
   * Only video/image/audio files the player can render belong in the playlist.
   */
  private isPlayable(fileName: string): boolean {
    return /\.(mp4|mov|webm|mkv|avi|m4v|jpg|jpeg|png|gif|webp|bmp|mp3|wav|aac|m4a|ogg|html|htm|zip)$/i.test(fileName);
  }

  private validateHttpUrl(value?: string | null): string | null {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  private durationMs(durationSec: number | null | undefined, fallbackMs: number): number {
    return Number.isFinite(durationSec) && Number(durationSec) > 0
      ? Math.ceil(Number(durationSec) * 1000)
      : fallbackMs;
  }

  private async prepareHtmlForPlayback(media: Media, downloadedPath: string, packageRoot: string): Promise<string> {
    if (this.playerConfig.isRemote) {
      if (media.fileName.toLowerCase().endsWith('.zip')) {
        throw new Error('Remote player HTML ZIP installation is not supported by the LAN file upload API yet');
      }
      return this.playerConfig.uploadMediaFile(downloadedPath, 'html', 'index.html');
    }

    if (!media.fileName.toLowerCase().endsWith('.zip')) {
      return join('media', 'html', media.id, 'index.html').split('\\').join('/');
    }

    const nextRoot = `${packageRoot}.next`;
    const previousRoot = `${packageRoot}.previous`;
    rmSync(nextRoot, { recursive: true, force: true });
    mkdirSync(nextRoot, { recursive: true });

    await this.validateZipEntries(downloadedPath);
    await execFileAsync('unzip', ['-q', downloadedPath, '-d', nextRoot]);
    this.validateExtractedHtmlPackage(nextRoot);

    rmSync(previousRoot, { recursive: true, force: true });
    if (existsSync(packageRoot)) {
      renameSync(packageRoot, previousRoot);
    }
    renameSync(nextRoot, packageRoot);
    rmSync(previousRoot, { recursive: true, force: true });

    return join('media', 'html', media.id, 'index.html').split('\\').join('/');
  }

  private validateExtractedHtmlPackage(packageRoot: string): void {
    const indexPath = join(packageRoot, 'index.html');
    if (!existsSync(indexPath)) {
      throw new Error('HTML ZIP package must contain index.html at the archive root');
    }
  }

  private async validateZipEntries(zipPath: string): Promise<void> {
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath]);
    const entries = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean);
    if (!entries.includes('index.html')) {
      throw new Error('HTML ZIP package must contain index.html at the archive root');
    }
    for (const entry of entries) {
      if (
        entry.startsWith('/') ||
        entry.includes('..') ||
        entry.includes('\\') ||
        entry.startsWith('__MACOSX/')
      ) {
        throw new Error(`Unsafe HTML ZIP entry: ${entry}`);
      }
    }
  }

  /**
   * Start disk space monitoring
   */
  private startDiskCheckLoop(): void {
    logger.info('Starting disk check loop');

    // Check immediately
    this.checkDiskSpace().catch((error) => logger.error('Error in disk check', error));

    // Then check at regular intervals (every 5 minutes by default)
    this.diskCheckInterval = setInterval(() => {
      this.checkDiskSpace().catch((error) => logger.error('Error in disk check', error));
    }, 300000); // 5 minutes
  }

  /**
   * Check disk space and cleanup if needed
   */
  private async checkDiskSpace(): Promise<void> {
    try {
      const diskStatus = await this.fileSystem.getDiskStatus(
        this.config.playerMediaRootPath,
        1099511627776, // 1TB default
      );

      logger.debug(`Disk usage: ${diskStatus.usagePercent}% (${this.formatBytes(diskStatus.usedBytes)})`);

      if (diskStatus.usagePercent > this.config.maxDiskUsagePercent) {
        logger.warn(
          `Disk usage ${diskStatus.usagePercent}% exceeds threshold ${this.config.maxDiskUsagePercent}%, cleaning up...`,
        );

        // Calculate target free space (try to get to 70% usage)
        const targetUsagePercent = this.config.maxDiskUsagePercent - 10;
        const targetUsedBytes = (diskStatus.totalBytes * targetUsagePercent) / 100;
        const targetFreeBytes = diskStatus.usedBytes - targetUsedBytes;

        const freedBytes = await this.fileSystem.cleanupOldestFiles(
          this.config.playerMediaRootPath,
          targetFreeBytes,
        );

        logger.info(`Freed ${this.formatBytes(freedBytes)} of disk space`);
      }
    } catch (error) {
      logger.error('Error checking disk space', error);
    }
  }

  /**
   * Get current sync statistics
   */
  async getStats(): Promise<any> {
    try {
      const stats = await this.dbListener.getSyncStats();
      const diskStatus = await this.fileSystem.getDiskStatus(
        this.config.playerMediaRootPath,
      );

      return {
        database: stats,
        disk: diskStatus,
        activeSyncs: this.syncing.size,
      };
    } catch (error) {
      logger.error('Error getting stats', error);
      throw error;
    }
  }

  /**
   * Stop the sync loop
   */
  async stop(): Promise<void> {
    logger.info('Stopping Media Sync Worker');

    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.diskCheckInterval) {
      clearInterval(this.diskCheckInterval);
      this.diskCheckInterval = null;
    }

    // Wait for all syncs to complete
    if (this.syncing.size > 0) {
      logger.info(`Waiting for ${this.syncing.size} syncs to complete`);
      await Promise.all(Array.from(this.syncing.values()));
    }

    await this.dbListener.close();
    logger.info('Media Sync Worker stopped');
  }

  /**
   * Handle application shutdown
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Format bytes to human readable
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}
