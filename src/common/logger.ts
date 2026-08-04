import { LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';

/**
 * Structured logging.
 *
 * Railway captures stdout, so JSON lines go straight into its log viewer and
 * stay greppable. Locally we pretty-print instead.
 *
 * Redaction is not optional here: WhatsApp payloads carry phone numbers and
 * access tokens, and this is a DPDP-regulated application. The redact list
 * below is the last line of defence for anything that slips into a log object.
 */

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'headers.authorization',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'password',
  'jwt',
  'barCouncilId',
  'bar_council_id',
  '*.accessToken',
  '*.apiKey',
];

let root: Logger | undefined;

export function createRootLogger(level: string, pretty: boolean): Logger {
  root = pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Railway's viewer keys off `level` as a string; the numeric default is
    // harder to filter on.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return root;
}

export function getLogger(): Logger {
  // Tests and scripts may log before bootstrap wires the real logger.
  root ??= pino({ level: process.env.LOG_LEVEL ?? 'info' });
  return root;
}

/**
 * Mask a phone number for logs: 919876543210 -> 9198****3210.
 *
 * Enough to correlate a conversation across log lines without printing a
 * complete identifier into a third-party log store.
 */
export function maskPhone(phone: string | undefined | null): string {
  if (!phone) return 'unknown';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '***';
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

/** Adapts pino to Nest's LoggerService so framework logs land in the same stream. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger = getLogger()) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
