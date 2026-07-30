/**
 * `npm run dev` — build the client, start the service, serve both.
 *
 * Free play only. The wallet is in memory, the operator key is generated at
 * process start, and nothing is persisted: restart the process and every
 * session, round and receipt is gone. docs/ENGINE.md §11 says seed custody and
 * durable persistence are the operator's; this process is not either one.
 */

import { createServer } from 'node:http';
import { CLIENT_OUT_DIR, buildClient } from './build-client.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 5173);
const dev = process.env.NODE_ENV !== 'production' && process.env.AETHER_DEV === '1';
const watch = process.env.AETHER_WATCH !== '0';

await buildClient(watch);

const app = createApp({
  clientDir: CLIENT_OUT_DIR,
  lobby: true,
  dev,
  conformance: process.env.AETHER_CONFORMANCE === '1',
});

const server = createServer(app.handler);
server.listen(port, () => {
  process.stdout.write(
    [
      '',
      '  AETHER ORDER — graybox, free play',
      `  http://localhost:${port}`,
      `  shared chamber cadence: ${app.chamber?.cadenceMs ?? 0} ms`,
      dev ? '  dev hooks: ON (POST /api/dev/skew)' : '  dev hooks: off',
      '',
    ].join('\n'),
  );
});

const shutdown = (): void => {
  app.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
