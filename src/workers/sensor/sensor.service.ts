import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createLogger } from '../../common/logger';
import type { SensorEvent } from './sensor.types';

const logger = createLogger('SensorService');

/**
 * Sensor Worker
 *
 * Responsibilities (to implement):
 *  - Ingest sensor events from devices (motion, proximity, temperature,
 *    buttons, NFC, ...)
 *  - Evaluate tenant-defined sensor rules against incoming events
 *  - Trigger actions: play specific media, switch playlist, fire a
 *    notification, call a webhook
 *  - Store sensor history for analytics
 */
@Injectable()
export class SensorService implements OnApplicationShutdown {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Sensor worker started (skeleton — rule engine not implemented yet)');

    // TODO: replace with real sensor event source (DB table poll / queue / MQTT)
    this.pollingInterval = setInterval(() => {
      this.processPendingSensorEvents().catch((error) =>
        logger.error('Sensor processing error: %s', error?.message ?? error),
      );
    }, 15000);
  }

  private async processPendingSensorEvents(): Promise<void> {
    // TODO:
    // 1. Fetch unprocessed sensor events
    // 2. Load matching sensor rules for the tenant/sensor
    // 3. Evaluate conditions and execute actions
    // 4. Mark events processed + store history
  }

  async handleEvent(event: SensorEvent): Promise<void> {
    // TODO: implement rule evaluation for a single event
    logger.warn(`handleEvent() not implemented — ignoring sensor event ${event.id} (${event.type})`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    logger.info('Sensor worker stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
