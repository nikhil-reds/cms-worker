import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createLogger } from '../../common/logger';
import type { AnalyticsEvent, IngestionBatchResult } from './analytics.types';

const logger = createLogger('AnalyticsService');

/**
 * Analytics Worker
 *
 * Responsibilities (to implement):
 *  - Ingest telemetry batches from devices (heartbeats, proof-of-play,
 *    playback errors, media download confirmations)
 *  - Validate + dedupe events (deterministic event IDs)
 *  - Batch-insert into the analytics store
 *  - Maintain hourly/daily rollups for dashboards
 *  - Emit derived events (e.g. device offline → notification worker)
 */
@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Analytics worker started (skeleton — ingestion logic not implemented yet)');

    // TODO: replace with real telemetry source (DB table poll / queue consumer)
    this.pollingInterval = setInterval(() => {
      this.ingestPendingEvents().catch((error) =>
        logger.error('Analytics ingestion error: %s', error?.message ?? error),
      );
    }, 30000);
  }

  private async ingestPendingEvents(): Promise<void> {
    // TODO:
    // 1. Fetch pending telemetry batches
    // 2. Validate schema + compute dedupe IDs
    // 3. Batch insert (1k-10k rows per insert)
    // 4. Update rollup tables
  }

  async ingestBatch(events: AnalyticsEvent[]): Promise<IngestionBatchResult> {
    // TODO: implement batch validation + insert
    logger.warn(`ingestBatch() not implemented — dropping ${events.length} events`);
    return {
      received: events.length,
      inserted: 0,
      duplicates: 0,
      failed: events.length,
      durationMs: 0,
    };
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    logger.info('Analytics worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
