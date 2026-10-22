import { z } from 'zod';

/**
 * Shape of the playlist JSON the CMS writes to
 * s3://{S3_BUCKET_PLAYLIST}/playlists/{id}.json (serializePlaylist in the
 * CMS playlist API routes). Only the fields the publisher needs are declared;
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
  zoneId: z.string().default('full-screen'),
  media: PlaylistMediaSchema,
});

export const PlaylistZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  color: z.string().optional(),
});

export const PlaylistJsonSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  displayName: z.string().default('Landscape 16:9'),
  displayWidth: z.number().int().positive().default(1920),
  displayHeight: z.number().int().positive().default(1080),
  layoutMode: z.enum(['zone', 'custom-grid']).default('zone'),
  gridRows: z.number().int().positive().default(3),
  gridColumns: z.number().int().positive().default(3),
  zonesJson: z.array(PlaylistZoneSchema).nullable().optional(),
  playlistItems: z.array(PlaylistItemSchema),
});

export type PlaylistJson = z.infer<typeof PlaylistJsonSchema>;
export type PlaylistJsonItem = z.infer<typeof PlaylistItemSchema>;

/** A playlist row that needs publishing, as detected by the poll query. */
export interface PendingPlaylist {
  id: string;
  tenantId: string;
  name: string;
  sourceHash: string;
  itemCount: number;
  renderAttempts: number;
}

export type MediaKind = 'video' | 'image' | 'audio';
export interface PlaylistRenderConfig {
  playerRootPath: string;
  playerMediaRootPath: string;
  mediaBucket: string; // media binaries (uploads/...)
  playlistBucket: string; // playlist JSON (playlists/{id}.json)
  processedBucket: string; // legacy processed bucket, retained for old tracking cleanup
  pollIntervalMs: number;
  /** append: native items join existing player playlist entries.
   *  exclusive: rendered video replaces the whole player playlist. */
  playerConfigMode: 'append' | 'exclusive';
  scratchDir: string;
}
