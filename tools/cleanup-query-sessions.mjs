import { pathToFileURL } from 'node:url';

/** Immutable cursor state only. Business idempotency receipts are never visited. */
export async function cleanupQuerySessions(db, { now = new Date(), apply = false, maxRows = 1000, graceMs = 86400000 } = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000 || !Number.isFinite(graceMs) || graceMs < 86400000) throw new Error('Invalid cleanup bounds.');
  const cutoff = new Date(now.getTime() - graceMs).toISOString();
  let after = null;
  let scanned = 0;
  let deleted = 0;
  let skipped = 0;
  let complete = false;
  while (scanned < maxRows) {
    const filter = { expiresAt: db.command.lt(cutoff), ...(after ? { _id: db.command.gt(after) } : {}) };
    const limit = Math.min(100, maxRows - scanned);
    const page = await db.collection('query_sessions').where(filter).orderBy('_id', 'asc').limit(limit).get();
    if (!Array.isArray(page.data)) throw new Error('Invalid session page.');
    for (const row of page.data) {
      if (typeof row._id !== 'string' || (after && row._id <= after)) throw new Error('Invalid session ordering.');
      after = row._id;
      scanned++;
      if (![1, 2].includes(row.schemaVersion) || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt)) || row.expiresAt >= cutoff) { skipped++; continue; }
      if (apply) {
        // Recheck exact expiry/schema at delete time, so a replaced record cannot be deleted.
        const result = await db.collection('query_sessions').where({ _id: row._id, schemaVersion: row.schemaVersion, expiresAt: row.expiresAt }).remove();
        deleted += result.deleted;
      }
    }
    if (page.data.length < limit) { complete = true; break; }
  }
  return { apply, cutoff, scanned, eligible: scanned - skipped, deleted, skipped, complete };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const allowed = new Set(['--apply']);
  if (process.argv.slice(2).some(arg => !allowed.has(arg))) throw new Error('Usage: node tools/cleanup-query-sessions.mjs [--apply]');
  const env = process.env.TCB_ENV_ID;
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!env || !secretId || !secretKey) throw new Error('Set verified TCB_ENV_ID and maintenance credentials through environment variables.');
  const { default: cloudbase } = await import('@cloudbase/node-sdk');
  const db = cloudbase.init({ env, secretId, secretKey, sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }).database();
  const result = await cleanupQuerySessions(db, { apply: process.argv.includes('--apply') });
  console.log(JSON.stringify({ env, ...result }));
}
