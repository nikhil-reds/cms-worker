import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createLogger } from './common/logger';

const logger = createLogger('Main');

async function bootstrap() {
  const workerRole = process.env.WORKER_ROLE || 'media-sync';

  try {
    logger.info(`Starting CMS Worker role=${workerRole}...`);

    // Create headless application context (no HTTP server)
    const app = await NestFactory.createApplicationContext(AppModule);

    logger.info('✓ Application context created');
    logger.info(`✓ CMS Worker role=${workerRole} is running`);

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully');
      await app.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully');
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error(`Failed to start CMS Worker role=${workerRole}`, error);
    process.exit(1);
  }
}

bootstrap();
