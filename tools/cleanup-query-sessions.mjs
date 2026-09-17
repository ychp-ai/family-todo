import { pathToFileURL } from 'node:url';

const MIN_GRACE_MS = 86400000;
const MAX_ROWS = 10000;
const PAGE_SIZE = 100;
const KNOWN_SCHEMAS = new Set([1, 2]);

function canonicalInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`Invalid ${label}.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateCheckpoint(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 512) throw new Error('Invalid cleanup checkpoint.');
  const cutoff = canonicalInstant(value.cutoff, 'cleanup checkpoint');
  const expiresAt = canonicalInstant(value.expiresAt, 'cleanup checkpoint');
  if (expiresAt >= cutoff) throw new Error('Invalid cleanup checkpoint.');
  return { cutoff, expiresAt, id: value.id };
}

export function encodeCleanupCheckpoint(checkpoint) {
  const value = validateCheckpoint(checkpoint);
  return Buffer.from(JSON.stringify({ v: 1, cutoff: value.cutoff, expiresAt: value.expiresAt, id: value.id })).toString('base64url');
}

export function decodeCleanupCheckpoint(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid cleanup checkpoint.');
  let value;
  try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new Error('Invalid cleanup checkpoint.'); }
  if (!value || value.v !== 1 || Object.keys(value).sort().join(',') !== 'cutoff,expiresAt,id,v') throw new Error('Invalid cleanup checkpoint.');
  return validateCheckpoint(value);
}

function afterFilter(command, checkpoint) {
  return command.and([
    { expiresAt: command.lt(checkpoint.cutoff) },
    command.or([
      { expiresAt: command.gt(checkpoint.expiresAt) },
      { expiresAt: checkpoint.expiresAt, _id: command.gt(checkpoint.id) },
    ]),
  ]);
}

/** Scans only query_sessions. Business collections and idempotency receipts are never visited. */
export async function cleanupQuerySessions(db, { now = new Date(), apply = false, maxRows = 1000, graceMs = MIN_GRACE_MS, after = null, shouldStop = () => false } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid cleanup time.');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS || !Number.isFinite(graceMs) || graceMs < MIN_GRACE_MS) throw new Error('Invalid cleanup bounds.');
  const resumed = after === null ? null : (typeof after === 'string' ? decodeCleanupCheckpoint(after) : validateCheckpoint(after));
  const latestCutoff = new Date(now.getTime() - graceMs).toISOString();
  const cutoff = resumed?.cutoff ?? latestCutoff;
  if (cutoff > latestCutoff) throw new Error('Cleanup checkpoint cutoff exceeds the permitted cutoff.');

  let cursor = resumed && { expiresAt: resumed.expiresAt, id: resumed.id };
  let scanned = 0;
  let eligible = 0;
  let deleted = 0;
  let skipped = 0;
  let complete = false;
  scan: while (scanned < maxRows) {
    if (shouldStop()) break;
    const checkpoint = cursor && { cutoff, ...cursor };
    const filter = checkpoint ? afterFilter(db.command, checkpoint) : { expiresAt: db.command.lt(cutoff) };
    const limit = Math.min(PAGE_SIZE, maxRows - scanned);
    const page = await db.collection('query_sessions').where(filter)
      .orderBy('expiresAt', 'asc').orderBy('_id', 'asc')
      .field({ _id: true, schemaVersion: true, expiresAt: true }).limit(limit).get();
    if (!Array.isArray(page.data)) throw new Error('Invalid session page.');
    for (const row of page.data) {
      if (shouldStop()) break scan;
      if (!row || typeof row._id !== 'string' || typeof row.expiresAt !== 'string') throw new Error('Invalid projected session row.');
      canonicalInstant(row.expiresAt, 'session expiry');
      if (row.expiresAt >= cutoff || (cursor && (row.expiresAt < cursor.expiresAt || (row.expiresAt === cursor.expiresAt && row._id <= cursor.id)))) throw new Error('Invalid session ordering.');
      cursor = { expiresAt: row.expiresAt, id: row._id };
      scanned++;
      if (!KNOWN_SCHEMAS.has(row.schemaVersion)) { skipped++; continue; }
      eligible++;
      if (apply) {
        const result = await db.collection('query_sessions').where({ _id: row._id, schemaVersion: row.schemaVersion, expiresAt: row.expiresAt }).remove();
        if (!result || !Number.isInteger(result.deleted) || result.deleted < 0 || result.deleted > 1) throw new Error('Invalid delete result.');
        deleted += result.deleted;
      }
    }
    if (page.data.length < limit) { complete = true; break; }
  }
  const checkpoint = !complete && cursor ? encodeCleanupCheckpoint({ cutoff, ...cursor }) : null;
  return { apply, cutoff, scanned, eligible, deleted, skipped, complete, checkpoint };
}

function parseCli(argv) {
  const options = { apply: false, maxRows: 1000, graceMs: MIN_GRACE_MS, after: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--after') options.after = argv[++index];
    else if (arg === '--max-rows') options.maxRows = Number(argv[++index]);
    else if (arg === '--grace-ms') options.graceMs = Number(argv[++index]);
    else throw new Error('Usage: node tools/cleanup-query-sessions.mjs [--apply] [--after TOKEN] [--max-rows 1..10000] [--grace-ms >=86400000]');
  }
  if (argv.at(-1) === '--after' || argv.at(-1) === '--max-rows' || argv.at(-1) === '--grace-ms') throw new Error('Missing option value.');
  return options;
}

async function runCli() {
  const options = parseCli(process.argv.slice(2));
  const env = process.env.TCB_ENV_ID;
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!env || !secretId || !secretKey) throw new Error('Set verified TCB_ENV_ID and maintenance credentials through environment variables.');
  const { default: cloudbase } = await import('@cloudbase/node-sdk');
  const db = cloudbase.init({ env, secretId, secretKey, sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }).database();
  const result = await cleanupQuerySessions(db, options);
  console.log(JSON.stringify({ env, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => { console.error(error); process.exitCode = 1; });
}
