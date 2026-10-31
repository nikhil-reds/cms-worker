import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../common/logger';
import type { SensorTrigger } from './sensor-triggers';

const logger = createLogger('ManifestPublisherService');

export interface PlayerManifestItem {
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
  navigationPolicy?: 'same_origin' | 'allowlist' | 'allow_all';
  navigationAllowlist?: string[];
  reloadPolicy?: 'on_each_play' | 'once_per_playlist' | 'interval' | 'never';
  reloadIntervalMs?: number;
  loadTimeoutMs?: number;
  loop?: boolean;
  muted?: boolean;
  fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface PlayerManifest {
  schemaVersion: 3;
  deviceId: string;
  revision: string;
  serverNow?: string;
  active?: PlayerManifestPlaylistRef | null;
  schedules?: Array<{
    id: string;
    name: string;
    playlistId: string;
    playlistVersion: string;
    priority: number;
    startAt: string;
    endAt: string;
    daysOfWeek: number[];
  }>;
}

export interface PlayerManifestZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerManifestCanvas {
  width: number;
  height: number;
}

export interface PlayerManifestPlaylistRef {
  playlistId: string;
  playlistVersion: string;
}

export interface PlaylistManifest {
  schemaVersion: 3 | 4 | 5;
  playlistId: string;
  playlistVersion: string;
  revision: string;
  serverNow?: string;
  canvas?: PlayerManifestCanvas;
  zones?: PlayerManifestZone[];
  items: PlayerManifestItem[];
  sensorTriggers?: SensorTrigger[];
}

@Injectable()
export class ManifestPublisherService {
  private readonly s3Client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly region: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly publicBaseUrl = '',
    private readonly keyPrefix = 'manifests',
  ) {
    this.s3Client = new S3Client({
      ...(process.env.S3_ENDPOINT_URL ? { endpoint: process.env.S3_ENDPOINT_URL, forcePathStyle: true } : {}),
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  get enabled(): boolean {
    return Boolean(this.bucket);
  }

  /** Every screen gets its own manifest object, keyed by its CMS device id. */
  manifestKeyFor(deviceId: string): string {
    return `${this.keyPrefix.replace(/\/$/, '')}/${deviceId}.json`;
  }

  manifestUrlFor(deviceId: string): string {
    const key = this.manifestKeyFor(deviceId);

    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  playlistManifestKeyFor(playlistId: string, playlistVersion: string): string {
    return `playlists/${encodeURIComponent(playlistId)}/v${encodeURIComponent(playlistVersion)}.json`;
  }

  playlistManifestUrlFor(playlistId: string, playlistVersion: string): string {
    const key = this.playlistManifestKeyFor(playlistId, playlistVersion);

    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async publish(manifest: PlayerManifest): Promise<string> {
    if (!this.enabled) {
      throw new Error('Player manifest publishing is not configured');
    }
    if (!manifest.deviceId) {
      throw new Error('Cannot publish a manifest without a deviceId');
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.manifestKeyFor(manifest.deviceId),
        Body: `${JSON.stringify(manifest, null, 2)}\n`,
        ContentType: 'application/json',
        CacheControl: 'no-store',
      }),
    );

    const manifestUrl = this.manifestUrlFor(manifest.deviceId);
    logger.info(
      `Published player manifest revision ${manifest.revision} to ${manifestUrl}`,
    );

    return manifestUrl;
  }

  async publishPlaylist(manifest: PlaylistManifest): Promise<string> {
    if (!this.enabled) {
      throw new Error('Player manifest publishing is not configured');
    }
    if (!manifest.playlistId || !manifest.playlistVersion) {
      throw new Error('Cannot publish a playlist manifest without playlistId and playlistVersion');
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.playlistManifestKeyFor(manifest.playlistId, manifest.playlistVersion),
        Body: `${JSON.stringify(manifest, null, 2)}\n`,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    const manifestUrl = this.playlistManifestUrlFor(
      manifest.playlistId,
      manifest.playlistVersion,
    );
    logger.info(
      `Published playlist manifest ${manifest.playlistId}@${manifest.playlistVersion} to ${manifestUrl}`,
    );

    return manifestUrl;
  }
}
