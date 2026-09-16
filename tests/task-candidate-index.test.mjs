import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('plans locally and applies only the missing candidate index through an isolated fake CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'candidate-index-'));
  const script = resolve('tools/migration/provision-task-candidates.mjs');
  try {
    writeFileSync(join(directory, 'cloudbaserc.json'), JSON.stringify({ envId: 'local-mock-only' }));
    const plan = JSON.parse(execFileSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' }));
    expect(plan.indexes.tasks).toEqual([['task_date_candidates', 'scopeKey', 'candidateKind', 'lifecycle', 'candidateOrder']]);
    const cli = join(directory, 'fake-cli.cjs');
    writeFileSync(cli, `const fs = require('node:fs'); const a = process.argv.slice(2); const action = a[2]; const body = JSON.parse(a[a.indexOf('--body') + 1]); const state = 'indexes.json'; const indexes = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : [{Name:'old_index',Unique:false,Keys:[{Name:'createdOrder',Direction:'1'}]}]; if (action === 'UpdateTable') { if (body.DropIndexes || body.CreateIndexes.length !== 1) throw Error('Unexpected mutation'); for (const x of body.CreateIndexes) indexes.push({Name:x.IndexName,Unique:x.MgoKeySchema.MgoIsUnique,Keys:x.MgoKeySchema.MgoIndexKeys}); fs.writeFileSync(state,JSON.stringify(indexes)); } else if (action !== 'DescribeTable') throw Error('Unexpected action'); console.log(JSON.stringify({Response:{Indexes:indexes}}));`);
    const env = { ...process.env, TCB_CLI: cli, TCB_DATABASE: 'local-mock-only', TCB_MIGRATION_JOURNAL: join(directory, 'journal.json') };
    execFileSync(process.execPath, [script, '--apply'], { cwd: directory, env });
    let journal = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
    expect(journal.operations.map(x => x.action)).toEqual(['DescribeTable', 'UpdateTable', 'DescribeTable']);
    expect(journal.verified[0].indexes.map(x => x.name)).toEqual(['old_index', 'task_date_candidates']);
    execFileSync(process.execPath, [script, '--apply'], { cwd: directory, env });
    journal = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
    expect(journal.operations.map(x => x.action)).toEqual(['DescribeTable', 'DescribeTable']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
