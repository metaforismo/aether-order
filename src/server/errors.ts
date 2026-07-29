/**
 * One error shape on the wire.
 *
 * Engine codes pass through unchanged — integrations branch on `code`, never on
 * message text (docs/ENGINE.md §9) — and the handful of codes this service owns
 * are the ones the engine deliberately does not: a wallet decline and a
 * player-set limit are RGS concerns, not lifecycle ones.
 */

import { RevealEngineError } from '@axiom-games/reveal-engine/api';

export type ServiceErrorCode =
  | string
  | 'WALLET_DECLINED'
  | 'SESSION_NOT_FOUND'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_ALREADY_SETTLED'
  | 'LIMIT_REACHED'
  | 'BAD_REQUEST';

const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  SESSION_NOT_FOUND: 404,
  ROUND_NOT_FOUND: 404,
  ROUND_ALREADY_SETTLED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CYCLE_FLOOR: 429,
  LIMIT_REACHED: 429,
  BETTING_CLOSED: 409,
  WALLET_DECLINED: 402,
});

export class ServiceError extends Error {
  readonly code: string;
  readonly path: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ServiceErrorCode,
    message: string,
    path = '$',
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.path = path;
    this.status = STATUS_BY_CODE[code] ?? 400;
    this.details = details;
  }
}

export function asServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof RevealEngineError)
    return new ServiceError(error.code, error.message, error.path, error.details);
  if (error instanceof Error) return new ServiceError('BAD_REQUEST', error.message);
  return new ServiceError('BAD_REQUEST', 'Unknown failure');
}
