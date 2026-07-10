/**
 * ws-hello.ts — minimal WS handshake smoke check (run with tsx).
 * Usage: tsx test/ws-hello.ts --port 8198
 * Sends a protocol hello (creating a room) and asserts a well-formed welcome.
 */
import { TestClient } from './helpers.js';

const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 8080;

const client = await TestClient.connect(port);
const msg = await client.hello({ nickname: 'smoke' });
if (msg.t !== 'welcome') {
  console.error(`FAIL: expected welcome, got ${JSON.stringify(msg)}`);
  process.exit(1);
}
if (!msg.sessionToken || msg.seat !== 0 || !/^[A-HJ-NP-Z2-9]{5}$/.test(msg.room.code)) {
  console.error(`FAIL: malformed welcome ${JSON.stringify(msg)}`);
  process.exit(1);
}
console.log(
  `PASS: ws hello handshake ok — room ${msg.room.code}, seat ${msg.seat}, ` +
    `token ${msg.sessionToken.slice(0, 8)}…, status ${msg.room.status}`,
);
client.close();
process.exit(0);
