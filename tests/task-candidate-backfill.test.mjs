import { describe, expect, it } from 'vitest';
import { backfillTaskCandidates, candidateFields } from '../tools/migration/task-candidates.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, extra = {}) => ({ _id: id(n), schemaVersion: 1, ownerUserId: id(100), version: 1, lifecycle: 'active', date: '2026-09-16', time: null, createdAt: '2026-09-16T00:00:00.000Z', title: '保留业务内容', ...extra });
function fixture(initial, beforeGet = () => {}) {
  const rows = new Map(initial.map(value => [value._id, structuredClone(value)])), updates = [], pages = [], segments = [];
  const db = { command: { gt: value => ({ gt: value }) }, collection: name => ({
    doc: key => ({ key }), where(filter) {
      const state = { name, filter, limit: 0, fields: {} };
      const query = {
        orderBy(key) { state.order = key; return query; }, limit(value) { state.limit = value; return query; }, field(value) { state.fields = value; return query; },
        async get() {
          pages.push(state);
          const data = [...(name === 'tasks' ? rows.values() : segments)].filter(value => Object.entries(filter).every(([key, expected]) => expected?.gt ? value[key] > expected.gt : value[key] === expected)).sort((a,b) => String(a[state.order]).localeCompare(String(b[state.order]))).slice(0, state.limit);
          return { data: data.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => state.fields[key]))) };
        }
      }; return query;
    }
  }), async startTransaction() {
    let patch;
    return { async get(ref) { beforeGet(rows, ref.key); return { data: () => rows.get(ref.key) }; }, async update(ref, value) { patch = { id: ref.key, fields: structuredClone(value) }; }, async commit() { if (patch) { updates.push(patch); Object.assign(rows.get(patch.id), patch.fields); } }, async rollback() { patch = undefined; } };
  } };
  return { db, rows, updates, pages, segments };
}

describe('bounded task candidate maintenance', () => {
  it('defaults to dry-run, resumes bounded scans, only patches derived fields and verifies a fresh pass', async () => {
    const f = fixture([row(1), row(2), row(3)]);
    const dry = await backfillTaskCandidates(f.db, { maxRows: 2 });
    expect(dry).toMatchObject({ complete: false, counts: { missing: 2 }, coverageVerified: false }); expect(f.updates).toHaveLength(0);
    const resumed = await backfillTaskCandidates(f.db, { maxRows: 2, after: dry.checkpoint });
    expect(resumed).toMatchObject({ complete: true, counts: { scanned: 3, missing: 3 }, coverageVerified: false });
    await expect(backfillTaskCandidates(f.db, { apply: true, after: dry.checkpoint })).rejects.toThrow('Incompatible');
    const applied = await backfillTaskCandidates(f.db, { apply: true });
    expect(applied.counts.applied).toBe(3); expect(applied.coverageVerified).toBe(false);
    expect(f.updates.every(update => Object.keys(update.fields).sort().join(',') === 'candidateKind,candidateOrder,candidateSchema,scopeKey')).toBe(true);
    expect(f.rows.get(id(1))).toMatchObject({ version: 1, title: '保留业务内容' });
    expect(await backfillTaskCandidates(f.db)).toMatchObject({ complete: true, coverageVerified: true });
    expect((await backfillTaskCandidates(f.db, { apply: true })).counts.applied).toBe(0);
    expect(f.pages.every(page => page.limit <= 100 && !page.fields.title)).toBe(true);
  });
  it('rejects unknown schemas and invalid ownership without ever reporting coverage', async () => {
    const f = fixture([row(1, { schemaVersion: 2 }), row(2, { candidateSchema: 3 }), row(3, { familyId: id(7), collaboration: { familyId: id(8) } }), row(4, { date: '2026-02-30' })]);
    const result = await backfillTaskCandidates(f.db, { apply: true });
    expect(result).toMatchObject({ complete: true, coverageVerified: false, counts: { unknown: 2, invalid: 2, applied: 0 } });
    expect(result.failedIds).toHaveLength(4);
  });
  it.each(['version', 'owner', 'replacement', 'metadata'])('does not overwrite concurrent %s changes and permits a safe rerun', async kind => {
    let first = true;
    const f = fixture([row(1)], (rows, key) => { if (!first) return; first = false; const current = rows.get(key); if (kind === 'version') current.version++; if (kind === 'owner') { current.collaboration = { familyId: id(7) }; current.familyId = id(7); } if (kind === 'replacement') rows.set(key, { ...current, createdAt: '2026-09-17T00:00:00.000Z' }); if (kind === 'metadata') { current.candidateSchema = 1; current.candidateKind = 'history'; } });
    expect(await backfillTaskCandidates(f.db, { apply: true })).toMatchObject({ counts: { conflict: 1, applied: 0 }, coverageVerified: false });
    expect(f.updates).toHaveLength(0);
    expect((await backfillTaskCandidates(f.db, { apply: true })).counts.applied).toBe(1);
    if (kind === 'metadata') expect(f.rows.get(id(1)).candidateKind).toBe('history');
    if (kind === 'owner') expect(f.rows.get(id(1)).scopeKey).toBe(`f/${id(7)}`);
  });
  it('never infers single from current once or hasHistory and audits existing single proof', async () => {
    const recurrence = { schedule: { kind: 'once', date: '2026-09-16', time: null }, currentSegmentId: id(50), hasHistory: false };
    expect(candidateFields(row(1, { recurrence })).fields.candidateKind).toBe('history');
    const f = fixture([row(1, { recurrence, candidateSchema: 1, candidateKind: 'single', scopeKey: `p/${id(100)}`, candidateOrder: `2026-09-16/99:99/${id(1)}` })]);
    f.segments.push({ _id: id(50), schemaVersion: 1, taskId: id(1), listOrder: `2026/${id(50)}`, schedule: recurrence.schedule }, { _id: id(51), schemaVersion: 1, taskId: id(1), listOrder: `2027/${id(51)}`, schedule: { kind: 'daily' } });
    expect(await backfillTaskCandidates(f.db)).toMatchObject({ counts: { invalid: 1 }, coverageVerified: false });
    await backfillTaskCandidates(f.db, { apply: true });
    expect(f.rows.get(id(1)).candidateKind).toBe('history');
    f.segments.splice(1);
    await backfillTaskCandidates(f.db, { apply: true });
    expect(f.rows.get(id(1)).candidateKind).toBe('history');
  });
});
