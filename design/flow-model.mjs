// Local fixtures for design review; not the production domain implementation.
export const DEMO_NOW = '2026-09-11T10:30:00.000Z';
export function createDemo() {
  return {
    family: { name: '我的小家', owner: 'me', members: [{ id: 'me', name: '妈妈（我）' }, { id: 'dad', name: '爸爸' }, { id: 'gran', name: '奶奶' }], virtualMembers: [{ id: 'child', name: '小宝', active: true }] },
    invitation: 'active', joined: false,
    task: { title: '阅读 20 分钟', note: '读完后聊聊最喜欢的故事。', family: 'mine', subject: 'child', repeat: 'weekly', start: '2026-09-11', end: '', weekdays: [1, 2, 3, 4, 5], times: ['19:00', '20:00'], remindMe: true, viewers: ['dad', 'gran'], helpers: ['gran'], reminders: [], lifecycle: 'active', stoppedBeforeDelete: false },
    record: { status: 'pending', actual: '', operator: '', version: 0 },
    history: [], saved: false,
  };
}
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01' && value <= '2100-12-31' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
export function validateDraft(task) {
  if (!task.title.trim() || [...task.title.trim()].length > 80) return '事项名称请填写 1–80 个字。';
  if ([...task.note].length > 1000) return '备注最多填写 1000 个字。';
  if (task.start && !validDate(task.start)) return '请选择有效的开始日期。';
  if (task.end && (!validDate(task.end) || task.end < task.start)) return '结束日期不能早于开始日期。';
  if (task.repeat !== 'once' && !task.start) return '周期事项需要开始日期。';
  if (task.repeat === 'weekly' && !task.weekdays.length) return '请至少选择一个星期。';
  if (task.times.length && !task.start) return '设置时刻前，请先选择日期。';
  if (task.times.length > (task.repeat === 'once' ? 1 : 6)) return task.repeat === 'once' ? '一次性事项只能设置一个时刻。' : '每天最多设置 6 个时刻。';
  if (task.times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return '请填写有效时刻，或移除空白时刻。';
  if (new Set(task.times).size !== task.times.length) return '同一天的时刻不能重复。';
  if (task.helpers.some((id) => !task.viewers.includes(id)) || task.reminders.some((id) => !task.viewers.includes(id))) return '代记和提醒对象需要先有查看权限。';
  return '';
}
export function setViewer(task, id, enabled) {
  task.viewers = enabled ? [...new Set([...task.viewers, id])] : task.viewers.filter((value) => value !== id);
  if (!enabled) {
    task.helpers = task.helpers.filter((value) => value !== id);
    task.reminders = task.reminders.filter((value) => value !== id);
  }
}
export function transitionTask(task, action) {
  const states = { pause: ['active'], resume: ['paused'], stop: ['active', 'paused'], delete: ['active', 'paused', 'stopped'], restore: ['deleted'] };
  if (!states[action]?.includes(task.lifecycle)) throw new Error('当前状态不能执行此操作。');
  if (task.repeat === 'once' && ['pause', 'resume', 'stop'].includes(action)) throw new Error('一次性事项没有周期操作。');
  if (action === 'resume' && task.stoppedBeforeDelete) throw new Error('已停止的系列不能继续，请另建事项。');
  if (action === 'delete') task.stoppedBeforeDelete = task.stoppedBeforeDelete || task.lifecycle === 'stopped';
  task.lifecycle = action === 'restore' ? task.repeat === 'once' ? 'active' : 'paused' : ({ pause: 'paused', resume: 'active', stop: 'stopped', delete: 'deleted' })[action];
}
export function recordAction(state, action, actual = '') {
  if (state.task.lifecycle === 'deleted') throw new Error('请先恢复事项。');
  if (action === 'undo') {
    if (state.record.status === 'pending') throw new Error('当前没有可撤销的记录。');
    state.record.status = 'pending'; state.record.actual = ''; state.record.operator = '';
  } else {
    if (state.record.status !== 'pending') throw new Error('这一次已记录，请先撤销再修改。');
    if (!['completed', 'skipped'].includes(action)) throw new Error('未知记录操作。');
    const instant = Date.parse(actual);
    if (action === 'completed' && (!Number.isFinite(instant) || instant > Date.parse(DEMO_NOW) || instant < Date.parse('2026-09-11T00:00:00+08:00'))) {
      throw new Error('完成时间需在今天开始后，且不能晚于现在。');
    }
    state.record.status = action; state.record.actual = action === 'completed' ? actual : ''; state.record.operator = '妈妈（我）';
  }
  state.record.version += 1;
  state.history.unshift({ action, operator: '妈妈（我）', actual, recordedAt: DEMO_NOW });
}
export function transferOwner(family, target) {
  if (family.owner !== 'me') throw new Error('只有家庭拥有人可以转交。');
  if (target === 'me' || !family.members.some((member) => member.id === target)) throw new Error('请选择其他有效真实成员。');
  family.owner = target;
}
export function exitMember(family, target) {
  if (target === family.owner) throw new Error('家庭拥有人需要先转交拥有权。');
  if (target !== 'me' && family.owner !== 'me') throw new Error('只有拥有人可以移除其他成员。');
  family.members = family.members.filter((member) => member.id !== target);
}
