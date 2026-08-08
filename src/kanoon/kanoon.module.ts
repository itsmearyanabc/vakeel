import { Module } from '@nestjs/common';
import { KanoonService } from './kanoon.service';

@Module({
  providers: [KanoonService],
  exports: [KanoonService],
})
export class KanoonModule {}
