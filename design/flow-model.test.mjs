import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, validateDraft, setViewer, transitionTask, recordAction, transferOwner, exitMember, DEMO_NOW } from './flow-model.mjs';

test('no time keeps my reminder enabled; duplicate times and empty weekdays are rejected', () => {
  const { task } = createDemo();
  task.times = [];
  assert.equal(validateDraft(task), '');
  assert.equal(task.remindMe, true);
  task.times = ['19:00', '19:00'];
  assert.match(validateDraft(task), /不能重复/);
  task.times = [];
  task.weekdays = [];
  assert.match(validateDraft(task), /至少选择/);
});
test('invalid calendar date and end before start are rejected', () => {
  const { task } = createDemo();
  task.start = '2026-02-30';
  assert.match(validateDraft(task), /有效/);
  task.start = '2026-09-11'; task.end = '2026-09-10';
  assert.match(validateDraft(task), /结束日期/);
});
test('removing view revokes assistance and reminders, adding view alone grants neither', () => {
  const { task } = createDemo(); task.reminders = ['gran'];
  setViewer(task, 'gran', false);
  assert.ok(!task.helpers.includes('gran'));
  assert.ok(!task.reminders.includes('gran'));
  setViewer(task, 'gran', true);
  assert.ok(task.viewers.includes('gran'));
  assert.ok(!task.helpers.includes('gran'));
});
test('a restored stopped series cannot resume, while a normal deleted series restores paused', () => {
  const { task } = createDemo();
  transitionTask(task, 'stop'); transitionTask(task, 'delete'); transitionTask(task, 'restore');
  assert.equal(task.lifecycle, 'paused');
  assert.throws(() => transitionTask(task, 'resume'), /已停止/);
  const normal = createDemo().task;
  transitionTask(normal, 'delete'); transitionTask(normal, 'restore'); transitionTask(normal, 'resume');
  assert.equal(normal.lifecycle, 'active');
});
test('completion compares instants across timezone representations and undo preserves audit', () => {
  const state = createDemo();
  assert.throws(() => recordAction(state, 'completed', '2026-09-11T18:31:00+08:00'), /完成时间/);
  assert.throws(() => recordAction(state, 'completed', '2026-09-10T23:59:00+08:00'), /完成时间/);
  recordAction(state, 'completed', DEMO_NOW);
  assert.throws(() => recordAction(state, 'completed', DEMO_NOW), /先撤销/);
  recordAction(state, 'undo');
  assert.equal(state.record.status, 'pending');
  assert.equal(state.history.length, 2);
  recordAction(state, 'skipped');
  assert.equal(state.record.actual, '');
  recordAction(state, 'undo');
  assert.throws(() => recordAction(state, 'garbage'), /未知/);
});
test('owner must transfer before exit and ordinary members cannot remove another', () => {
  const { family } = createDemo();
  assert.throws(() => exitMember(family, 'me'), /先转交/);
  assert.throws(() => transferOwner(family, 'child'), /真实成员/);
  transferOwner(family, 'dad');
  assert.throws(() => exitMember(family, 'gran'), /只有拥有人/);
  exitMember(family, 'me');
  assert.equal(family.owner, 'dad');
  assert.ok(!family.members.some((member) => member.id === 'me'));
});
