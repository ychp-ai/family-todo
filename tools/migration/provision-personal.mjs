import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('cloudbaserc.json', 'utf8'));
const cli = process.env.TCB_CLI;
if (!cli) throw new Error('Set TCB_CLI to the installed CloudBase CLI entry file.');
const databaseName = process.env.TCB_DATABASE;
if (!databaseName) throw new Error('Set TCB_DATABASE from DescribeEnvs.Databases.InstanceId.');
const env = { EnvId: config.envId };
const connector = { ...env, MongoConnector: { DatabaseName: databaseName, InstanceId: 'flexdb' } };
const collections = ['users', 'identities', 'user_scopes', 'tasks', 'task_events', 'idempotency_receipts', 'query_sessions'];
const indexes = {
  tasks: [
    ['personal_schedule', 'ownerUserId', 'lifecycle', 'scheduleOrder'],
    ['personal_created', 'ownerUserId', 'lifecycle', 'createdOrder'],
    ['personal_status_schedule', 'ownerUserId', 'lifecycle', 'status', 'scheduleOrder'],
    ['personal_recent', 'ownerUserId', 'lifecycle', 'status', 'recentOrder'],
    ['personal_reminders', 'ownerUserId', 'lifecycle', 'status', 'reminderEnabled', 'dismissedAt', 'recentOrder'],
    ['personal_all_reminders', 'ownerUserId', 'lifecycle', 'status', 'reminderEnabled', 'recentOrder'],
  ],
  task_events: [['task_history', 'taskId', 'eventOrder']],
};
const apply = process.argv.includes('--apply');
const journal = { envId: config.envId, databaseName, startedAt: new Date().toISOString(), operations: [] };
function api(action, body) {
  const raw = execFileSync(process.execPath, [cli, 'api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify(body), '--json'], { encoding: 'utf8', timeout: 60000 });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
  const result = parsed.data ?? parsed.Response ?? parsed;
  if (result.Error || parsed.success === false) throw new Error(JSON.stringify(result));
  journal.operations.push({ action, collection: body.TableName ?? body.CollectionName, requestId: result.RequestId, at: new Date().toISOString() });
  writeFileSync('database/personal-provision-result.json', JSON.stringify(journal, null, 2) + '\n');
  return result;
}
if (!apply) { console.log(JSON.stringify({ envId: config.envId, databaseName, collections, indexes }, null, 2)); }
else {
  const existing = api('ListTables', { ...connector, MgoLimit: 100, MgoOffset: 0 });
  if (!Array.isArray(existing.Tables)) throw new Error('Unexpected ListTables response.');
  for (const name of collections) {
    if (!existing.Tables.some(table => table.TableName === name)) api('CreateTable', { ...connector, TableName: name });
    api('ModifyDatabaseACL', { ...env, CollectionName: name, AclTag: 'ADMINONLY' });
    const acl = api('DescribeDatabaseACL', { ...env, CollectionName: name });
    console.log(name, 'ACL', JSON.stringify(acl));
    if (acl.AclTag !== 'ADMINONLY') throw new Error('Server-only permission verification failed.');
    const detail = api('DescribeTable', { ...connector, TableName: name });
    const present = detail.Indexes ?? detail.IndexInfo?.Indexes ?? [];
    const missing = (indexes[name] ?? []).filter(([indexName]) => !present.some(index => (index.Name ?? index.IndexName) === indexName));
    if (missing.length) api('UpdateTable', { ...connector, TableName: name, CreateIndexes: missing.map(([IndexName, ...fields]) => ({ IndexName, MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: fields.map(Name => ({ Name, Direction: '1' })) } })) });
    const after = api('DescribeTable', { ...connector, TableName: name });
    console.log(name, 'indexes', JSON.stringify(after.Indexes));
  }
  journal.completedAt = new Date().toISOString();
  writeFileSync('database/personal-provision-result.json', JSON.stringify(journal, null, 2) + '\n');
}
