import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AnalyticsRepository } from './repositories/analytics.repository';
import { ConversationRepository } from './repositories/conversation.repository';
import { CorpusRepository } from './repositories/corpus.repository';
import { MessageRepository } from './repositories/message.repository';
import { UserRepository } from './repositories/user.repository';

const providers = [
  DatabaseService,
  UserRepository,
  MessageRepository,
  ConversationRepository,
  CorpusRepository,
  AnalyticsRepository,
];

/**
 * Global because both process entrypoints (web and worker) need the same
 * repositories, and there is exactly one connection pool per process.
 */
@Global()
@Module({ providers, exports: providers })
export class DatabaseModule {}
