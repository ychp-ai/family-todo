import { afterEach, expect, it, vi } from 'vitest';
const { cleanup, init, db } = vi.hoisted(() => {
  const db = {};
  return { db, cleanup: vi.fn(), init: vi.fn(() => ({ database: () => db })) };
});
vi.mock('@cloudbase/node-sdk', () => ({ default: { init } }));
vi.mock('../tools/cleanup-query-sessions.mjs', () => ({ cleanupQuerySessions: cleanup }));
import { main } from '../cloudfunctions/cleanup-query-sessions/src/index';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it('rejects unrelated events before accessing storage', async () => {
  expect(await main({ Type: 'Timer', TriggerName: 'other' })).toEqual({ ok: false, code: 'INVALID_CLEANUP_EVENT' });
  expect(init).not.toHaveBeenCalled();
});
it.each([
  [{ Type: 'Timer', TriggerName: 'cleanup-query-sessions-12h', graceMs: 0 }, true],
  [{ mode: 'dry-run', apply: true }, false],
  [{ mode: 'apply' }, true],
])('uses fixed cleanup bounds for %j', async (event, apply) => {
  vi.stubEnv('SCF_NAMESPACE', 'verified-environment');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  cleanup.mockResolvedValue({ complete: true, deleted: 2 });
  expect(await main(event)).toMatchObject({ ok: true, complete: true });
  expect(init).toHaveBeenCalledWith({ env: 'verified-environment' });
  expect(cleanup).toHaveBeenCalledWith(db, expect.objectContaining({ apply, maxRows: 10000, graceMs: 86400000, shouldStop: expect.any(Function) }));
});
it('reports failures without SDK details', async () => {
  vi.stubEnv('SCF_NAMESPACE', 'verified-environment');
  cleanup.mockRejectedValue(new Error('private SDK details'));
  await expect(main({ mode: 'apply' })).rejects.toThrow('Query session cleanup failed.');
});
