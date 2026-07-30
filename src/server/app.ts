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
    const code = line.code;
    const params = line.params;
    const stakeInput = line.stake;
    if (typeof code !== 'string')
      throw new ServiceError('INVALID_TICKET', 'Line code must be a string', `${path}.code`);
    if (typeof params !== 'object' || params === null || Array.isArray(params))
      throw new ServiceError('INVALID_TICKET', 'Line params must be an object', `${path}.params`);
    let stake: bigint;
    try {
      stake = parseChips(stakeInput, `${path}.stake`);
    } catch (error) {
      throw new ServiceError('INVALID_TICKET', (error as Error).message, `${path}.stake`);
    }
    return { code, params: { ...(params as Record<string, unknown>) }, stake };
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
      const sessionId = url.searchParams.get('session');
      const write = (name: string, payload: unknown): void => {
        response.write(`event: ${name}\ndata: ${jsonBody(payload)}\n\n`);
      };
      const unsubscribe = chamber.subscribe((event) => {
        if (event.type === 'round.reveal') {
          const entry = sessionId ? event.draw.entries.get(sessionId) : undefined;
          const currentSession = entry ? store.get(entry.session.id) : null;
          const currentRound = currentSession
            ? store.getRound(currentSession, event.draw.roundId)
            : null;
          write('reveal', {
            roundId: event.draw.roundId,
            transcript: event.draw.transcript,
            serverSeed: event.draw.serverSeed,
            tickets: event.draw.entries.size,
            round: currentRound ? describeRound(store, currentRound) : null,
            session: currentSession ? describeSession(store, currentSession) : null,
          });
          return;
        }
        // Not `open`: that is EventSource's own native connection event, and a
        // custom event sharing its name makes the native one — which carries no
        // data — run the client's state handler and throw out of it on connect.
        write(event.type === 'round.open' ? 'draw' : 'presence', lobbyState());
      });
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
      };
      request.once('close', () => {
        cleanup();
        if (!response.writableEnded) response.end();
      });
      response.once('close', cleanup);
      response.once('error', cleanup);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      write('state', lobbyState());
      return;
    }

    if (path === '/api/dev/skew' && method === 'POST') {
      if (!options.dev)
        throw new ServiceError('BAD_REQUEST', 'Dev hooks are disabled', '$');
      const body = await readJson(request);
      const sessionId = body.sessionId;
      const minutesInput = body.minutes;
      const session = store.get(sessionId);
      const minutes = Number(minutesInput);
      if (!Number.isFinite(minutes))
        throw new ServiceError('BAD_REQUEST', 'minutes must be a number', '$.minutes');
      store.setElapsedSkewForTest(session, session.elapsedSkewMs + minutes * 60_000);
      return sendJson(response, 200, { session: describeSession(store, store.get(session.id)) });
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
        const hasSkip = 'skip' in body;
        const skip = hasSkip ? body.skip : undefined;
        const hasVariantId = 'variantId' in body;
        const variantId = hasVariantId ? body.variantId : undefined;
        const hasSessionMinutes = 'sessionMinutes' in body;
        const sessionMinutes = hasSessionMinutes ? body.sessionMinutes : undefined;
        const hasLossChips = 'lossChips' in body;
        const lossChips = hasLossChips ? body.lossChips : undefined;
        const hasRealityCheck = 'playerRealityCheckMinutes' in body;
        const playerRealityCheckMinutes = hasRealityCheck
          ? body.playerRealityCheckMinutes
          : undefined;
        if (hasVariantId) {
          if (!isVariantId(variantId))
            throw new ServiceError('BAD_REQUEST', 'Unknown variant', '$.variantId');
          store.setVariant(session, variantId);
        }
        const patch: Parameters<SessionStore['updateSettings']>[1] = {};
        if (hasSkip) patch.skip = skip === true;
        if (hasSessionMinutes)
          patch.sessionMinutes =
            sessionMinutes === null
              ? null
              : Math.max(1, Math.floor(Number(sessionMinutes)));
        if (hasLossChips)
          patch.lossChips =
            lossChips === null ? null : parseChips(lossChips, '$.lossChips');
        if (hasRealityCheck) {
          if (playerRealityCheckMinutes === null) patch.playerRealityCheckMinutes = null;
          else {
            const minutes = Number(playerRealityCheckMinutes);
            const allowed = (catalogue.playPolicy as { playerRealityCheckIntervalOptions: number[] })
              .playerRealityCheckIntervalOptions;
            if (!allowed.includes(minutes))
              throw new ServiceError(
                'BAD_REQUEST',
                'Reality-check intervals may only tighten, and only to a published option',
                '$.playerRealityCheckMinutes',
              );
            patch.playerRealityCheckMinutes = minutes;
          }
        }
        store.updateSettings(session, patch);
        return sendJson(response, 200, {
          session: describeSession(store, store.get(session.id)),
        });
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
        const linesInput = body.lines;
        const lines = parseLines(linesInput);
        return sendJson(response, 200, { quote: store.quote(session, lines) });
      }

      if (tail === '/round/commit' && method === 'POST') {
        const body = await readJson(request);
        const roundId = body.roundId;
        const clientSeed = body.clientSeed;
        const linesInput = body.lines;
        if (typeof roundId !== 'string')
          throw new ServiceError('BAD_REQUEST', 'roundId is required', '$.roundId');
        const result = store.commit(session, {
          roundId,
          clientSeed: typeof clientSeed === 'string' ? clientSeed : '',
          lines: parseLines(linesInput),
        });
        return sendJson(response, 200, {
          round: describeRound(store, result.round),
          session: describeSession(store, store.get(session.id)),
          replayed: result.replayed,
        });
      }

      if (tail === '/lobby/commit' && method === 'POST') {
        if (!chamber) throw new ServiceError('BAD_REQUEST', 'The shared chamber is not running', '$');
        const body = await readJson(request);
        const roundId = body.roundId;
        const linesInput = body.lines;
        if (typeof roundId !== 'string')
          throw new ServiceError('BAD_REQUEST', 'roundId is required', '$.roundId');
        const result = chamber.commit(session, {
          roundId,
          lines: parseLines(linesInput),
        });
        return sendJson(response, 200, {
          round: describeRound(store, result.round),
          session: describeSession(store, store.get(session.id)),
          lobby: lobbyState(),
          replayed: result.replayed,
        });
      }

      const revealMatch = /^\/round\/([A-Za-z0-9_-]+)\/reveal$/u.exec(tail);
      if (revealMatch && method === 'POST') {
        const round = store.getRound(session, revealMatch[1] as string);
        const revealed = store.reveal(round);
        const currentRound = store.getRound(session, round.roundId);
        return sendJson(response, 200, {
          serverSeed: revealed.serverSeed,
          verification: revealed.transcript,
          receiptVerification: revealed.receipt,
          round: describeRound(store, currentRound),
          snapshot: store.serializedSnapshot(currentRound),
        });
      }

      const roundMatch = /^\/round\/([A-Za-z0-9_-]+)$/u.exec(tail);
      if (roundMatch && method === 'GET') {
        const round = store.getRound(session, roundMatch[1] as string);
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
