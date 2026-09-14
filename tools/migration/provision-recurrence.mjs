import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { envId } = JSON.parse(readFileSync('cloudbaserc.json', 'utf8'));
const cli = process.env.TCB_CLI;
const databaseName = process.env.TCB_DATABASE;
if (!cli || !databaseName) throw new Error('Set TCB_CLI and TCB_DATABASE from the verified target environment.');
const env = { EnvId: envId };
const connector = { ...env, MongoConnector: { DatabaseName: databaseName, InstanceId: 'flexdb' } };
const collections = ['schedule_segments', 'schedule_controls', 'occurrence_states', 'historical_subject_access', 'tasks'];
const indexes = {
  schedule_segments: [['task_segments', 'taskId', 'listOrder']],
  schedule_controls: [['task_control_boundary', 'taskId', 'controlOrder']],
  tasks: [['personal_projection', 'ownerUserId', 'createdOrder'], ['family_projection', 'familyId', 'createdOrder']],
};
const uniqueIndexes = { occurrence_states: [['unique_occurrence_identity', 'taskId', 'segmentId', 'localDate', 'slot']] };
const plan = { envId, databaseName, collections, indexes, uniqueIndexes };
const journalPath = process.env.TCB_MIGRATION_JOURNAL || 'database/recurrence-provision-result.json';
const journal = { ...plan, startedAt: new Date().toISOString(), operations: [], verified: [] };
function api(action, body) {
  const raw = execFileSync(process.execPath, [cli, 'api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify(body), '--json'], { encoding: 'utf8', timeout: 60000 });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
  const result = parsed.data ?? parsed.Response ?? parsed;
  if (result.Error || parsed.success === false) throw new Error(JSON.stringify(result));
  journal.operations.push({ action, collection: body.TableName ?? body.CollectionName, requestId: result.RequestId, at: new Date().toISOString() });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  return result;
}
function indexList(table) { return table.Indexes ?? table.IndexInfo?.Indexes ?? []; }
if (!process.argv.includes('--apply')) console.log(JSON.stringify(plan, null, 2));
else {
  const existing = api('ListTables', { ...connector, MgoLimit: 100, MgoOffset: 0 });
  if (!Array.isArray(existing.Tables)) throw new Error('Unexpected ListTables response.');
  for (const name of collections) {
    if (!existing.Tables.some(table => table.TableName === name)) api('CreateTable', { ...connector, TableName: name });
    api('ModifyDatabaseACL', { ...env, CollectionName: name, AclTag: 'ADMINONLY' });
    const acl = api('DescribeDatabaseACL', { ...env, CollectionName: name });
    if (acl.AclTag !== 'ADMINONLY') throw new Error(`Server-only permission verification failed for ${name}.`);
    const desired = [...(indexes[name] ?? []).map(value => ({ value, unique: false })), ...(uniqueIndexes[name] ?? []).map(value => ({ value, unique: true }))];
    const present = indexList(api('DescribeTable', { ...connector, TableName: name }));
    const missing = desired.filter(({ value: [indexName] }) => !present.some(index => (index.Name ?? index.IndexName) === indexName));
    if (missing.length) api('UpdateTable', { ...connector, TableName: name, CreateIndexes: missing.map(({ value: [IndexName, ...fields], unique }) => ({ IndexName, MgoKeySchema: { MgoIsUnique: unique, MgoIndexKeys: fields.map(Name => ({ Name, Direction: '1' })) } })) });
    const after = indexList(api('DescribeTable', { ...connector, TableName: name }));
    for (const { value: [indexName, ...fields], unique } of desired) {
      const index = after.find(index => (index.Name ?? index.IndexName) === indexName);
      if (!index || index.Unique !== unique || !Array.isArray(index.Keys) || index.Keys.length !== fields.length || index.Keys.some((field, i) => field.Name !== fields[i] || String(field.Direction) !== '1')) throw new Error(`Index definition mismatch: ${name}/${indexName}`);
    }
    const verification = { collection: name, acl: acl.AclTag, indexes: after.map(index => ({ name: index.Name, unique: index.Unique, keys: index.Keys })) };
    journal.verified.push(verification);
    console.log(JSON.stringify(verification));
  }
  journal.completedAt = new Date().toISOString();
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
}
