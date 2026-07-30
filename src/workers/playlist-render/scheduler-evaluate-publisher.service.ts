import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { createLogger } from '../../common/logger';

const logger = createLogger('SchedulerEvaluatePublisherService');

@Injectable()
export class SchedulerEvaluatePublisherService implements OnApplicationShutdown {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly queueName: string,
    private readonly enabled = true,
  ) {}

  async publishRenderCompleted(playlistId: string): Promise<void> {
    if (!this.enabled) {
      logger.debug('RabbitMQ scheduler publish disabled; skipping render-completed evaluate job');
      return;
    }

    const channel = await this.getChannel();
    const requestedAt = new Date().toISOString();
    const job = {
      type: 'scheduler.evaluate.now' as const,
      jobId: `playlist-render.completed:${playlistId}:${Date.now()}`,
      reason: 'playlist-render.completed',
      playlistId,
      requestedAt,
      idempotencyKey: `scheduler.evaluate.now:playlist-render.completed:${playlistId}:${requestedAt}`,
    };
    const body = Buffer.from(JSON.stringify(job));

    const accepted = channel.sendToQueue(this.queueName, body, {
      persistent: true,
      contentType: 'application/json',
      type: job.type,
      messageId: job.jobId,
      timestamp: Math.floor(Date.now() / 1000),
    });

    if (!accepted) {
      throw new Error(`RabbitMQ did not accept scheduler evaluate job for ${playlistId}`);
    }

    logger.info(`Queued scheduler manifest refresh for rendered playlist ${playlistId}`);
  }

  private async getChannel(): Promise<Channel> {
    if (this.channel) return this.channel;

    this.connection = await amqp.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.queueName, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });
    return this.channel;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }
}
