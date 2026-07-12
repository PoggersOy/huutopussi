/**
 * Manual achievement backfill: `pnpm --filter @hp/server backfill`.
 *
 * The server also runs this automatically once on boot (guarded by a meta
 * marker). Run it by hand to re-scan on demand — it is idempotent (INSERT OR
 * IGNORE), so re-running only awards genuinely-missing achievements. Uses the
 * same DB_PATH the server does (default ./data/hp.db).
 */
import { backfillAchievements } from '../achievements.js';
import { Db } from '../db.js';

const db = new Db(process.env.DB_PATH ?? './data/hp.db');
const { users, awarded } = backfillAchievements(db);
console.log(`[achievements] backfill complete: ${awarded} awarded across ${users} users`);
db.close();
