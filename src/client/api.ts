/** The service, as functions. Every failure carries the engine's error code. */

import type {
  ApiError,
  Catalogue,
  HistoryRow,
  LobbyState,
  RoundView,
  SessionState,
  TicketQuote,
  WireReceipt,
  WireTranscript,
} from './types.js';

export class ApiFailure extends Error {
  readonly code: string;
  readonly path: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiFailure';
    this.code = error.code;
    this.path = error.path;
    this.details = error.details;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const failure = (payload as { error?: ApiError }).error;
    throw new ApiFailure(
      failure ?? { code: 'BAD_REQUEST', message: `HTTP ${response.status}`, path: '$' },
    );
  }
  return payload as T;
}

export interface TicketLineInput {
  code: string;
  params: Record<string, unknown>;
  stake: string;
}

export const api = {
  catalogue: () => call<Catalogue>('GET', '/api/catalogue'),
  operatorKey: () =>
    call<{ signerId: string; publicKeyHex: string; algorithm: string; note: string }>(
      'GET',
      '/api/operator-key',
    ),
  createSession: () => call<{ session: SessionState }>('POST', '/api/session'),
  session: (id: string) => call<{ session: SessionState }>('GET', `/api/session/${id}`),
  settings: (id: string, patch: Record<string, unknown>) =>
    call<{ session: SessionState }>('POST', `/api/session/${id}/settings`, patch),
  ackRealityCheck: (id: string) =>
    call<{ session: SessionState }>('POST', `/api/session/${id}/reality-check/ack`),
  openRound: (id: string) =>
    call<{ round: RoundView; session: SessionState }>('POST', `/api/session/${id}/round/open`),
  quote: (id: string, lines: TicketLineInput[]) =>
    call<{ quote: TicketQuote }>('POST', `/api/session/${id}/ticket/quote`, { lines }),
  commit: (id: string, roundId: string, clientSeed: string, lines: TicketLineInput[]) =>
    call<{ round: RoundView; session: SessionState; replayed: boolean }>(
      'POST',
      `/api/session/${id}/round/commit`,
      { roundId, clientSeed, lines },
    ),
  lobbyCommit: (id: string, roundId: string, lines: TicketLineInput[]) =>
    call<{ round: RoundView; session: SessionState; lobby: LobbyState; replayed: boolean }>(
      'POST',
      `/api/session/${id}/lobby/commit`,
      { roundId, lines },
    ),
  reveal: (id: string, roundId: string) =>
    call<{
      serverSeed: string;
      verification: { ok: boolean; code?: string; message?: string; path?: string };
      receiptVerification: {
        ok: boolean;
        code?: string;
        bindingsVerified?: boolean;
        signatureChecked?: boolean;
        path?: string;
        message?: string;
      };
      round: RoundView;
      snapshot: string;
    }>('POST', `/api/session/${id}/round/${roundId}/reveal`),
  round: (id: string, roundId: string) =>
    call<{ round: RoundView }>('GET', `/api/session/${id}/round/${roundId}`),
  history: (id: string) =>
    call<{ rounds: HistoryRow[]; session: SessionState }>('GET', `/api/session/${id}/history`),
  lobby: () => call<LobbyState>('GET', '/api/lobby/state'),
};

export type { WireReceipt, WireTranscript };
