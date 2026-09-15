import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { envId } = JSON.parse(readFileSync('cloudbaserc.json', 'utf8'));
const cli = process.env.TCB_CLI;
const databaseName = process.env.TCB_DATABASE;
if (!cli || !databaseName) throw new Error('Set verified TCB_CLI and TCB_DATABASE.');
const connector = { EnvId: envId, MongoConnector: { DatabaseName: databaseName, InstanceId: 'flexdb' } };
const desired = {
  schedule_segments: [
    ['task_segment_window', 'taskId', 'effectiveUntil', 'effectiveFrom', 'listOrder'],
    ['task_segment_previous_end', 'taskId', 'effectiveUntil'],
  ],
  query_sessions: [['session_expiry', 'expiresAt', '_id']],
};
const apply = process.argv.includes('--apply');
const journal = { envId, databaseName, apply, startedAt: new Date().toISOString(), operations: [], verified: [] };
const journalPath = process.env.TCB_MIGRATION_JOURNAL || 'database/performance-provision-result.json';
function api(action, body) {
  const raw = execFileSync(process.execPath, [cli, 'api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify(body), '--json'], { encoding: 'utf8', timeout: 60000 });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
  const result = parsed.data ?? parsed.Response ?? parsed;
  if (result.Error || parsed.success === false) throw new Error(JSON.stringify(result));
  journal.operations.push({ action, collection: body.TableName, requestId: result.RequestId, at: new Date().toISOString() });
  if (apply) writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  return result;
}
function indexes(table) { return table.Indexes ?? table.IndexInfo?.Indexes ?? []; }
function matches(index, fields) {
  return index.Unique === false && Array.isArray(index.Keys) && index.Keys.length === fields.length
    && index.Keys.every((key, i) => key.Name === fields[i] && String(key.Direction) === '1');
}
for (const [TableName, definitions] of Object.entries(desired)) {
  const present = indexes(api('DescribeTable', { ...connector, TableName }));
  for (const [name, ...fields] of definitions) {
    const existing = present.find(index => (index.Name ?? index.IndexName) === name);
    if (existing && !matches(existing, fields)) throw new Error(`Existing index differs: ${TableName}/${name}`);
  }
  const missing = definitions.filter(([name]) => !present.some(index => (index.Name ?? index.IndexName) === name));
  console.log(JSON.stringify({ collection: TableName, missing, apply }));
  if (apply && missing.length) api('UpdateTable', { ...connector, TableName, CreateIndexes: missing.map(([IndexName, ...fields]) => ({ IndexName, MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: fields.map(Name => ({ Name, Direction: '1' })) } })) });
  if (apply) {
    const after = indexes(api('DescribeTable', { ...connector, TableName }));
    for (const [name, ...fields] of definitions) {
      const index = after.find(index => (index.Name ?? index.IndexName) === name);
      if (!index || !matches(index, fields)) throw new Error(`Index verification failed: ${TableName}/${name}`);
      journal.verified.push({ collection: TableName, name, keys: index.Keys, unique: index.Unique });
    }
  }
}
if (apply) {
  journal.completedAt = new Date().toISOString();
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
}
console.log(JSON.stringify({ complete: true, apply, verified: journal.verified.length }));
