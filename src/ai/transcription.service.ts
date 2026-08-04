import { Injectable } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Voice note transcription (spec section 2.2).
 *
 * Advocates dictate far more readily than they type, especially in a corridor
 * between hearings, so voice is a first-class input rather than a nice-to-have.
 *
 * Only OpenAI Whisper is wired up: Anthropic has no speech API, and Gemini's
 * audio path is a different call shape than the LLM adapter. Returns null when
 * unavailable so the caller can ask for text instead of failing.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = getLogger().child({ module: 'transcription' });
  private readonly client: OpenAI | null;

  constructor(@InjectEnv() private readonly env: AppEnv) {
    this.client = env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.LLM_TIMEOUT_MS, maxRetries: 1 })
      : null;
  }

  get isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Transcribe an audio buffer.
   *
   * WhatsApp voice notes arrive as OGG/Opus, which Whisper accepts directly -
   * no transcoding step needed. The filename extension matters though: the API
   * infers the container from it.
   */
  async transcribe(buffer: Buffer, mimeType: string): Promise<string | null> {
    if (!this.client) return null;

    try {
      const extension = mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('mpeg') || mimeType.includes('mp3')
          ? 'mp3'
          : mimeType.includes('mp4') || mimeType.includes('m4a')
            ? 'm4a'
            : mimeType.includes('wav')
              ? 'wav'
              : 'ogg';

      const file = await toFile(buffer, `voice.${extension}`, { type: mimeType });

      const result = await this.client.audio.transcriptions.create({
        file,
        model: this.env.OPENAI_TRANSCRIBE_MODEL,
        // No language hint: advocates switch between English, Hindi and
        // regional languages mid-sentence, and pinning one hurts more than the
        // auto-detection costs.
      });

      const text = result.text?.trim();
      this.logger.debug({ length: text?.length }, 'Voice note transcribed');
      return text || null;
    } catch (err) {
      this.logger.error({ err }, 'Transcription failed');
      return null;
    }
  }
}
