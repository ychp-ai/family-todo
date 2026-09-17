import cloudbase from '@cloudbase/node-sdk';
import { cleanupQuerySessions } from '../../../tools/cleanup-query-sessions.mjs';

const triggerName = 'cleanup-query-sessions-12h';
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Client calls are denied by the function's invoke:false security rule. */
export async function main(event: unknown) {
  const timer = record(event) && event.Type === 'Timer' && event.TriggerName === triggerName;
  const manual = record(event) && (event.mode === 'dry-run' || event.mode === 'apply');
  if (!timer && !manual) return { ok: false, code: 'INVALID_CLEANUP_EVENT' };
  const env = process.env.SCF_NAMESPACE;
  if (!env) throw new Error('Cleanup environment is unavailable.');
  const deadline = Date.now() + 50_000;
  try {
    const db = cloudbase.init({ env }).database();
    const result = await cleanupQuerySessions(db, {
      apply: timer || (record(event) && event.mode === 'apply'),
      maxRows: 10_000,
      graceMs: 86_400_000,
      shouldStop: () => Date.now() >= deadline,
    });
    // A later run rescans remaining expired rows; completed conditional deletes are safe to repeat.
    console.info(JSON.stringify({ event: 'query_sessions_cleanup', ...result }));
    return { ok: true, ...result };
  } catch {
    throw new Error('Query session cleanup failed.');
  }
}
