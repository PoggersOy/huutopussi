/**
 * Per-user saved rule configurations (the lobby "Sääntömuoto" dropdown beyond
 * the built-in "Oletus"): the /api/profile/configs CRUD endpoints, the max-10
 * per-account cap, player-count-agnostic validation (mode-specific fields are
 * accepted at save time and only gated at room creation), inclusion in the
 * account export, and removal on account erasure.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, ILLISOFT_RULES, type RuleConfig } from '@hp/engine';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { hashToken } from '../src/auth.js';
import { Db, MAX_RULE_CONFIGS } from '../src/db.js';
import { createServer, type HpServer } from '../src/index.js';

let server: HpServer;
let port: number;

beforeEach(async () => {
  server = createServer({ port: 0, dbPath: ':memory:', heartbeatMs: null });
  port = await server.listen();
});

afterEach(async () => {
  await server.close();
});

/** Insert a signed-in account + a valid app token; returns its raw token + id. */
function makeUser(name: string): { id: string; token: string } {
  const user = server.db.upsertUserByGoogleSub({
    id: randomUUID(),
    googleSub: `sub-${name}-${randomUUID()}`,
    name,
    picture: null,
  });
  const token = randomUUID();
  server.db.createAuthToken(hashToken(token), user.id, Date.now() + 600_000);
  return { id: user.id, token };
}

const base = () => `http://127.0.0.1:${port}`;
const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

function listConfigs(token: string) {
  return fetch(`${base()}/api/profile/configs`, { headers: auth(token) });
}
function createConfig(token: string, name: string, config: RuleConfig) {
  return fetch(`${base()}/api/profile/configs`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name, config }),
  });
}

test('config endpoints require authentication (401 without a token)', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/profile/configs`);
  expect(res.status).toBe(401);
});

test('create + list + update + delete round-trip', async () => {
  const u = makeUser('Ann');

  const created = await createConfig(u.token, 'Meidän säännöt', DEFAULT_RULES);
  expect(created.status).toBe(200);
  const { config: row } = (await created.json()) as {
    config: { id: string; name: string; config: RuleConfig };
  };
  expect(row.name).toBe('Meidän säännöt');
  expect(row.config).toEqual(DEFAULT_RULES);
  expect(typeof row.id).toBe('string');

  const listed = (await (await listConfigs(u.token)).json()) as {
    configs: Array<{ id: string; name: string; config: RuleConfig }>;
  };
  expect(listed.configs).toHaveLength(1);
  expect(listed.configs[0]?.id).toBe(row.id);

  const updated = await fetch(`${base()}/api/profile/configs/${row.id}`, {
    method: 'PUT',
    headers: auth(u.token),
    body: JSON.stringify({ name: 'Uusi nimi', config: { ...DEFAULT_RULES, winTarget: 300 } }),
  });
  expect(updated.status).toBe(200);
  const afterUpdate = (await (await listConfigs(u.token)).json()) as {
    configs: Array<{ name: string; config: RuleConfig }>;
  };
  expect(afterUpdate.configs[0]?.name).toBe('Uusi nimi');
  expect(afterUpdate.configs[0]?.config.winTarget).toBe(300);

  const del = await fetch(`${base()}/api/profile/configs/${row.id}`, {
    method: 'DELETE',
    headers: auth(u.token),
  });
  expect(del.status).toBe(204);
  const empty = (await (await listConfigs(u.token)).json()) as { configs: unknown[] };
  expect(empty.configs).toHaveLength(0);
});

test('a saved config may carry both 2-3p and 4p mode fields (gating deferred to creation)', async () => {
  const u = makeUser('Bo');
  // players:2 with a 6-card talon — accepted at save time even though the same
  // fields would be gated per player count when a room is created.
  const cfg: RuleConfig = { ...ILLISOFT_RULES, players: 2, talonSize: 6, openTalon: false };
  const res = await createConfig(u.token, '2p koini', cfg);
  expect(res.status).toBe(200);
});

test('invalid bodies are rejected (400): empty name, minBid > maxBid', async () => {
  const u = makeUser('Cy');
  expect((await createConfig(u.token, '   ', DEFAULT_RULES)).status).toBe(400);
  const bad: RuleConfig = { ...DEFAULT_RULES, minBid: 200, maxBid: 100 };
  expect((await createConfig(u.token, 'huono', bad)).status).toBe(400);
});

test(`the per-account cap is ${MAX_RULE_CONFIGS} (11th create → 409)`, async () => {
  const u = makeUser('Di');
  for (let i = 0; i < MAX_RULE_CONFIGS; i++) {
    expect((await createConfig(u.token, `cfg-${i}`, DEFAULT_RULES)).status).toBe(200);
  }
  const over = await createConfig(u.token, 'liikaa', DEFAULT_RULES);
  expect(over.status).toBe(409);
  expect((await over.json()) as { error: string }).toMatchObject({ error: 'limit_reached' });
});

test("another user's config cannot be updated or deleted (404)", async () => {
  const owner = makeUser('Ed');
  const other = makeUser('Fi');
  const created = await createConfig(owner.token, 'omani', DEFAULT_RULES);
  const { config: row } = (await created.json()) as { config: { id: string } };

  const put = await fetch(`${base()}/api/profile/configs/${row.id}`, {
    method: 'PUT',
    headers: auth(other.token),
    body: JSON.stringify({ name: 'kaappaus', config: DEFAULT_RULES }),
  });
  expect(put.status).toBe(404);
  const del = await fetch(`${base()}/api/profile/configs/${row.id}`, {
    method: 'DELETE',
    headers: auth(other.token),
  });
  expect(del.status).toBe(404);
});

test('account export includes saved configs; erasure removes them', async () => {
  const u = makeUser('Gu');
  await createConfig(u.token, 'export-me', DEFAULT_RULES);

  const exported = (await (
    await fetch(`${base()}/api/account/export`, { headers: auth(u.token) })
  ).json()) as { ruleConfigs: Array<{ name: string }> };
  expect(exported.ruleConfigs).toHaveLength(1);
  expect(exported.ruleConfigs[0]?.name).toBe('export-me');

  // Erasure (DB level) removes the saved configs with the account.
  server.db.deleteUserAccount(u.id);
  expect(server.db.listRuleConfigs(u.id)).toHaveLength(0);
});

test('createRuleConfig enforces the cap at the DB layer (concurrent-safe count)', () => {
  const db = new Db(':memory:');
  db.upsertUserByGoogleSub({ id: 'u1', googleSub: 'sub-1', name: 'X', picture: null });
  for (let i = 0; i < MAX_RULE_CONFIGS; i++) {
    expect(db.createRuleConfig('u1', `id-${i}`, `n-${i}`, DEFAULT_RULES, i)).not.toBeNull();
  }
  expect(db.createRuleConfig('u1', 'id-over', 'over', DEFAULT_RULES, 99)).toBeNull();
  expect(db.listRuleConfigs('u1')).toHaveLength(MAX_RULE_CONFIGS);
  db.close();
});
