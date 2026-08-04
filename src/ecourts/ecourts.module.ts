import { Module } from '@nestjs/common';
import { EcourtsService } from './ecourts.service';

@Module({ providers: [EcourtsService], exports: [EcourtsService] })
export class EcourtsModule {}
