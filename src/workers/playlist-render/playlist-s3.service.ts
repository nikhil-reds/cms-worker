import { Injectable } from '@nestjs/common';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../../common/logger';
import { PlaylistJsonSchema, type PlaylistJson } from './playlist-render.types';

const logger = createLogger('PlaylistS3Service');

/**
 * S3 access for the playlist-render worker:
 *  - playlist JSON from the playlist bucket (playlists/{id}.json)
 *  - media binaries from the media bucket (by s3Key — the cdnUrl inside the
 *    JSON points at the private bucket and is never fetched directly)
 *  - rendered MP4s uploaded to the processed bucket
 */
@Injectable()
export class PlaylistS3Service {
  private s3Client: S3Client;

  constructor(
    private region: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly publicBaseUrl: string = '',
  ) {
    this.s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Fetch and validate playlists/{id}.json from the playlist bucket.
   * Returns null when the object is missing or fails validation, so the
   * caller can fall back to building the playlist from the database.
   */
  async fetchPlaylistJson(
    bucket: string,
    playlistId: string,
  ): Promise<PlaylistJson | null> {
    const key = `playlists/${playlistId}.json`;

    let raw: string;
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      raw = await (response.Body as any).transformToString('utf-8');
    } catch (error: any) {
      if (
        error.name === 'NoSuchKey' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        logger.warn(`Playlist JSON not found: s3://${bucket}/${key}`);
        return null;
      }
      throw error;
    }

    try {
      return PlaylistJsonSchema.parse(JSON.parse(raw));
    } catch (error) {
      logger.warn(
        `Playlist JSON at s3://${bucket}/${key} is invalid, falling back to DB: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return null;
    }
  }

  /** Stream an object to disk (large videos never sit in RAM). */
  async downloadFile(
    bucket: string,
    s3Key: string,
    localPath: string,
  ): Promise<string> {
    mkdirSync(dirname(localPath), { recursive: true });

    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
    );

    logger.debug(`Downloading s3://${bucket}/${s3Key} → ${localPath}`);

    return new Promise((resolve, reject) => {
      const readStream = response.Body as any;
      const writeStream = createWriteStream(localPath);

      readStream.pipe(writeStream);
      writeStream.on('finish', () => resolve(localPath));
      writeStream.on('error', reject);
      readStream.on('error', reject);
    });
  }

  /**
   * Upload a local file to S3 (multipart + streamed, so large rendered
   * videos never sit in RAM). Returns the object URL.
   */
  async uploadFile(
    bucket: string,
    s3Key: string,
    localPath: string,
    contentType: string,
  ): Promise<string> {
    logger.info(`Uploading ${localPath} → s3://${bucket}/${s3Key}`);

    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: createReadStream(localPath),
        ContentType: contentType,
      },
    });

    await upload.done();

    const baseUrl = this.publicBaseUrl || `https://${bucket}.s3.${this.region}.amazonaws.com`;
    const url = `${baseUrl.replace(/\/$/, '')}/${s3Key}`;
    logger.info(`✓ Uploaded to ${url}`);
    return url;
  }

  /** Delete an object (used when a playlist is removed in the CMS). */
  async deleteObject(bucket: string, s3Key: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }),
    );
    logger.info(`Deleted s3://${bucket}/${s3Key}`);
  }
}
