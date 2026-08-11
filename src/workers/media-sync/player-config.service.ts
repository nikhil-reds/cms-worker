import { Injectable } from '@nestjs/common';
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { createLogger } from '../../common/logger';

const logger = createLogger('PlayerConfigService');

export type PlaylistItemType = 'video' | 'image' | 'audio' | 'html';

export interface PlaylistItem {
  id: string;
  type: PlaylistItemType;
  src: string; // relative to player root, e.g. "media/videos/promo.mp4"
  sourceType?: 'upload' | 'external_url';
  navigationPolicy?: 'same_origin' | 'allowlist' | 'allow_all';
  navigationAllowlist?: string[];
  reloadPolicy?: 'on_each_play' | 'once_per_playlist' | 'interval' | 'never';
  reloadIntervalMs?: number;
  loadTimeoutMs?: number;
  default?: boolean;
  muted?: boolean;
  loop?: boolean;
  fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  width?: number;
  height?: number;
  durationMs?: number; // used for images
}

interface PlayerConfig {
  playlist: PlaylistItem[];
  [key: string]: unknown;
}

/**
 * Updates the Player application's config.json so the player
 * automatically picks up and plays newly synced media.
 */
@Injectable()
export class PlayerConfigService {
  constructor(
    private readonly playerRootPath: string,
    private readonly playerApiUrl: string = '',
    private readonly playerApiToken: string = '',
  ) {}

  get isRemote(): boolean {
    return Boolean(this.playerApiUrl);
  }

  private get configPath(): string {
    return join(this.playerRootPath, 'config.json');
  }

  async uploadMediaFile(
    localPath: string,
    folder: 'videos' | 'images' | 'audio' | 'html',
    fileName: string,
  ): Promise<string> {
    if (!this.isRemote) {
      throw new Error('PLAYER_API_URL is not configured');
    }

    const response = await fetch(
      `${this.playerApiUrl}/api/media/${folder}/${encodeURIComponent(fileName)}`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        // Node fetch requires duplex when streaming a request body.
        duplex: 'half',
        body: createReadStream(localPath),
      } as unknown as RequestInit & { duplex: 'half' },
    );

    const body = (await response.json().catch(() => ({}))) as { src?: string; error?: string };

    if (!response.ok || !body.src) {
      throw new Error(body.error || `Player upload failed with HTTP ${response.status}`);
    }

    return body.src;
  }

  readConfig(): PlayerConfig {
    if (!existsSync(this.configPath)) {
      logger.warn(`Player config not found at ${this.configPath}, creating a new one`);
      return { playlist: [] };
    }

    const raw = readFileSync(this.configPath, 'utf-8');
    const config = JSON.parse(raw) as PlayerConfig;

    if (!Array.isArray(config.playlist)) {
      config.playlist = [];
    }

    return config;
  }

  /**
   * Add a synced media file to the player playlist (deduped by src).
   * Written atomically (tmp file + rename) so the player never reads
   * a half-written config.
   */
  async addToPlaylist(item: PlaylistItem): Promise<void> {
    if (this.isRemote) {
      await this.postJson('/api/playlist/add', item);
      logger.info(`Added remote playlist entry: ${item.src}`);
      return;
    }

    const config = this.readConfig();

    const existingIndex = config.playlist.findIndex((p) => p.src === item.src);

    if (existingIndex >= 0) {
      // Re-synced file: keep position, refresh metadata
      config.playlist[existingIndex] = { ...config.playlist[existingIndex], ...item };
      logger.info(`Updated playlist entry: ${item.src}`);
    } else {
      config.playlist.push(item);
      logger.info(`Added to playlist: ${item.src} (${config.playlist.length} items total)`);
    }

    this.writeConfig(config);
  }

  /**
   * Replace the entire player playlist with the given items.
   */
  async replacePlaylist(items: PlaylistItem[]): Promise<void> {
    if (this.isRemote) {
      await this.postJson('/api/playlist/replace', { playlist: items });
      logger.info(`Replaced remote player playlist (${items.length} item(s))`);
      return;
    }

    const config = this.readConfig();
    config.playlist = items;
    this.writeConfig(config);
    logger.info(`Replaced player playlist (${items.length} item(s))`);
  }

  /**
   * Remove playlist entries whose files no longer exist on disk.
   */
  async removeFromPlaylist(src: string): Promise<void> {
    if (this.isRemote) {
      await this.postJson('/api/playlist/remove', { src });
      logger.info(`Removed remote playlist entry: ${src}`);
      return;
    }

    const config = this.readConfig();
    const before = config.playlist.length;
    config.playlist = config.playlist.filter((p) => p.src !== src);

    if (config.playlist.length !== before) {
      this.writeConfig(config);
      logger.info(`Removed from playlist: ${src}`);
    }
  }

  private writeConfig(config: PlayerConfig): void {
    const tmpPath = `${this.configPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, this.configPath); // atomic on the same filesystem
  }

  private authHeaders(): Record<string, string> {
    return this.playerApiToken
      ? { Authorization: `Bearer ${this.playerApiToken}` }
      : {};
  }

  private async postJson(pathname: string, payload: unknown): Promise<void> {
    const response = await fetch(`${this.playerApiUrl}${pathname}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Player request failed with HTTP ${response.status}`);
    }
  }
}
