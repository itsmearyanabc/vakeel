/**
 * The uniform response envelope from section 22 of the architecture spec.
 *
 * The `credits_consumed` / `remaining_credits` fields in the original spec are
 * replaced by quota fields, since billing is deliberately out of scope for this
 * build. The shape is otherwise unchanged, so adding a wallet later means
 * adding fields rather than reshaping every client.
 */

export interface ResponseMeta {
  response_time_ms: number;
  request_id: string;
  quota_used?: number;
  quota_remaining?: number | 'unlimited';
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    /** Field-level validation detail. Omitted for non-validation errors. */
    details?: unknown;
  };
  meta: ResponseMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/**
 * Marker for handlers whose body must be returned verbatim.
 *
 * Meta's webhook verification handshake expects the bare `hub.challenge` value
 * as the response body. Wrapping it in the envelope fails verification, so the
 * webhook controller returns one of these and the interceptor passes it
 * through untouched.
 */
export class RawResponse<T = unknown> {
  constructor(readonly body: T) {}
}
