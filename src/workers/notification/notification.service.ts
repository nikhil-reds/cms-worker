import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createLogger } from '../../common/logger';
import type { NotificationEvent, NotificationDeliveryResult } from './notification.types';

const logger = createLogger('NotificationService');

/**
 * Notification Worker
 *
 * Responsibilities (to implement):
 *  - Poll/consume notification events (device offline, media sync failed,
 *    subscription past due, ticket updates, ...)
 *  - Apply tenant notification preferences before sending
 *  - Dedupe repeated alerts via dedupeKey
 *  - Deliver via channel: email / webhook / push / internal
 *  - Record delivery results and retry failures with backoff
 */
@Injectable()
export class NotificationService implements OnApplicationShutdown {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Notification worker started (skeleton — delivery logic not implemented yet)');

    // TODO: replace with real event source (DB table poll / queue consumer)
    this.pollingInterval = setInterval(() => {
      this.processPendingNotifications().catch((error) =>
        logger.error('Notification processing error: %s', error?.message ?? error),
      );
    }, 30000);
  }

  private async processPendingNotifications(): Promise<void> {
    // TODO:
    // 1. Fetch pending notification events
    // 2. Check tenant preferences + dedupe keys
    // 3. Send via the right channel (email/webhook/push/internal)
    // 4. Store delivery results, schedule retries for failures
  }

  async deliver(event: NotificationEvent): Promise<NotificationDeliveryResult> {
    // TODO: implement per-channel senders
    logger.warn(`deliver() not implemented — dropping event ${event.id} (${event.type})`);
    return {
      eventId: event.id,
      channel: event.channel,
      success: false,
      error: 'not implemented',
      deliveredAt: new Date(),
    };
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    logger.info('Notification worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
