import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { envId } = JSON.parse(readFileSync('cloudbaserc.json', 'utf8'));
const cli = process.env.TCB_CLI;
const databaseName = process.env.TCB_DATABASE;
if (process.argv.includes('--apply') && (!cli || !databaseName)) throw new Error('Set TCB_CLI and TCB_DATABASE from the verified target environment.');
const env = { EnvId: envId };
const connector = { ...env, MongoConnector: { DatabaseName: databaseName, InstanceId: 'flexdb' } };
const collections = ['tasks'];
const indexes = { tasks: [['task_date_candidates', 'scopeKey', 'candidateKind', 'lifecycle', 'candidateOrder']] };
const uniqueIndexes = {};
const plan = { envId, databaseName, collections, indexes, uniqueIndexes };
const journalPath = process.env.TCB_MIGRATION_JOURNAL || 'database/task-candidates-provision-result.json';
const journal = { ...plan, startedAt: new Date().toISOString(), operations: [], verified: [] };
function api(action, body) {
  let parsed;
  try {
    const raw = execFileSync(process.execPath, [cli, 'api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify(body), '--json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    parsed = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch { throw new Error('Candidate index operation failed; CLI output withheld.'); }
  const result = parsed.data ?? parsed.Response ?? parsed;
  if (result.Error || parsed.success === false) throw new Error('Candidate index operation failed.');
  journal.operations.push({ action, collection: body.TableName ?? body.CollectionName, requestId: result.RequestId, at: new Date().toISOString() });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  return result;
}
function indexList(table) { return table.Indexes ?? table.IndexInfo?.Indexes ?? []; }
if (!process.argv.includes('--apply')) console.log(JSON.stringify(plan, null, 2));
else {
  for (const name of collections) {
    const desired = [...(indexes[name] ?? []).map(value => ({ value, unique: false })), ...(uniqueIndexes[name] ?? []).map(value => ({ value, unique: true }))];
    const present = indexList(api('DescribeTable', { ...connector, TableName: name }));
    for (const { value: [indexName, ...fields] } of desired) {
      const existing = present.find(index => (index.Name ?? index.IndexName) === indexName);
      if (existing && (existing.Unique !== false || !Array.isArray(existing.Keys) || existing.Keys.length !== fields.length || existing.Keys.some((field, i) => field.Name !== fields[i] || String(field.Direction) !== '1'))) throw new Error('Existing candidate index differs; no replacement is performed.');
    }
    const missing = desired.filter(({ value: [indexName] }) => !present.some(index => (index.Name ?? index.IndexName) === indexName));
    if (missing.length) api('UpdateTable', { ...connector, TableName: name, CreateIndexes: missing.map(({ value: [IndexName, ...fields], unique }) => ({ IndexName, MgoKeySchema: { MgoIsUnique: unique, MgoIndexKeys: fields.map(Name => ({ Name, Direction: '1' })) } })) });
    const after = indexList(api('DescribeTable', { ...connector, TableName: name }));
    for (const { value: [indexName, ...fields], unique } of desired) {
      const index = after.find(index => (index.Name ?? index.IndexName) === indexName);
      if (!index || index.Unique !== unique || !Array.isArray(index.Keys) || index.Keys.length !== fields.length || index.Keys.some((field, i) => field.Name !== fields[i] || String(field.Direction) !== '1')) throw new Error(`Index definition mismatch: ${name}/${indexName}`);
    }
    const verification = { collection: name, indexes: after.map(index => ({ name: index.Name, unique: index.Unique, keys: index.Keys })) };
    journal.verified.push(verification);
    console.log(JSON.stringify(verification));
  }
  journal.completedAt = new Date().toISOString();
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
}
