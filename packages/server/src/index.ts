/**
 * @hp/server — ws game server + static client host (plan P3 + P6).
 *
 * Importable as a module (tests use createServer directly); when executed as
 * the entry script it starts an HTTP server on PORT (default 8080) serving
 * the built client from packages/client/dist (SPA fallback for /r/* routes),
 * GET /healthz, and the WebSocket game endpoint at /ws. SQLite lives at
 * DB_PATH (default ./data/hp.db).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { getBot, getFallbackBot } from './botRunner.js';
export { Db } from './db.js';
export type { Room } from './rooms.js';
export type { HpServer, ServerOpts } from './server.js';
export { createServer, cryptoShuffle } from './server.js';
export type { Session } from './sessions.js';
export { DEFAULT_TIMER_CONFIG, type TimerConfig } from './timers.js';

import { createServer } from './server.js';

function main(): void {
  const thisFile = fileURLToPath(import.meta.url);
  const clientDist = resolve(dirname(thisFile), '../../client/dist');
  const server = createServer({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
    dbPath: process.env.DB_PATH ?? './data/hp.db',
    staticDir: existsSync(clientDist) ? clientDist : null,
  });
  server
    .listen()
    .then((port) => {
      console.log(`[server] listening on :${port} (ws at /ws)`);
    })
    .catch((err) => {
      console.error('[server] failed to listen', err);
      process.exit(1);
    });
  const shutdown = (): void => {
    // Matches stay 'active' in the db: boot-time recovery resumes them.
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  main();
}
