import type cloudbase from '@cloudbase/node-sdk';
export interface CleanupResult {
  apply: boolean;
  cutoff: string;
  scanned: number;
  eligible: number;
  deleted: number;
  skipped: number;
  complete: boolean;
  checkpoint: string | null;
}
export function cleanupQuerySessions(
  db: ReturnType<ReturnType<typeof cloudbase.init>['database']>,
  options?: { now?: Date; apply?: boolean; maxRows?: number; graceMs?: number; after?: string | null; shouldStop?: () => boolean }
): Promise<CleanupResult>;
