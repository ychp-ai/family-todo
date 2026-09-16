import { pathToFileURL } from 'node:url';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01' && value <= '2100-12-31' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const own = (row, key) => Object.prototype.hasOwnProperty.call(row, key);
function validSchedule(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.kind === 'once') return (value.date === null || date(value.date)) && (value.time === null || time(value.time)) && (value.date !== null || value.time === null);
  if (!['daily', 'weekly'].includes(value.kind) || !date(value.startDate) || !(value.endDate === null || date(value.endDate) && value.endDate >= value.startDate) || !Array.isArray(value.times) || value.times.length > 6 || !value.times.every(time) || new Set(value.times).size !== value.times.length) return false;
  return value.kind === 'daily' || Array.isArray(value.weekdays) && value.weekdays.length >= 1 && value.weekdays.length <= 7 && value.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7) && new Set(value.weekdays).size === value.weekdays.length;
}
const projected = { _id: true, schemaVersion: true, version: true, ownerUserId: true, familyId: true, collaboration: true, recurrence: true, candidateSchema: true, candidateKind: true, scopeKey: true, candidateOrder: true, date: true, time: true, lifecycle: true, createdAt: true };

export function candidateFields(row) {
  if (row.schemaVersion !== 1 || (own(row, 'candidateSchema') && row.candidateSchema !== 1)) return { status: 'unknown' };
  if (!uuid(row._id) || !uuid(row.ownerUserId) || !Number.isInteger(row.version) || row.version < 1 || !['active', 'paused', 'stopped', 'deleted'].includes(row.lifecycle) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return { status: 'invalid' };
  if (own(row, 'collaboration') && (!row.collaboration || !uuid(row.collaboration.familyId) || row.familyId !== row.collaboration.familyId)) return { status: 'invalid' };
  if (!own(row, 'collaboration') && row.familyId != null) return { status: 'invalid' };
  const schedule = row.recurrence?.schedule;
  if (own(row, 'recurrence') && (!validSchedule(schedule) || !uuid(row.recurrence.currentSegmentId))) return { status: 'invalid' };
  const localDate = schedule?.kind === 'once' ? schedule.date : row.date;
  const localTime = schedule?.kind === 'once' ? schedule.time : row.time;
  if (!(localDate === null || date(localDate)) || !(localTime === null || time(localTime)) || (localDate === null && localTime !== null)) return { status: 'invalid' };
  const candidateKind = row.candidateKind === 'history' || (row.recurrence && (row.candidateSchema !== 1 || row.candidateKind !== 'single' || schedule.kind !== 'once')) ? 'history' : 'single';
  return { status: 'known', fields: { candidateSchema: 1, candidateKind, scopeKey: row.collaboration ? `f/${row.collaboration.familyId}` : `p/${row.ownerUserId}`, candidateOrder: `${localDate ?? '9999-12-31'}/${localTime ?? '99:99'}/${row._id}` } };
}

function snapshot(row) { return JSON.stringify(Object.keys(projected).map(key => row?.[key] ?? null)); }
function checkpoint(token, environment, apply) {
  if (token !== null && (typeof token !== 'string' || token.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(token))) throw new Error('Invalid candidate checkpoint.');
  if (token === null) return { after: null, counts: { scanned: 0, covered: 0, missing: 0, invalid: 0, unknown: 0, conflict: 0, applied: 0 }, failedIds: [] };
  let value; try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new Error('Invalid candidate checkpoint.'); }
  if (value.v !== 1 || value.environment !== environment || value.apply !== apply || !uuid(value.after) || !value.counts || Object.keys(value.counts).sort().join(',') !== 'applied,conflict,covered,invalid,missing,scanned,unknown' || !Object.values(value.counts).every(n => Number.isInteger(n) && n >= 0) || !Array.isArray(value.failedIds) || value.failedIds.length > 100 || !value.failedIds.every(uuid)) throw new Error('Incompatible candidate checkpoint.');
  return value;
}

/** Proves an existing single marker; unknown legacy recurrence is never downgraded. Bounded per task. */
async function proveSingle(db, row) {
  if (!row.recurrence) return true;
  let after = null, foundCurrent = false;
  for (let pages = 0; pages < 20; pages++) {
    const filter = { taskId: row._id, ...(after ? { listOrder: db.command.gt(after) } : {}) };
    const result = await db.collection('schedule_segments').where(filter).orderBy('listOrder', 'asc').limit(100).field({ _id: true, schemaVersion: true, taskId: true, schedule: true, listOrder: true }).get();
    if (!Array.isArray(result.data)) throw new Error('Invalid segment page.');
    for (const segment of result.data) {
      if (segment.schemaVersion !== 1 || segment.taskId !== row._id || segment.schedule?.kind !== 'once' || !validSchedule(segment.schedule) || !uuid(segment._id) || typeof segment.listOrder !== 'string' || (after !== null && segment.listOrder <= after)) return false;
      after = segment.listOrder;
      if (segment._id === row.recurrence.currentSegmentId) {
        if (JSON.stringify(segment.schedule) !== JSON.stringify(row.recurrence.schedule)) return false;
        foundCurrent = true;
      }
    }
    if (result.data.length < 100) return foundCurrent;
  }
  return false; // Unproved or excessive histories remain conservative history candidates.
}

/** Node SDK transaction.get(ref).data()/update(ref, fields); updates only derived technical fields. */
export async function backfillTaskCandidates(db, { apply = false, maxRows = 1000, after = null, environment = 'local' } = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000 || typeof environment !== 'string' || !environment) throw new Error('Invalid candidate scan bounds.');
  const saved = checkpoint(after, environment, apply), counts = { ...saved.counts }, failedIds = [...saved.failedIds];
  let position = saved.after, scanned = 0, complete = false;
  const fail = (kind, id) => { counts[kind]++; if (failedIds.length < 100) failedIds.push(id); };
  while (scanned < maxRows) {
    const limit = Math.min(100, maxRows - scanned);
    const page = await db.collection('tasks').where(position ? { _id: db.command.gt(position) } : {}).orderBy('_id', 'asc').limit(limit).field(projected).get();
    if (!Array.isArray(page.data)) throw new Error('Invalid task page.');
    for (const row of page.data) {
      if (!uuid(row._id) || (position && row._id <= position)) throw new Error('Invalid task order.');
      position = row._id; scanned++; counts.scanned++;
      const derived = candidateFields(row);
      if (derived.status !== 'known') { fail(derived.status, row._id); continue; }
      const missing = !own(row, 'candidateSchema') || !own(row, 'candidateKind') || !own(row, 'scopeKey') || !own(row, 'candidateOrder');
      const proven = derived.fields.candidateKind !== 'single' || await proveSingle(db, row);
      if (!proven) derived.fields.candidateKind = 'history';
      const matches = Object.entries(derived.fields).every(([key, value]) => row[key] === value);
      // Detect business edits while segment proof was outside the transaction, including replacements and migration.
      const tx = await db.startTransaction();
      let result;
      try {
        const ref = db.collection('tasks').doc(row._id), current = (await tx.get(ref)).data();
        if (!current || snapshot(current) !== snapshot(row)) result = 'conflict';
        else if (matches) result = 'covered';
        else {
          if (apply) await tx.update(ref, derived.fields);
          result = missing ? 'missing' : 'invalid';
        }
        await tx.commit();
      } catch {
        try { await tx.rollback(); } catch { /* Retry the row from the last checkpoint; never print SDK errors. */ }
        result = 'conflict';
      }
      if (result === 'conflict') fail('conflict', row._id);
      else { if (result === 'covered') counts.covered++; else fail(result, row._id); if (apply && result !== 'covered') counts.applied++; }
    }
    if (page.data.length < limit) { complete = true; break; }
  }
  const next = !complete && position ? Buffer.from(JSON.stringify({ v: 1, environment, apply, after: position, counts, failedIds })).toString('base64url') : null;
  // Applying successfully does not constitute verification. A fresh complete dry-run is required.
  const coverageVerified = !apply && complete && counts.missing === 0 && counts.invalid === 0 && counts.unknown === 0 && counts.conflict === 0;
  return { apply, scannedThisRun: scanned, counts, failedIds, complete, checkpoint: next, coverageVerified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = { apply: false, maxRows: 1000, after: null, environment: process.env.TCB_ENV_ID };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--max-rows') options.maxRows = Number(args[++i]);
    else if (args[i] === '--after' && args[i + 1]) options.after = args[++i];
    else throw new Error('Usage: task-candidates.mjs [--apply] [--max-rows 1..10000] [--after CHECKPOINT]');
  }
  if (!options.environment || !process.env.TENCENTCLOUD_SECRETID || !process.env.TENCENTCLOUD_SECRETKEY) throw new Error('Set verified TCB_ENV_ID and maintenance credentials.');
  const { default: cloudbase } = await import('@cloudbase/node-sdk');
  const db = cloudbase.init({ env: options.environment, secretId: process.env.TENCENTCLOUD_SECRETID, secretKey: process.env.TENCENTCLOUD_SECRETKEY, sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }).database();
  try { console.log(JSON.stringify(await backfillTaskCandidates(db, options))); }
  catch { console.error('Candidate maintenance failed; no switch was changed. Retry from the previous checkpoint.'); process.exitCode = 1; }
}
