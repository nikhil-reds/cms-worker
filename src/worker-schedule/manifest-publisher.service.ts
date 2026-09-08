import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../common/logger';

const logger = createLogger('ManifestPublisherService');

export interface PlayerManifestItem {
  id: string;
  type: 'video' | 'image' | 'audio' | 'html';
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
  schemaVersion: 1;
  deviceId: string;
  revision: string;
  serverNow?: string;
  playlist: PlayerManifestItem[];
  playlists?: Array<{
    id: string;
    items: PlayerManifestItem[];
  }>;
  schedules?: Array<{
    id: string;
    name: string;
    playlistId: string;
    priority: number;
    startAt: string;
    endAt: string;
    daysOfWeek: number[];
  }>;
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
}
