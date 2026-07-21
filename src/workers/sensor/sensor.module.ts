import { Module } from '@nestjs/common';
import { SensorService } from './sensor.service';
import { SensorProcessor } from './sensor.processor';

@Module({
  providers: [SensorService, SensorProcessor],
  exports: [SensorService],
})
export class SensorModule {}
