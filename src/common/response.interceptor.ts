import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiSuccess, RawResponse, ResponseMeta } from './api-response';

/**
 * Wraps every successful handler return value in the standard envelope and
 * stamps timing + a request id.
 *
 * Handlers that need to control their own body (Meta's webhook handshake) can
 * return a {@link RawResponse} to opt out.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccess<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccess<T> | T> {
    const started = Date.now();
    const http = context.switchToHttp();
    const request = http.getRequest<{ headers?: Record<string, string>; requestId?: string }>();

    const requestId = request?.headers?.['x-request-id'] ?? randomUUID();
    if (request) request.requestId = requestId;

    return next.handle().pipe(
      map((data) => {
        if (data instanceof RawResponse) {
          return data.body as T;
        }

        const meta: ResponseMeta = {
          response_time_ms: Date.now() - started,
          request_id: requestId,
        };

        // Handlers can attach quota info by returning it under `__meta`, which
        // is lifted into meta rather than shipped inside data.
        if (data && typeof data === 'object' && '__meta' in (data as Record<string, unknown>)) {
          const { __meta, ...rest } = data as Record<string, unknown>;
          Object.assign(meta, __meta);
          return { success: true, data: rest as T, meta };
        }

        return { success: true, data, meta };
      }),
    );
  }
}
