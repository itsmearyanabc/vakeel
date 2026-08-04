import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { GuardrailsService } from './guardrails.service';
import { IntentService } from './intent.service';
import { ProviderRegistry } from './providers/provider.registry';
import { RagService } from './rag.service';
import { TranscriptionService } from './transcription.service';

const providers = [
  ProviderRegistry,
  EmbeddingService,
  IntentService,
  GuardrailsService,
  RagService,
  TranscriptionService,
];

@Module({ providers, exports: providers })
export class AiModule {}
