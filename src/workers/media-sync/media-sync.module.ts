import { Module } from '@nestjs/common';
import { join } from 'path';
import { MediaSyncProcessor } from './media-sync.processor';
import { MediaSyncService } from './media-sync.service';
import { DbListenerService } from './db-listener.service';
import { S3ClientService } from './s3-client.service';
import { FileSystemService } from './file-system.service';
import { PlayerConfigService } from './player-config.service';
import { MediaSyncConfig } from './media-sync.types';

const PLAYER_ROOT = process.env.PLAYER_ROOT_PATH || '/Users/nikhil/Desktop/player';
const PLAYER_API_URL = (process.env.PLAYER_API_URL || '').replace(/\/$/, '');

@Module({
  providers: [
    {
      provide: 'MEDIA_SYNC_CONFIG',
      useFactory: (): MediaSyncConfig => ({
        playerMediaRootPath:
          process.env.PLAYER_MEDIA_ROOT_PATH ||
          (PLAYER_API_URL ? '/tmp/cms-worker/player-media' : join(PLAYER_ROOT, 'media')),
        s3Bucket:
          process.env.AWS_BUCKET_MEDIA || process.env.S3_BUCKET || process.env.AWS_BUCKET || '',
        syncStrategy: (process.env.MEDIA_SYNC_STRATEGY as any) || 'polling',
        syncIntervalMs: parseInt(process.env.MEDIA_SYNC_INTERVAL_MS || '30000'),
        syncConcurrency: parseInt(process.env.MEDIA_SYNC_CONCURRENCY || '5'),
        enableChecksumValidation: process.env.MEDIA_ENABLE_CHECKSUM_VALIDATION !== 'false',
        maxDiskUsagePercent: parseInt(process.env.MEDIA_MAX_DISK_USAGE_PERCENT || '80'),
        cleanupOrphanedFiles: process.env.MEDIA_CLEANUP_ORPHANED_FILES === 'true',
      }),
    },
    {
      provide: DbListenerService,
      useFactory: () => new DbListenerService(process.env.DATABASE_URL || ''),
    },
    {
      provide: S3ClientService,
      useFactory: () =>
        new S3ClientService(
          process.env.AWS_REGION || 'us-east-1',
          process.env.AWS_ACCESS_KEY_ID || '',
          process.env.AWS_SECRET_ACCESS_KEY || '',
        ),
    },
    {
      provide: PlayerConfigService,
      useFactory: () =>
        new PlayerConfigService(
          PLAYER_ROOT,
          PLAYER_API_URL,
          process.env.PLAYER_API_TOKEN || '',
        ),
    },
    FileSystemService,
    {
      provide: MediaSyncService,
      useFactory: (
        dbListener: DbListenerService,
        s3Client: S3ClientService,
        fileSystem: FileSystemService,
        playerConfig: PlayerConfigService,
        config: MediaSyncConfig,
      ) => new MediaSyncService(dbListener, s3Client, fileSystem, playerConfig, config),
      inject: [
        DbListenerService,
        S3ClientService,
        FileSystemService,
        PlayerConfigService,
        'MEDIA_SYNC_CONFIG',
      ],
    },
    MediaSyncProcessor,
  ],
  exports: [MediaSyncService],
})
export class MediaSyncModule {}
