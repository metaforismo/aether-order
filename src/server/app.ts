/**
 * The HTTP surface. Node's own `http`, a tiny router, no framework.
 *
 * Every money-shaped field crosses this boundary as a base-10 string, and every
 * inbound one is parsed back to `bigint` before it reaches the engine — the
 * server never takes a caller's word for a number's type. Malformed input is a
 * `RevealEngineError` with a stable code and a path, exactly as
 * docs/ENGINE.md §9 specifies; the router just gives it a status.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireCatalogue } from './catalogue.js';
import { assertAdaptersConform, assertPublishedArtefactsMatchEngine, isVariantId } from './engine.js';
import { asServiceError, ServiceError } from './errors.js';
import { SharedChamber } from './lobby.js';
import { parseChips } from './money.js';
import { SessionStore, type Clock, type RawLine, type Session } from './session.js';
import { describeHistory, describeRound, describeSession } from './wire.js';

export interface AppOptions {
  readonly now?: Clock;
  /** Serve the built client from this directory. Omit for API-only. */
  readonly clientDir?: string;
  /** Run the shared chamber. Off in tests, which drive their own clock. */
  readonly lobby?: boolean;
  readonly lobbyCadenceMs?: number;
  /** Enables `POST /api/dev/skew`, a test hook. Never on by default. */
  readonly dev?: boolean;
  /**
   * Run docs/ENGINE.md §8's twelve adapter conformance checks at startup.
   *
   * Off by default, and that is a considered split rather than a saving. The
   * fingerprint cross-check below always runs: it is what stops the service
   * settling rounds under an adapter `docs/paytable.json` does not describe, and
   * it costs a comparison against a value the engine memoised at construction.
   * Conformance is a different thing — §8 calls it mechanical evidence and says
   * to run it in CI — and at `n = 7` it re-derives 27.6M predicate evaluations,
   * about seven seconds. `tests/adapter-conformance.test.ts` runs it on every
   * build; a server paying for it on every boot is paying a CI cost at runtime.
   */
  readonly conformance?: boolean;
}

export interface App {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
  readonly store: SessionStore;
  readonly chamber: SharedChamber | null;
  readonly close: () => void;
}

const MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
});

function jsonBody(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  );
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = jsonBody(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const failure = asServiceError(error);
  sendJson(response, failure.status, {
    error: {
      code: failure.code,
      message: failure.message,
      path: failure.path,
      ...(failure.details ? { details: failure.details } : {}),
    },
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > 256 * 1024)
      throw new ServiceError('PAYLOAD_TOO_LARGE', 'Request body is too large', '$');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ServiceError('BAD_REQUEST', 'Request body must be a JSON object', '$');
  }
}

/** Hostile-input gate for a raw ticket, before the engine ever sees it. */
function parseLines(value: unknown): RawLine[] {
  if (!Array.isArray(value))
    throw new ServiceError('INVALID_TICKET', 'lines must be an array', '$.lines');
  if (value.length > 32)
    throw new ServiceError('INVALID_TICKET', 'Too many lines', '$.lines');
  return value.map((raw, index): RawLine => {
    const path = `$.lines[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new ServiceError('INVALID_TICKET', 'Line must be an object', path);
    const line = raw as Record<string, unknown>;
    if (typeof line.code !== 'string')
      throw new ServiceError('INVALID_TICKET', 'Line code must be a string', `${path}.code`);
    if (typeof line.params !== 'object' || line.params === null || Array.isArray(line.params))
      throw new ServiceError('INVALID_TICKET', 'Line params must be an object', `${path}.params`);
    let stake: bigint;
    try {
      stake = parseChips(line.stake, `${path}.stake`);
    } catch (error) {
      throw new ServiceError('INVALID_TICKET', (error as Error).message, `${path}.stake`);
    }
    return { code: line.code, params: { ...(line.params as Record<string, unknown>) }, stake };
  });
}

export function createApp(options: AppOptions = {}): App {
  assertPublishedArtefactsMatchEngine();
  if (options.conformance) assertAdaptersConform();

  const store = new SessionStore(options.now ? { now: options.now } : {});
  const chamber = options.lobby === false ? null : new SharedChamber(store, options.lobbyCadenceMs);
  if (chamber && options.lobby) chamber.start();
  const catalogue = wireCatalogue();
  const clientDir = options.clientDir ?? null;

  function lobbyState(): Record<string, unknown> {
    if (!chamber || !chamber.draw) return { running: false };
    const draw = chamber.draw;
    const window = chamber.windowFor(draw);
    const presence = chamber.presence(draw);
    return {
      running: true,
      cadenceMs: chamber.cadenceMs,
      variantId: draw.variantId,
      roundId: draw.roundId,
      nonce: draw.nonce,
      seedCommitment: draw.seedCommitment,
      previousCommitment: draw.previousCommitment,
      openedAt: draw.openedAt,
      now: store.now(),
      ...window,
      presence,
    };
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const path = url.pathname;

    if (path === '/api/catalogue' && method === 'GET') return sendJson(response, 200, catalogue);

    if (path === '/api/operator-key' && method === 'GET')
      return sendJson(response, 200, {
        signerId: store.operatorKey.signerId,
        publicKeyHex: store.operatorKey.publicKeyHex,
        algorithm: 'Ed25519',
        note: 'Generated at process start. docs/ENGINE.md §11: key custody, publication and rotation are the operator\'s, and this service simulates none of them.',
      });

    if (path === '/api/session' && method === 'POST') {
      const session = store.create();
      return sendJson(response, 201, { session: describeSession(store, session) });
    }

    if (path === '/api/lobby/state' && method === 'GET') return sendJson(response, 200, lobbyState());

    if (path === '/api/lobby/stream' && method === 'GET') {
      if (!chamber) return sendJson(response, 200, { running: false });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const sessionId = url.searchParams.get('session');
      const write = (name: string, payload: unknown): void => {
        response.write(`event: ${name}\ndata: ${jsonBody(payload)}\n\n`);
      };
      write('state', lobbyState());
      const unsubscribe = chamber.subscribe((event) => {
        if (event.type === 'round.reveal') {
          const entry = sessionId ? event.draw.entries.get(sessionId) : undefined;
          write('reveal', {
            roundId: event.draw.roundId,
            transcript: event.draw.transcript,
            serverSeed: event.draw.serverSeed,
            tickets: event.draw.entries.size,
            round: entry ? describeRound(store, entry.round) : null,
            session: entry ? describeSession(store, entry.session) : null,
          });
          return;
        }
        write(event.type === 'round.open' ? 'open' : 'presence', lobbyState());
      });
      request.on('close', () => {
        unsubscribe();
        response.end();
      });
      return;
    }

    if (path === '/api/dev/skew' && method === 'POST') {
      if (!options.dev)
        throw new ServiceError('BAD_REQUEST', 'Dev hooks are disabled', '$');
      const body = await readJson(request);
      const session = store.get(body.sessionId);
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes))
        throw new ServiceError('BAD_REQUEST', 'minutes must be a number', '$.minutes');
      session.elapsedSkewMs += minutes * 60_000;
      return sendJson(response, 200, { session: describeSession(store, session) });
    }

    const sessionMatch = /^\/api\/session\/([A-Za-z0-9-]+)(\/.*)?$/u.exec(path);
    if (sessionMatch) {
      const session: Session = store.get(sessionMatch[1]);
      const tail = sessionMatch[2] ?? '';

      if (tail === '' && method === 'GET')
        return sendJson(response, 200, { session: describeSession(store, session) });

      if (tail === '/history' && method === 'GET')
        return sendJson(response, 200, {
          rounds: describeHistory(store, session),
          session: describeSession(store, session),
        });

      if (tail === '/settings' && method === 'POST') {
        const body = await readJson(request);
        if ('skip' in body) session.skip = body.skip === true;
        if ('variantId' in body) {
          if (!isVariantId(body.variantId))
            throw new ServiceError('BAD_REQUEST', 'Unknown variant', '$.variantId');
          store.setVariant(session, body.variantId);
        }
        if ('sessionMinutes' in body) {
          const value = body.sessionMinutes;
          session.limits.sessionMinutes =
            value === null ? null : Math.max(1, Math.floor(Number(value)));
        }
        if ('lossChips' in body) {
          const value = body.lossChips;
          session.limits.lossChips = value === null ? null : parseChips(value, '$.lossChips');
        }
        if ('playerRealityCheckMinutes' in body) {
          const value = body.playerRealityCheckMinutes;
          if (value === null) session.playerRealityCheckMinutes = null;
          else {
            const minutes = Number(value);
            const allowed = (catalogue.playPolicy as { playerRealityCheckIntervalOptions: number[] })
              .playerRealityCheckIntervalOptions;
            if (!allowed.includes(minutes))
              throw new ServiceError(
                'BAD_REQUEST',
                'Reality-check intervals may only tighten, and only to a published option',
                '$.playerRealityCheckMinutes',
              );
            session.playerRealityCheckMinutes = minutes;
          }
        }
        return sendJson(response, 200, { session: describeSession(store, session) });
      }

      if (tail === '/reality-check/ack' && method === 'POST') {
        store.acknowledgeRealityCheck(session);
        return sendJson(response, 200, { session: describeSession(store, session) });
      }

      if (tail === '/round/open' && method === 'POST') {
        const round = store.openRound(session);
        return sendJson(response, 200, {
          round: describeRound(store, round),
          session: describeSession(store, session),
        });
      }

      if (tail === '/ticket/quote' && method === 'POST') {
        const body = await readJson(request);
        const lines = parseLines(body.lines);
        return sendJson(response, 200, { quote: store.quote(session, lines) });
      }

      if (tail === '/round/commit' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.roundId !== 'string')
          throw new ServiceError('BAD_REQUEST', 'roundId is required', '$.roundId');
        const result = store.commit(session, {
          roundId: body.roundId,
          clientSeed: typeof body.clientSeed === 'string' ? body.clientSeed : '',
          lines: parseLines(body.lines),
        });
        return sendJson(response, 200, {
          round: describeRound(store, result.round),
          session: describeSession(store, session),
          replayed: result.replayed,
        });
      }

      if (tail === '/lobby/commit' && method === 'POST') {
        if (!chamber) throw new ServiceError('BAD_REQUEST', 'The shared chamber is not running', '$');
        const body = await readJson(request);
        if (typeof body.roundId !== 'string')
          throw new ServiceError('BAD_REQUEST', 'roundId is required', '$.roundId');
        const result = chamber.commit(session, {
          roundId: body.roundId,
          lines: parseLines(body.lines),
        });
        return sendJson(response, 200, {
          round: describeRound(store, result.round),
          session: describeSession(store, session),
          lobby: lobbyState(),
          replayed: result.replayed,
        });
      }

      const revealMatch = /^\/round\/([A-Za-z0-9_-]+)\/reveal$/u.exec(tail);
      if (revealMatch && method === 'POST') {
        const round = session.roundsById.get(revealMatch[1] as string);
        if (!round) throw new ServiceError('ROUND_NOT_FOUND', 'No such round', '$.roundId');
        const revealed = store.reveal(round);
        return sendJson(response, 200, {
          serverSeed: revealed.serverSeed,
          verification: revealed.transcript,
          receiptVerification: revealed.receipt,
          round: describeRound(store, round),
          snapshot: store.serializedSnapshot(round),
        });
      }

      const roundMatch = /^\/round\/([A-Za-z0-9_-]+)$/u.exec(tail);
      if (roundMatch && method === 'GET') {
        const round = session.roundsById.get(roundMatch[1] as string);
        if (!round) throw new ServiceError('ROUND_NOT_FOUND', 'No such round', '$.roundId');
        return sendJson(response, 200, { round: describeRound(store, round) });
      }
    }

    if (path.startsWith('/api/'))
      throw new ServiceError('BAD_REQUEST', `No route for ${method} ${path}`, '$');

    if (clientDir && method === 'GET') return serveStatic(clientDir, path, response);

    throw new ServiceError('BAD_REQUEST', `No route for ${method} ${path}`, '$');
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    route(request, response, url).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, error);
    });
  };

  return {
    handler,
    store,
    chamber,
    close: () => chamber?.stop(),
  };
}

async function serveStatic(rawDir: string, path: string, response: ServerResponse): Promise<void> {
  const dir = normalize(rawDir).replace(new RegExp(`${sep}+$`, 'u'), '');
  const requested = path === '/' ? '/index.html' : path;
  const resolved = normalize(join(dir, requested));
  if (!resolved.startsWith(dir + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(resolved);
    response.writeHead(200, {
      'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    // Single-page client: unknown paths fall back to the shell.
    try {
      const shell = await readFile(join(dir, 'index.html'));
      response.writeHead(200, { 'content-type': MIME['.html'] as string, 'cache-control': 'no-store' });
      response.end(shell);
    } catch {
      response.writeHead(404).end('not found');
    }
  }
}

export const CLIENT_DIR = fileURLToPath(new URL('../../dist/client/', import.meta.url));
