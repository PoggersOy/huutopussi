/**
 * Playwright webServer command: build the client + server bundle (skipped with
 * E2E_SKIP_BUILD=1, e.g. in CI where the build already ran), then start the
 * REAL production server entry (packages/server/dist/server.js) on port 8197
 * serving the built client, with a fresh SQLite db in a temp directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientIndex = join(root, 'packages/client/dist/index.html');
const serverBundle = join(root, 'packages/server/dist/server.js');
const port = process.env.E2E_PORT ?? '8197';

function build(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`[e2e] build step failed: ${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

if (process.env.E2E_SKIP_BUILD === '1') {
  if (!existsSync(clientIndex) || !existsSync(serverBundle)) {
    console.error('[e2e] E2E_SKIP_BUILD=1 but build outputs are missing');
    process.exit(1);
  }
} else {
  build('pnpm', ['--filter', '@hp/client', 'build']);
  build('pnpm', ['run', 'build:server']);
}

const dbDir = mkdtempSync(join(tmpdir(), 'hp-e2e-'));
console.log(`[e2e] starting server on :${port} (db: ${dbDir})`);

const child = spawn(process.execPath, [serverBundle], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    DB_PATH: join(dbDir, 'hp.db'),
  },
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
