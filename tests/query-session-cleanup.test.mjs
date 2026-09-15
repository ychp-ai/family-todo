import { describe, expect, it } from 'vitest';
import { cleanupQuerySessions } from '../tools/cleanup-query-sessions.mjs';

function fixture() {
  const rows = new Map([
    ['a', { _id: 'a', schemaVersion: 1, expiresAt: '2026-09-01T00:00:00.000Z' }],
    ['b', { _id: 'b', schemaVersion: 2, expiresAt: '2026-09-01T00:00:00.000Z' }],
    ['c', { _id: 'c', schemaVersion: 3, expiresAt: '2026-09-01T00:00:00.000Z' }],
    ['d', { _id: 'd', schemaVersion: 2, expiresAt: '2026-09-15T00:00:00.000Z' }],
  ]);
  let beforeRemove = () => {};
  const db = {
    command: { lt: v => x => x < v, gt: v => x => x > v },
    collection: name => {
      expect(name).toBe('query_sessions');
      return { where: filter => {
        const matches = row => Object.entries(filter).every(([k, v]) => typeof v === 'function' ? v(row[k]) : row[k] === v);
        return { orderBy: () => ({ limit: count => ({ get: async () => ({ data: [...rows.values()].filter(matches).slice(0, count).map(x => ({ ...x })) }) }) }),
          remove: async () => { beforeRemove(); let deleted = 0; for (const [id, row] of rows) if (matches(row)) { rows.delete(id); deleted++; } return { deleted }; } };
      } };
    }
  };
  return { db, rows, onRemove: callback => { beforeRemove = callback; } };
}
const options = { now: new Date('2026-09-15T10:00:00.000Z') };
describe('query session cleanup', () => {
  it('defaults to dry-run and skips recent and unknown schema records', async () => {
    const f = fixture();
    expect(await cleanupQuerySessions(f.db, options)).toMatchObject({ scanned: 3, eligible: 2, deleted: 0, skipped: 1, complete: true });
    expect(f.rows.size).toBe(4);
  });
  it('deletes only expired supported records and respects the work bound', async () => {
    const f = fixture();
    expect(await cleanupQuerySessions(f.db, { ...options, apply: true, maxRows: 1 })).toMatchObject({ scanned: 1, deleted: 1, complete: false });
    expect(f.rows.has('a')).toBe(false);
    expect(await cleanupQuerySessions(f.db, { ...options, apply: true })).toMatchObject({ deleted: 1, skipped: 1, complete: true });
    expect([...f.rows.keys()]).toEqual(['c', 'd']);
  });
  it('does not delete a record replaced after the scan', async () => {
    const f = fixture();
    f.onRemove(() => { f.rows.set('a', { _id: 'a', schemaVersion: 1, expiresAt: '2026-09-16T00:00:00.000Z' }); });
    expect(await cleanupQuerySessions(f.db, { ...options, apply: true })).toMatchObject({ deleted: 1 });
    expect(f.rows.has('a')).toBe(true);
  });
});
