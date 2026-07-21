import { Injectable } from '@nestjs/common';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../../common/logger';

const logger = createLogger('S3ClientService');

@Injectable()
export class S3ClientService {
  private s3Client: S3Client;

  constructor(
    private region: string,
    private accessKeyId: string,
    private secretAccessKey: string,
  ) {
    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
  }

  /**
   * Download file from S3 to local path
   */
  async downloadFile(
    bucket: string,
    s3Key: string,
    localPath: string,
    onProgress?: (progress: { loaded: number; total: number }) => void,
  ): Promise<{ path: string; size: number }> {
    try {
      // Ensure directory exists
      mkdirSync(dirname(localPath), { recursive: true });

      // Get object metadata for size
      const metadata = await this.getObjectMetadata(bucket, s3Key);
      const totalSize = metadata.contentLength || 0;
      let loadedSize = 0;

      logger.debug(`Downloading s3://${bucket}/${s3Key} (${this.formatBytes(totalSize)})`);

      return new Promise((resolve, reject) => {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: s3Key,
        });

        this.s3Client.send(command).then((response) => {
          const writeStream = createWriteStream(localPath);
          const readStream = response.Body as any;

          readStream.on('data', (chunk: Buffer) => {
            loadedSize += chunk.length;
            if (onProgress) {
              onProgress({ loaded: loadedSize, total: totalSize });
            }
          });

          readStream.pipe(writeStream);

          writeStream.on('finish', () => {
            logger.debug(`Downloaded s3://${bucket}/${s3Key} to ${localPath}`);
            resolve({ path: localPath, size: loadedSize });
          });

          writeStream.on('error', (error) => {
            logger.error(`Error writing file to ${localPath}`, error);
            reject(error);
          });

          readStream.on('error', (error) => {
            logger.error(`Error reading from S3`, error);
            reject(error);
          });
        }).catch((error) => {
          logger.error(`Error downloading from S3`, error);
          reject(error);
        });
      });
    } catch (error) {
      logger.error(`Failed to download s3://${bucket}/${s3Key}`, error);
      throw error;
    }
  }

  /**
   * Get object metadata from S3
   */
  async getObjectMetadata(bucket: string, s3Key: string): Promise<{
    contentLength?: number;
    etag?: string;
    lastModified?: Date;
  }> {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);

      return {
        contentLength: response.ContentLength,
        etag: response.ETag,
        lastModified: response.LastModified,
      };
    } catch (error) {
      logger.error(`Error fetching metadata for s3://${bucket}/${s3Key}`, error);
      throw error;
    }
  }

  /**
   * Check if object exists in S3
   */
  async objectExists(bucket: string, s3Key: string): Promise<boolean> {
    try {
      await this.getObjectMetadata(bucket, s3Key);
      return true;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Format bytes to human readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}
