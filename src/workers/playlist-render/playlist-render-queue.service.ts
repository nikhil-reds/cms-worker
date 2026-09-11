import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { createLogger } from '../../common/logger';
import { PlaylistRenderService } from './playlist-render.service';

const logger = createLogger('PlaylistRenderQueueService');

interface PlaylistRenderJob {
  jobId?: string;
  type: 'playlist.render.requested';
  playlistId: string;
}

/**
 * Event-driven render consumer. CMS publishes one durable job whenever a
 * playlist is published; this worker acknowledges only after rendering has
 * completed. Failed work is delayed and retried, then sent to a DLQ.
 */
@Injectable()
export class PlaylistRenderQueueService implements OnApplicationShutdown {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;

  constructor(
    private readonly renderer: PlaylistRenderService,
    private readonly rabbitmqUrl: string,
    private readonly queueName: string,
    private readonly retryQueueName: string,
    private readonly deadLetterQueueName: string,
    private readonly retryDelayMs: number,
    private readonly maxRetries: number,
    private readonly enabled: boolean,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('RabbitMQ playlist render queue consumer disabled');
      return;
    }

    this.connection = await amqp.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.assertQueues(this.channel);
    // ffmpeg is CPU intensive; deliberately process a single render at once.
    await this.channel.prefetch(1);

    const result = await this.channel.consume(
      this.queueName,
      (message) => {
        if (!message) return;
        this.handleMessage(message).catch((error) =>
          logger.error('Unexpected playlist render queue handler failure', error),
        );
      },
      { noAck: false },
    );
    this.consumerTag = result.consumerTag;
    logger.info(`Consuming RabbitMQ queue ${this.queueName} (prefetch=1)`);
  }

  private async assertQueues(channel: Channel): Promise<void> {
    await channel.assertQueue(this.deadLetterQueueName, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });
    await channel.assertQueue(this.queueName, {
      durable: true,
      arguments: { 'x-queue-type': 'classic' },
    });
    await channel.assertQueue(this.retryQueueName, {
      durable: true,
      arguments: {
        'x-queue-type': 'classic',
        'x-message-ttl': this.retryDelayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': this.queueName,
      },
    });
  }

  private async handleMessage(message: ConsumeMessage): Promise<void> {
    if (!this.channel) return;

    try {
      const job = JSON.parse(message.content.toString('utf8')) as PlaylistRenderJob;
      if (job.type !== 'playlist.render.requested' || !job.playlistId) {
        throw new Error('Unsupported or invalid playlist render job');
      }

      await this.renderer.renderRequested(job.playlistId);
      this.channel.ack(message);
    } catch (error) {
      logger.error('Playlist render job failed', error);
      this.retryOrDeadLetter(message, error);
    }
  }

  private retryOrDeadLetter(message: ConsumeMessage, error: unknown): void {
    if (!this.channel) return;

    const retries = Number(message.properties.headers?.retries || 0);
    const nextRetries = retries + 1;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const target = nextRetries > this.maxRetries ? this.deadLetterQueueName : this.retryQueueName;

    this.channel.sendToQueue(target, message.content, {
      persistent: true,
      contentType: message.properties.contentType || 'application/json',
      messageId: message.properties.messageId,
      type: message.properties.type,
      headers: {
        ...message.properties.headers,
        retries: nextRetries,
        failedAt: new Date().toISOString(),
        error: errorMessage,
      },
    });
    this.channel.ack(message);

    if (target === this.deadLetterQueueName) {
      logger.error(`Playlist render job moved to DLQ ${target} after ${retries} retries`);
    } else {
      logger.warn(`Playlist render job retry ${nextRetries}/${this.maxRetries} queued`);
    }
  }

  async stop(): Promise<void> {
    if (this.channel && this.consumerTag) await this.channel.cancel(this.consumerTag);
    if (this.channel) await this.channel.close();
    if (this.connection) await this.connection.close();
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
    logger.info('RabbitMQ playlist render queue consumer stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
