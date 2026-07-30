import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../common/logger';

const logger = createLogger('ManifestPublisherService');

export interface PlayerManifestItem {
  id: string;
  type: 'video' | 'image' | 'audio';
  src: string;
  url: string;
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
    private readonly key: string,
    private readonly region: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly publicBaseUrl = '',
  ) {
    this.s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  get enabled(): boolean {
    return Boolean(this.bucket && this.key);
  }

  get manifestUrl(): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${this.key}`;
    }

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${this.key}`;
  }

  async publish(manifest: PlayerManifest): Promise<string> {
    if (!this.enabled) {
      throw new Error('Player manifest publishing is not configured');
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: `${JSON.stringify(manifest, null, 2)}\n`,
        ContentType: 'application/json',
        CacheControl: 'no-store',
      }),
    );

    logger.info(
      `Published player manifest revision ${manifest.revision} to ${this.manifestUrl}`,
    );

    return this.manifestUrl;
  }
}
