import { z } from 'zod';

/**
 * Shape of the playlist JSON the CMS writes to
 * s3://{S3_BUCKET_PLAYLIST}/playlists/{id}.json (serializePlaylist in the
 * CMS playlist API routes). Only the fields the renderer needs are declared;
 * unknown fields pass through.
 *
 * Note: media.cdnUrl in this JSON points at the PRIVATE media bucket and is
 * not presigned — it must never be fetched directly. Downloads always go
 * through the S3 SDK using media.s3Key.
 */
export const PlaylistMediaSchema = z.object({
  id: z.string(),
  name: z.string(),
  filename: z.string(),
  s3Key: z.string(),
  sizeBytes: z.coerce.number().optional(), // BigInt serialized as string
  durationSec: z.number().nullable().optional(),
  status: z.string(),
  mediaTypeId: z.string().optional(),
});

export const PlaylistItemSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  position: z.number(),
  durationSec: z.number(),
  fit: z
    .enum(['cover', 'contain', 'fill', 'none', 'scale-down'])
    .default('scale-down'),
  objectPosition: z
    .enum(['center', 'top', 'bottom', 'left', 'right'])
    .default('center'),
  media: PlaylistMediaSchema,
});

export const PlaylistJsonSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  displayName: z.string().default('Landscape 16:9'),
  displayWidth: z.number().int().positive().default(1920),
  displayHeight: z.number().int().positive().default(1080),
  playlistItems: z.array(PlaylistItemSchema),
});

export type PlaylistJson = z.infer<typeof PlaylistJsonSchema>;
export type PlaylistJsonItem = z.infer<typeof PlaylistItemSchema>;

/** A playlist row that needs (re-)rendering, as detected by the poll query. */
export interface PendingPlaylist {
  id: string;
  tenantId: string;
  name: string;
  sourceHash: string;
  itemCount: number;
  renderAttempts: number;
}

export type MediaKind = 'video' | 'image' | 'audio';
export type MediaFit = 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
export type MediaPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** A playlist item whose media file has been located on local disk. */
export interface ResolvedItem {
  mediaId: string;
  position: number;
  durationSec: number;
  fit: MediaFit;
  objectPosition: MediaPosition;
  kind: MediaKind;
  localPath: string;
}

export interface RenderOutput {
  outputPath: string;
  durationSec: number;
}

export interface RenderResolution {
  width: number;
  height: number;
}

/** Where a completed render ended up (local player + S3). */
export interface InstalledRender {
  localSrc: string; // relative to player root, e.g. media/videos/playlist-{id}.mp4
  s3Key: string; // key in the processed bucket, e.g. playlists/{id}.mp4
  s3Url: string;
}

export interface PlaylistRenderConfig {
  playerRootPath: string;
  playerMediaRootPath: string;
  mediaBucket: string; // media binaries (uploads/...)
  playlistBucket: string; // playlist JSON (playlists/{id}.json)
  processedBucket: string; // rendered playlist MP4s are uploaded here
  pollIntervalMs: number;
  resolution: RenderResolution;
  fps: number;
  /** append: rendered video joins existing player playlist entries.
   *  exclusive: rendered video replaces the whole player playlist. */
  playerConfigMode: 'append' | 'exclusive';
  /** natural: a source video shorter than durationSec plays once.
   *  loop: it loops until durationSec is filled. */
  shortVideoBehavior: 'natural' | 'loop';
  scratchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
}
