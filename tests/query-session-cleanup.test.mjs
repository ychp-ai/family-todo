import { describe, expect, it } from 'vitest';
import { cleanupQuerySessions, decodeCleanupCheckpoint, encodeCleanupCheckpoint } from '../tools/cleanup-query-sessions.mjs';

const lt = value => ({ op: 'lt', value });
const gt = value => ({ op: 'gt', value });
const and = values => ({ op: 'and', values });
const or = values => ({ op: 'or', values });

function matches(row, filter) {
  if (filter?.op === 'and') return filter.values.every(value => matches(row, value));
  if (filter?.op === 'or') return filter.values.some(value => matches(row, value));
  return Object.entries(filter).every(([key, condition]) => {
    if (condition?.op === 'lt') return row[key] < condition.value;
    if (condition?.op === 'gt') return row[key] > condition.value;
    return row[key] === condition;
  });
}

function fixture(initialRows, { beforeRemove = () => {} } = {}) {
  const rows = new Map(initialRows.map(row => [row._id, structuredClone(row)]));
  const reads = [];
  const db = {
    command: { lt, gt, and, or },
    collection(name) {
      expect(name).toBe('query_sessions');
      return { where(filter) {
        const state = { filter, orders: [], projection: null, limit: null };
        const query = {
          orderBy(field, direction) { state.orders.push([field, direction]); return query; },
          field(projection) { state.projection = projection; return query; },
          limit(limit) { state.limit = limit; return query; },
          async get() {
            reads.push(structuredClone(state));
            const selected = [...rows.values()].filter(row => matches(row, state.filter)).sort((left, right) => {
              for (const [field, direction] of state.orders) {
                const order = left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
                if (order) return direction === 'asc' ? order : -order;
              }
              return 0;
            }).slice(0, state.limit).map(row => Object.fromEntries(Object.keys(state.projection).filter(key => state.projection[key]).map(key => [key, row[key]])));
            return { data: selected };
          },
          async remove() {
            beforeRemove(rows, state.filter);
            let deleted = 0;
            for (const [id, row] of rows) if (matches(row, state.filter)) { rows.delete(id); deleted++; }
            return { deleted };
          },
        };
        return query;
      } };
    },
  };
  return { db, rows, reads };
}

const now = new Date('2026-09-15T10:00:00.000Z');
const expired = '2026-09-01T00:00:00.000Z';
const row = (id, expiresAt = expired, schemaVersion = 1, extra = {}) => ({ _id: id, schemaVersion, expiresAt, secretPayload: 'must not be projected', ...extra });

describe('query session cleanup', () => {
  it('uses actual compound ordering and includes only cleanup fields', async () => {
    const f = fixture([row('z', '2026-09-03T00:00:00.000Z'), row('b'), row('a'), row('new', '2026-09-15T00:00:00.000Z')]);
    const result = await cleanupQuerySessions(f.db, { now });
    expect(result).toMatchObject({ scanned: 3, eligible: 3, deleted: 0, complete: true });
    expect(f.rows.size).toBe(4);
    expect(f.reads[0].orders).toEqual([['expiresAt', 'asc'], ['_id', 'asc']]);
    expect(f.reads[0].projection).toEqual({ _id: true, schemaVersion: true, expiresAt: true });
  });

  it('scans more than 200 scrambled rows and crosses identical-expiry page ties', async () => {
    const rows = Array.from({ length: 237 }, (_, index) => row(`id-${String(236 - index).padStart(3, '0')}`, index < 180 ? expired : '2026-09-02T00:00:00.000Z'));
    const f = fixture(rows.reverse());
    const result = await cleanupQuerySessions(f.db, { now, maxRows: 500 });
    expect(result).toMatchObject({ scanned: 237, eligible: 237, complete: true });
    expect(f.reads).toHaveLength(3);
  });

  it('resumes a bounded run after unknown schemas without starving later rows', async () => {
    const f = fixture([row('a', expired, 99), row('b', expired, 99), row('c'), row('d')]);
    const first = await cleanupQuerySessions(f.db, { now, maxRows: 2 });
    expect(first).toMatchObject({ scanned: 2, eligible: 0, skipped: 2, complete: false });
    expect(decodeCleanupCheckpoint(first.checkpoint)).toEqual({ cutoff: first.cutoff, expiresAt: expired, id: 'b' });
    const second = await cleanupQuerySessions(f.db, { now: new Date('2026-09-20T00:00:00.000Z'), maxRows: 10, after: first.checkpoint });
    expect(second).toMatchObject({ cutoff: first.cutoff, scanned: 2, eligible: 2, skipped: 0, complete: true });
  });

  it('conditionally deletes exact id, schema and expiry and preserves a replaced row', async () => {
    let replaced = false;
    const f = fixture([row('a'), row('b')], { beforeRemove(rows, filter) {
      if (!replaced && filter._id === 'a') { replaced = true; rows.set('a', row('a', '2026-09-16T00:00:00.000Z')); }
    } });
    const result = await cleanupQuerySessions(f.db, { now, apply: true });
    expect(result).toMatchObject({ eligible: 2, deleted: 1, complete: true });
    expect(f.rows.get('a').expiresAt).toBe('2026-09-16T00:00:00.000Z');
    expect(f.rows.has('b')).toBe(false);
  });

  it('rejects invalid bounds, cutoffs and checkpoint shapes', async () => {
    const f = fixture([]);
    await expect(cleanupQuerySessions(f.db, { now, maxRows: 10001 })).rejects.toThrow('Invalid cleanup bounds');
    await expect(cleanupQuerySessions(f.db, { now, graceMs: 86399999 })).rejects.toThrow('Invalid cleanup bounds');
    await expect(cleanupQuerySessions(f.db, { now, after: 'not-a-checkpoint' })).rejects.toThrow('Invalid cleanup checkpoint');
    const future = encodeCleanupCheckpoint({ cutoff: '2026-09-15T09:00:00.000Z', expiresAt: expired, id: 'a' });
    await expect(cleanupQuerySessions(f.db, { now, after: future })).rejects.toThrow('cutoff exceeds');
  });
});
