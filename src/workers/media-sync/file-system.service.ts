import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, unlinkSync, readdirSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../../common/logger';
import { DiskStatus } from './media-sync.types';

const logger = createLogger('FileSystemService');

@Injectable()
export class FileSystemService {
  /**
   * Ensure directory exists, create if needed
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    try {
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
        logger.debug(`Created directory: ${dirPath}`);
      }
    } catch (error) {
      logger.error(`Error creating directory ${dirPath}`, error);
      throw error;
    }
  }

  /**
   * Calculate SHA256 checksum of a file
   */
  async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
          const digest = hash.digest('hex');
          logger.debug(`Calculated checksum for ${filePath}: ${digest}`);
          resolve(digest);
        });
        stream.on('error', reject);
      } catch (error) {
        logger.error(`Error calculating checksum for ${filePath}`, error);
        reject(error);
      }
    });
  }

  /**
   * Verify file checksum
   */
  async verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      const actualChecksum = await this.calculateChecksum(filePath);
      const isValid = actualChecksum === expectedChecksum;

      if (!isValid) {
        logger.warn(
          `Checksum mismatch for ${filePath}: expected ${expectedChecksum}, got ${actualChecksum}`,
        );
      } else {
        logger.debug(`Checksum verified for ${filePath}`);
      }

      return isValid;
    } catch (error) {
      logger.error(`Error verifying checksum for ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(filePath: string): Promise<void> {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        logger.debug(`Deleted file: ${filePath}`);
      }
    } catch (error) {
      logger.error(`Error deleting file ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Get file size in bytes
   */
  async getFileSize(filePath: string): Promise<number> {
    try {
      if (!existsSync(filePath)) {
        return 0;
      }
      const stats = statSync(filePath);
      return stats.size;
    } catch (error) {
      logger.error(`Error getting file size for ${filePath}`, error);
      return 0;
    }
  }

  /**
   * Get total size of all files in a directory
   */
  async getTotalDirectorySize(dirPath: string): Promise<number> {
    try {
      if (!existsSync(dirPath)) {
        return 0;
      }

      let totalSize = 0;

      const walkDir = (path: string) => {
        const files = readdirSync(path);

        for (const file of files) {
          const filePath = join(path, file);
          const stats = statSync(filePath);

          if (stats.isDirectory()) {
            totalSize += walkDir(filePath);
          } else {
            totalSize += stats.size;
          }
        }

        return totalSize;
      };

      totalSize = walkDir(dirPath);
      logger.debug(`Total directory size for ${dirPath}: ${this.formatBytes(totalSize)}`);
      return totalSize;
    } catch (error) {
      logger.error(`Error calculating directory size for ${dirPath}`, error);
      return 0;
    }
  }

  /**
   * Get disk status (available space, usage percentage, etc.)
   */
  async getDiskStatus(dirPath: string, totalDiskSize: number = 1099511627776): Promise<DiskStatus> {
    try {
      // For production, use df command or similar to get real disk stats
      // This is a simplified implementation
      const usedBytes = await this.getTotalDirectorySize(dirPath);
      const availableBytes = totalDiskSize - usedBytes;
      const usagePercent = (usedBytes / totalDiskSize) * 100;

      return {
        totalBytes: totalDiskSize,
        usedBytes,
        availableBytes,
        usagePercent: Math.round(usagePercent * 100) / 100,
      };
    } catch (error) {
      logger.error(`Error getting disk status`, error);
      throw error;
    }
  }

  /**
   * Clean up oldest files to reach target size
   */
  async cleanupOldestFiles(dirPath: string, targetFreeBytes: number): Promise<number> {
    try {
      if (!existsSync(dirPath)) {
        return 0;
      }

      logger.warn(`Cleaning up old files to free ${this.formatBytes(targetFreeBytes)}`);

      const files = this.getFilesWithTimestamps(dirPath);
      files.sort((a, b) => a.modifiedTime - b.modifiedTime); // Sort by oldest first

      let freedBytes = 0;

      for (const file of files) {
        if (freedBytes >= targetFreeBytes) {
          break;
        }

        try {
          unlinkSync(file.path);
          freedBytes += file.size;
          logger.debug(`Deleted old file: ${file.path} (freed ${this.formatBytes(file.size)})`);
        } catch (error) {
          logger.warn(`Failed to delete file ${file.path}`, error);
        }
      }

      logger.info(`Freed ${this.formatBytes(freedBytes)} by deleting old files`);
      return freedBytes;
    } catch (error) {
      logger.error(`Error cleaning up old files`, error);
      return 0;
    }
  }

  /**
   * Get all files in directory with their timestamps
   */
  private getFilesWithTimestamps(dirPath: string): Array<{ path: string; size: number; modifiedTime: number }> {
    let files: Array<{ path: string; size: number; modifiedTime: number }> = [];

    try {
      const walkDir = (path: string) => {
        const entries = readdirSync(path);

        for (const entry of entries) {
          const filePath = join(path, entry);
          const stats = statSync(filePath);

          if (stats.isDirectory()) {
            walkDir(filePath);
          } else {
            files.push({
              path: filePath,
              size: stats.size,
              modifiedTime: stats.mtimeMs,
            });
          }
        }
      };

      walkDir(dirPath);
    } catch (error) {
      logger.error(`Error walking directory ${dirPath}`, error);
    }

    return files;
  }

  /**
   * Format bytes to human readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Determine the player media folder (videos/images/audio/html) for a file,
   * based on its mime type with a file-extension fallback.
   */
  getMediaTypeFolder(mimeType?: string, fileName?: string): 'videos' | 'images' | 'audio' | 'html' {
    if (mimeType) {
      if (mimeType.startsWith('video/')) return 'videos';
      if (mimeType.startsWith('image/')) return 'images';
      if (mimeType.startsWith('audio/')) return 'audio';
      if (mimeType.startsWith('text/html') || mimeType.includes('html')) return 'html';
    }

    const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'images';
    if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'].includes(ext)) return 'audio';
    if (['html', 'htm', 'zip'].includes(ext)) return 'html';
    return 'videos'; // default: mp4, mov, webm, mkv, ...
  }

  /**
   * Generate local path inside the Player media folder.
   * Matches the player's layout: {root}/{videos|images|audio}/{fileName}
   */
  generateLocalPath(rootPath: string, fileName: string, mimeType?: string): string {
    const typeFolder = this.getMediaTypeFolder(mimeType, fileName);
    // Sanitize the filename so a weird DB value can't escape the media folder
    const safeName = fileName.replace(/[/\\]/g, '_');
    return join(rootPath, typeFolder, safeName);
  }

  generateHtmlPackageRoot(rootPath: string, mediaId: string): string {
    return join(rootPath, 'html', mediaId.replace(/[/\\]/g, '_'));
  }
}
