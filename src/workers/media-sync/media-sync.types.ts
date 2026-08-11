export interface Media {
  id: string;
  tenantId: string;
  s3Key: string;
  fileName: string;
  fileSize: number;
  mimeType?: string; // hint derived from CMS media_types.name
  sourceType?: 'upload' | 'external_url';
  externalUrl?: string | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  contentHash?: string; // not present in CMS schema; checksum check skipped when absent
  syncAttempts: number;
  createdAt: Date;
}

export interface SyncResult {
  mediaId: string;
  success: boolean;
  localPath?: string;
  fileSize?: number;
  duration: number;
  error?: string;
}

export interface DiskStatus {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface MediaSyncConfig {
  playerMediaRootPath: string;
  s3Bucket: string;
  syncStrategy: 'polling' | 'listen';
  syncIntervalMs: number;
  syncConcurrency: number;
  enableChecksumValidation: boolean;
  maxDiskUsagePercent: number;
  cleanupOrphanedFiles: boolean;
}
