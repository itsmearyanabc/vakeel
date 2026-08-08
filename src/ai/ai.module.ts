import { Module } from '@nestjs/common';
import { KanoonModule } from '../kanoon/kanoon.module';
import { EmbeddingService } from './embedding.service';
import { GuardrailsService } from './guardrails.service';
import { IntentService } from './intent.service';
import { ChatMemoryService } from './memory/chat-memory.service';
import { PrecedentsService } from './precedents.service';
import { ProviderRegistry } from './providers/provider.registry';
import { RagService } from './rag.service';
import { TranscriptionService } from './transcription.service';

const providers = [
  ProviderRegistry,
  EmbeddingService,
  IntentService,
  GuardrailsService,
  RagService,
  PrecedentsService,
  TranscriptionService,
  ChatMemoryService,
];

@Module({ imports: [KanoonModule], providers, exports: providers })
export class AiModule {}
