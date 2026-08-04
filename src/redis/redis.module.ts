import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, QueueService],
  exports: [RedisService, QueueService],
})
export class RedisModule {}
