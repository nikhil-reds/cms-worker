import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { createLogger } from '../common/logger';

const logger = createLogger('SchedulerRedisService');

@Injectable()
export class SchedulerRedisService implements OnApplicationShutdown {
  private readonly redis: Redis | null;

  constructor(
    redisUrl: string,
    private readonly enabled = true,
  ) {
    this.redis = enabled ? new Redis(redisUrl, { lazyConnect: true }) : null;
  }

  async initialize(): Promise<void> {
    if (!this.redis) return;
    await this.redis.connect();
    logger.info('Redis connection successful');
  }

  async isProcessed(key: string): Promise<boolean> {
    if (!this.redis) return false;
    return (await this.redis.exists(`scheduler:idempotency:${key}`)) === 1;
  }

  async markProcessed(key: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`scheduler:idempotency:${key}`, '1', 'EX', 86400);
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (!this.redis) return crypto.randomUUID();

    const token = crypto.randomUUID();
    const result = await this.redis.set(`scheduler:lock:${key}`, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (!this.redis) return;

    await this.redis.eval(
      `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
      `,
      1,
      `scheduler:lock:${key}`,
      token,
    );
  }

  async setActiveState(
    key: string,
    value: Record<string, unknown>,
    ttlSeconds = 3600,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`scheduler:active:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async getManifestState(deviceId: string): Promise<{
    contentHash: string;
    revision: string;
    manifestUrl?: string;
  } | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(`scheduler:manifest:${deviceId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async setManifestState(
    deviceId: string,
    state: { contentHash: string; revision: string; manifestUrl?: string },
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`scheduler:manifest:${deviceId}`, JSON.stringify(state));
  }

  async getPlayerRevision(deviceId: string): Promise<string | null> {
    if (!this.redis) return null;
    return this.redis.get(`scheduler:player-revision:${deviceId}`);
  }

  async setPlayerRevision(deviceId: string, revision: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(`scheduler:player-revision:${deviceId}`, revision);
  }

  async close(): Promise<void> {
    if (!this.redis) return;
    this.redis.disconnect();
    logger.info('Redis connection closed');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
