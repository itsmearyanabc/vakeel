import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { RedisService } from '../redis/redis.service';
import { ProviderRegistry } from './providers/provider.registry';

/** Embedding API calls are batched at this size during ingestion. */
const BATCH_SIZE = 64;

/** Query embeddings are cached for a day; the corpus does not move that fast. */
const QUERY_CACHE_TTL_SECONDS = 86400;

@Injectable()
export class EmbeddingService {
  private readonly logger = getLogger().child({ module: 'embeddings' });

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly redis: RedisService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get dimensions(): number {
    return this.registry.getEmbeddingProvider().dimensions;
  }

  /**
   * Embed a search query, with a Redis cache.
   *
   * Legal queries repeat heavily - "bail in NDPS case", "302 IPC punishment" -
   * and an embedding call sits directly in the user's latency path, so this is
   * one of the cheaper wins available.
   *
   * Returns null on failure rather than throwing: the retriever degrades to
   * lexical-only search, which is a worse answer rather than no answer.
   */
  async embedQuery(text: string): Promise<number[] | null> {
    const normalised = text.trim().toLowerCase();
    if (!normalised) return null;

    const provider = this.registry.getEmbeddingProvider();
    // The provider and dimension are part of the key: switching either one
    // makes previously cached vectors meaningless, and a stale vector of the
    // wrong width would be rejected by pgvector at query time.
    const key = `emb:${provider.name}:${provider.dimensions}:${createHash('sha256').update(normalised).digest('hex').slice(0, 32)}`;

    const cached = await this.redis.getJson<number[]>(key);
    if (cached && cached.length === provider.dimensions) return cached;

    try {
      const [vector] = await provider.embed([normalised]);
      if (!vector?.length) return null;

      if (vector.length !== provider.dimensions) {
        this.logger.error(
          { expected: provider.dimensions, received: vector.length },
          'Embedding width does not match EMBEDDING_DIMENSIONS - check the model and the vector() width in the migrations',
        );
        return null;
      }

      await this.redis.setJson(key, vector, QUERY_CACHE_TTL_SECONDS);
      return vector;
    } catch (err) {
      this.logger.error({ err }, 'Query embedding failed; retrieval will fall back to lexical search');
      return null;
    }
  }

  /**
   * Embed many documents, for ingestion.
   *
   * Unlike {@link embedQuery} this throws on failure - a partially embedded
   * corpus is a silent quality problem that shows up much later as poor
   * retrieval, so the ingest run should stop and be retried instead.
   */
  async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const provider = this.registry.getEmbeddingProvider();
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const vectors = await provider.embed(batch);

      if (vectors.length !== batch.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`);
      }

      out.push(...vectors);
      onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
    }

    return out;
  }
}
