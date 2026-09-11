import { createDemo, validateDraft, setViewer, transitionTask, recordAction, transferOwner, exitMember, DEMO_NOW } from './flow-model.mjs';

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let draft = createDemo().task;
let familyState = createDemo();
let records = createDemo();
let scene = 'editor';
let message = '';
const localTime = (value) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(11, 16);
let feedback = { conflict: false, latest: false, saved: false, failed: true };
const labels = { active: '进行中', paused: '已暂停', stopped: '已停止', deleted: '已删除', pending: '待完成', completed: '已完成', skipped: '已跳过', undo: '已撤销' };
const scenes = {
  editor: ['完整编辑', '安排这件事', '每一次，都安排清楚', ['示例为预填部分家人权限的待保存草稿，新建默认不勾选其他家人；可以每周选择多天，添加多个时刻。已过时刻会在新建预览中跳过。', '查看、代记和提醒分别选择。取消查看前确认影响；本人提醒默认开启，无时刻时保留设置。']],
  family: ['家庭与交接', '照应彼此的小家', '离开前，把照应交接好', ['家庭场景使用独立样例，不改变事项编辑与历史记录场景。创建新家庭会切换到新家庭样例。', '拥有人先转交，再单独确认退出。移除成员展示承接人及事项数量；这里的数量用于说明交互。']],
  invitation: ['邀请与加入', '邀请家人来', '由家人，主动加入', ['生成、撤销与接收方预览均为本地模拟；不会复制真实口令或发送消息。', '接收方填写家庭称呼、主动接受。重复接受不会增加成员；撤销后的邀请不能继续加入。']],
  records: ['记录与周期', '阅读 20 分钟', '这一次，与以后的每一次', ['独立历史样例：今天 08:00 的一次待记录安排，系列在今天之前已创建。不随编辑草稿改变。', '暂停保留此前未完成；继续不补暂停期间；停止后不能直接继续。完成、跳过和撤销都留下记录。']],
  recycle: ['删除与恢复', '回收的事项', '先保留，再决定', ['与记录场景联动。删除后从正常列表隐藏，历史留存；恢复周期为暂停状态。', '已停止系列恢复用于查看历史，不能继续；失效成员的权限不会恢复。']],
  feedback: ['冲突与重试', '把修改留住', '遇到变化，也不丢掉输入', ['模拟其他家人修改导致的版本冲突。保留本地备注、查看最新内容，再明确合并保存。', '批量结果逐项呈现，成功项退出选择；重试只处理失败项。真实请求需保留幂等标识。']],
};
const button = (label, action, primary = false) => `<button class="${primary ? 'primary-button' : 'outline-button'}" data-action="${action}">${label}</button>`;
const field = (label, id, value, type = 'text') => `<label class="field-label" for="${id}">${label}</label><input class="form-input" id="${id}" type="${type}" value="${escape(value)}">`;
function modal(title, html, confirmLabel, callback) {
  const triggerAction = document.activeElement?.dataset?.action;
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = `${html}<p id="dialog-error" class="flow-error" role="alert"></p><div class="sheet-actions">${button('取消', 'cancel')}${button(confirmLabel, 'confirm', true)}</div>`;
  $('#dialog-body [data-action=cancel]').onclick = () => $('#flow-dialog').close();
  $('#dialog-body [data-action=confirm]').onclick = () => {
    try { callback(); $('#flow-dialog').close(); render(); ($('#flow-screen [data-action="' + CSS.escape(triggerAction || '') + '"]') || $('#flow-nav [aria-current]')).focus(); } catch (error) { $('#dialog-error').textContent = error.message; }
  };
  $('#flow-dialog').showModal();
  ($('#dialog-body input') || $('#dialog-body [data-action=cancel]')).focus();
}
function confirm(title, copy, callback, label = '确认') { modal(title, `<p class="sheet-message">${copy}</p>`, label, callback); }
function notice(text) { return `<p class="flow-notice">${text}</p>`; }
function nextSlots() {
  if (validateDraft(draft)) return '请先补全有效日期与时刻。';
  if (!draft.start) return '未安排日期 · 保留在未安排列表';
  const results = [];
  const previewStart = draft.repeat === 'once' ? draft.start : draft.start < '2026-09-11' ? '2026-09-11' : draft.start;
  for (let offset = 0; offset < 366 && results.length < 3; offset += 1) {
    const date = new Date(`${previewStart}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + offset);
    const localDate = new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay() || 7;
    if (draft.end && localDate > draft.end) break;
    if (draft.repeat === 'once' && offset > 0) break;
    if (draft.repeat === 'weekly' && !draft.weekdays.includes(weekday)) continue;
    for (const time of draft.times.length ? [...draft.times].sort() : ['']) {
      if (draft.repeat !== 'once' && (time ? Date.parse(`${localDate}T${time}:00+08:00`) <= Date.parse(DEMO_NOW) : localDate < '2026-09-11')) continue;
      results.push(`${localDate} ${time || '当天安排'}`);
      if (results.length === 3) break;
    }
  }
  return results.length ? results.join('<br>') : '预览窗口内没有有效安排，请检查起止日期。';
}
function editor() {
  const selected = (value, current) => value === current ? 'selected' : '';
  const options = (items, current) => items.map(([value, name]) => `<option value="${value}" ${selected(value, current)}>${name}</option>`).join('');
  return `<div class="flow-card">${field('事项名称', 'task-title', draft.title)}<label class="field-label" for="task-note">备注</label><textarea class="form-input" id="task-note" rows="3">${escape(draft.note)}</textarea></div>
  <div class="flow-card"><label class="field-label" for="task-family">所属家庭</label><select id="task-family" class="form-select">${options([['mine', '我的小家'], ['personal', '个人事项']], draft.family)}</select><label class="field-label" for="task-subject">执行对象</label><select id="task-subject" class="form-select">${options(draft.family === 'personal' ? [['me', '自己']] : [['me', '自己'], ['child', '小宝 · 无账号成员'], ['dad', '爸爸'], ['gran', '奶奶']], draft.subject)}</select>${notice(draft.subject === 'child' ? '小宝负责做，由家庭拥有人妈妈管理。' : '普通事项由创建者管理；执行人需要查看权限。')}</div>
  <div class="flow-card"><label class="field-label" for="task-repeat">重复安排</label><select id="task-repeat" class="form-select">${options([['once', '不重复'], ['daily', '每天'], ['weekly', '每周']], draft.repeat)}</select><div class="two-fields"> <div>${field('开始 / 计划日期', 'task-start', draft.start, 'date')}</div><div>${field('结束日期（可选）', 'task-end', draft.end, 'date')}</div></div>
  ${draft.repeat === 'weekly' ? `<p class="field-label">每周这些天</p><div class="weekdays">${['一', '二', '三', '四', '五', '六', '日'].map((day, i) => `<label><input type="checkbox" data-day="${i + 1}" ${draft.weekdays.includes(i + 1) ? 'checked' : ''}>周${day}</label>`).join('')}</div>` : ''}
  <p class="field-label">具体时刻</p>${draft.times.map((time, i) => `<div class="time-row"><input class="form-input" aria-label="第 ${i + 1} 个时刻" type="time" data-time="${i}" value="${escape(time)}"><button data-remove-time="${i}" aria-label="删除第 ${i + 1} 个时刻">×</button></div>`).join('')}${button('＋ 添加时刻', 'add-time')}<p class="form-helper">不填时刻即当天安排；一次性最多 1 个，周期每天最多 6 个。</p></div>
  <div class="flow-card"><h3>谁一起照应</h3><label class="flow-choice"><input type="checkbox" id="remind-me" ${draft.remindMe ? 'checked' : ''}>提醒我 · 小程序内</label><p class="form-helper">${draft.remindMe ? draft.times.length ? '按具体时刻展示到时提示' : '已开启 · 待设置时刻' : '我的提醒未开启'}</p>${draft.family === 'mine' ? `<div class="permission-row header"><span>家人</span><span>查看</span><span>代记</span><span>提醒</span></div>${[['dad', '爸爸'], ['gran', '奶奶']].map(([id, name]) => `<div class="permission-row"><span>${name}${draft.subject === id ? ' · 执行人' : ''}</span>${['viewers', 'helpers', 'reminders'].map((key, i) => `<label><input type="checkbox" data-member="${id}" data-permission="${key}" aria-label="${name}${['可查看', '可代记', '接收提醒'][i]}" ${draft[key].includes(id) ? 'checked' : ''} ${key === 'viewers' && draft.subject === id ? 'disabled' : ''}></label>`).join('')}</div>`).join('')}<p class="form-helper">妈妈作为创建者始终可查看、管理和记录；执行人本人可记录，查看权限不可取消。</p>` : notice('个人事项仅自己可见。')}</div><div class="flow-card"><h3>下一次安排</h3><p id="schedule-preview">${nextSlots()}</p><p class="form-helper">本地预览最多向后查看一年；正式接口按日程有效期计算。</p></div><p id="editor-error" class="flow-error" role="alert"></p>`;
}
function family() {
  const f = familyState.family; const isMember = f.members.some((member) => member.id === 'me'); const owner = f.owner === 'me';
  return `<div class="flow-card"><h3>${escape(f.name)}</h3><p>拥有人 · ${escape(f.members.find((member) => member.id === f.owner)?.name || '')}</p>${owner ? button('修改家庭名称', 'rename-family') : ''}</div>${!isMember ? notice('你已退出这个家庭。个人事项及其他家庭不受影响。') : `<h3 class="flow-section-title">家人 · ${f.members.length} 位</h3>${f.members.map((member) => `<div class="flow-card"><h3>${escape(member.name)}</h3><p>${member.id === f.owner ? '家庭拥有人' : '真实成员'}</p><div class="flow-inline-actions">${owner || member.id === 'me' ? button('修改称呼', `rename-${member.id}`) : ''}${owner && member.id !== 'me' ? button('移除成员', `remove-${member.id}`) : ''}</div></div>`).join('')}${f.virtualMembers.length ? f.virtualMembers.map((member) => `<div class="flow-card"><h3>${escape(member.name)} · 无账号成员</h3><p>${member.active ? '由当前家庭拥有人管理' : '已停用 · 历史保留'}</p>${owner ? `<div class="flow-inline-actions">${button('修改称呼', `virtual-rename-${member.id}`)}${member.active ? button('停用', `virtual-deactivate-${member.id}`) : ''}</div>` : ''}</div>`).join('') : notice('还没有无账号成员，可为没有账号的家人添加称呼。')}${owner ? `<div class="flow-inline-actions">${button('添加无账号成员', 'add-virtual')}${button('转交拥有权', 'transfer')}</div>` : ''}${button('退出这个家庭', 'exit')}`}${button('创建另一个家庭', 'create-family')}`;
}
function invitation() {
  const status = familyState.invitation; const f = familyState.family;
  return `<div class="flow-card"><h3>${escape(f.name)}</h3><span class="flow-status">${status === 'active' ? '邀请有效 · 9 月 18 日到期' : '邀请已撤销'}</span><p>邀请人：妈妈。这是本地邀请示例。</p>${f.owner === 'me' ? `<div class="flow-inline-actions">${button('生成新邀请', 'new-invite')}${status === 'active' ? button('撤销邀请', 'revoke-invite') : ''}</div>` : notice('当前妈妈已不是拥有人，不能管理邀请。')}</div><h3 class="flow-section-title">接收方视角</h3><div class="flow-card">${familyState.joined ? `<h3>你已加入这个家庭</h3><p>重复接受不会再次添加成员。</p>${button('再次接受邀请', 'accept-invite')}` : status !== 'active' ? '<h3>这个邀请暂时不可用</h3><p>请联系家人重新发出邀请。</p>' : `<h3>一起照应日常的小事</h3><p>妈妈邀请你加入「${escape(f.name)}」。接受后成为普通成员。</p>${field('在家里的称呼', 'invite-name', '爷爷')}${button('接受邀请并加入', 'accept-invite', true)}`}</div>`;
}
function recordScreen() {
  const t = records.task; const r = records.record;
  if (t.lifecycle === 'deleted') return `<div class="state-box"><h4>事项已放入回收</h4><p>历史和权限会在恢复时重新检查。</p>${button('去回收查看', 'go-recycle')}</div>`;
  return `<div class="flow-card"><h3>阅读 20 分钟</h3><p>我的小家 · 小宝 · 9 月 11 日 08:00</p><span class="flow-status">整个周期：${labels[t.lifecycle]}</span></div><h3 class="flow-section-title">这一次</h3><div class="flow-card"><h3>${labels[r.status]}</h3><p>${r.status === 'completed' ? `实际完成：${localTime(r.actual)} 上海时间<br>由妈妈记录 · 记录于 18:30` : r.status === 'skipped' ? '本次不计入应做分母；下一次不变。' : '可以补记今天的实际完成时间。'}</p><div class="flow-inline-actions">${r.status === 'pending' ? `${button('现在完成', 'complete', true)}${button('补记时间', 'backfill')}${button('跳过这次', 'skip')}` : button('撤销本次记录', 'undo')}</div></div><h3 class="flow-section-title">整个周期</h3><div class="flow-card"><p>此前应做和历史保留；暂停期间不补出新记录。</p><div class="flow-inline-actions">${t.lifecycle === 'active' ? button('暂停周期', 'pause') : ''}${t.lifecycle === 'paused' && !t.stoppedBeforeDelete ? button('继续周期', 'resume') : ''}${['active', 'paused'].includes(t.lifecycle) && !t.stoppedBeforeDelete ? button('停止后续', 'stop') : ''}${button('删除整个事项', 'delete')}</div>${t.stoppedBeforeDelete ? notice('本系列曾经停止，仅保留历史，不能继续。') : ''}</div><h3 class="flow-section-title">留下的记录</h3>${records.history.length ? records.history.map((event) => `<div class="flow-event">${labels[event.action] || event.action} · ${event.operator}<small>记录于 9 月 11 日 18:30${event.actual ? ` · 实际 ${localTime(event.actual)}` : ''}</small></div>`).join('') : '<p class="flow-quiet">还没有操作记录。</p>'}`;
}
function recycle() { return records.task.lifecycle === 'deleted' ? `<div class="flow-card"><h3>阅读 20 分钟</h3><p>我的小家 · 小宝<br>整个系列已删除，历史保留。</p>${notice(records.task.stoppedBeforeDelete ? '已停止系列恢复后仅可查历史。' : '恢复后为暂停状态，可另行选择继续。')}${button('恢复事项', 'restore', true)}</div>` : `<div class="state-box"><h4>暂时没有删除的事项</h4><p>可以到记录场景体验删除与恢复。</p>${button('查看记录与周期', 'go-records')}</div>`; }
function feedbackScreen() { return `<div class="flow-card"><h3>草稿还在</h3>${field('我的备注草稿', 'conflict-draft', feedback.draft ?? '读完后聊聊喜欢的角色。')}${feedback.conflict ? notice('家人刚刚更新了这件事。你的输入已保留，请查看最新内容。') : ''}${feedback.latest ? notice('最新标题：阅读并分享故事<br>最新备注：记得把书放回去。<br>合并将采用最新标题和你的备注。') : ''}${button(feedback.saved ? '再次编辑并保存' : '模拟保存', 'conflict-save', true)}${feedback.conflict ? button('查看最新内容', 'load-latest') : ''}${feedback.latest ? button('保留我的备注并合并', 'merge') : ''}</div><div class="flow-card"><h3>批量增加可见人</h3><p>买水果 · 已成功加入爸爸，已退出选择</p><p id="batch-result">${feedback.failed ? '阅读记录 · 未成功，网络暂时不可用' : '阅读记录 · 重试成功，已加入爸爸'}</p>${feedback.failed ? button('只重试失败的 1 项', 'retry-batch') : notice('2 项均已成功；未新增代记和提醒权限。')}</div>`; }
function render() {
  const [caption, title, noteTitle, notes] = scenes[scene];
  $('#scene-caption').textContent = caption; $('#screen-title').textContent = title; $('#note-title').textContent = noteTitle;
  $('#scene-notes').innerHTML = notes.map((text) => `<p>${text}</p>`).join('');
  $('#flow-nav').innerHTML = Object.entries(scenes).map(([id, data], index) => `<button data-scene="${id}" class="${scene === id ? 'active' : ''}" ${scene === id ? 'aria-current="page"' : ''}>0${index + 1} · ${data[0]}</button>`).join('');
  $('#flow-screen').innerHTML = ({ editor, family, invitation, records: recordScreen, recycle, feedback: feedbackScreen })[scene]();
  $('#flow-actions').innerHTML = `<div class="flow-actions">${message ? `<p class="flow-success" role="status">${escape(message)}</p>` : ''}${scene === 'editor' ? button('保存这份安排', 'save', true) : '<p class="flow-quiet">本地交互样例 · 刷新可重置</p>'}</div>`;
}
function rename(title, initial, callback, limit = 12) { modal(title, field('名称', 'new-name', initial), '保存', () => { const value = $('#new-name').value.trim(); if (!value || [...value].length > limit) throw new Error(`请填写 1–${limit} 个字。`); callback(value); message = '已保存。'; }); }
function action(name) {
  message = '';
  const f = familyState.family;
  if (name === 'add-time') { if (draft.times.length >= (draft.repeat === 'once' ? 1 : 6)) { message = '已达到时刻数量上限。'; } else draft.times.push(''); }
  else if (name === 'save') { const error = validateDraft(draft); if (error) { $('#editor-error').textContent = error; $('#editor-error').scrollIntoView({ block: 'nearest' }); return; } message = '安排已保存到本地演示，刷新后重置。'; }
  else if (name === 'rename-family') return rename('修改家庭名称', f.name, (value) => { f.name = value; }, 24);
  else if (name.startsWith('virtual-rename-')) { const member = f.virtualMembers.find((item) => item.id === name.slice(15)); return rename('修改无账号成员称呼', member.name, (value) => { member.name = value; }); }
  else if (name.startsWith('virtual-deactivate-')) { const member = f.virtualMembers.find((item) => item.id === name.slice(19)); return confirm('停用这位无账号成员？', '历史记录保留，未结束事项继续由拥有人管理；新事项不能再选此成员。', () => { member.active = false; }); }
  else if (name.startsWith('rename-')) { const member = f.members.find((item) => item.id === name.slice(7)); return rename('修改家里称呼', member.name, (value) => { member.name = value; }); }
  else if (name === 'create-family') return modal('创建另一个家庭', field('家庭名称', 'new-family', '') + field('我在家里的称呼', 'my-name', '妈妈'), '创建家庭', () => { const value = $('#new-family').value.trim(); const myName = $('#my-name').value.trim(); if (!value || [...value].length > 24 || !myName || [...myName].length > 12) throw new Error('家庭名称 1–24 个字，称呼 1–12 个字。'); f.name = value; f.owner = 'me'; f.members = [{ id: 'me', name: myName }]; f.virtualMembers = []; familyState.invitation = 'revoked'; familyState.joined = false; message = '新家庭已创建，可以继续邀请家人。'; });
  else if (name === 'add-virtual') return rename('添加无账号成员', '', (value) => { f.virtualMembers.push({ id: `virtual-${f.virtualMembers.length + 1}`, name: value, active: true }); });
  else if (name === 'transfer') { const targets = f.members.filter((item) => item.id !== 'me'); if (!targets.length) return confirm('还没有可承接的家人', '先邀请另一位真实成员加入，再转交拥有权。', () => { scene = 'invitation'; }, '查看邀请'); return modal('转交家庭拥有权', `<p class="sheet-message">2 个虚拟人事项的管理归属随之转交，历史记录不变。转交后你仍在家庭中。</p><label class="field-label" for="successor">承接人</label><select id="successor" class="form-select">${targets.map((item) => `<option value="${item.id}">${escape(item.name)}</option>`).join('')}</select>`, '确认转交', () => { transferOwner(f, $('#successor').value); message = '拥有权已转交；退出需要另行确认。'; }); }
  else if (name === 'exit' || name.startsWith('remove-')) { const target = name === 'exit' ? 'me' : name.slice(7); if (target === f.owner) return action('transfer'); const successor = f.members.find((item) => item.id === f.owner); return confirm(name === 'exit' ? '确认退出这个家庭？' : '确认移除这位家人？', `将 3 项普通事项（含 1 项仅本人可见）及 2 项创建管理职责交给${escape(successor.name)}。历史记录保留；个人及其他家庭不受影响。以上为演示计数。`, () => { exitMember(f, target); message = name === 'exit' ? '已退出这个家庭。' : '已移除成员，职责已交接。'; }); }
  else if (name === 'new-invite') { familyState.invitation = 'active'; message = '新的本地邀请已生成，有效期 7 天。'; }
  else if (name === 'revoke-invite') return confirm('撤销这份邀请？', '已加入的成员不受影响；其他人不能再通过它加入。', () => { familyState.invitation = 'revoked'; });
  else if (name === 'accept-invite') { if (familyState.joined) message = '你已加入，无需重复添加。'; else { const value = $('#invite-name').value.trim(); if (!value || [...value].length > 12) { message = '请填写 1–12 个字的家庭称呼。'; } else { f.members.push({ id: 'guest', name: value }); familyState.joined = true; message = '已加入，可到家庭场景查看新成员。'; } } }
  else if (name === 'complete') recordAction(records, 'completed', DEMO_NOW);
  else if (name === 'undo') return confirm('撤销本次记录？', '这次恢复为待完成，原记录仍保留在历史中。', () => recordAction(records, 'undo'));
  else if (name === 'skip') return confirm('跳过这一次？', '本次不算完成，也不进入应做分母；下一次安排不变。', () => recordAction(records, 'skipped'));
  else if (name === 'backfill') return modal('补记实际完成时间', field('今天的完成时间', 'actual-time', '18:00', 'time') + notice('不能晚于演示当前时间 18:30；系统记录时间单独保留。'), '保存记录', () => recordAction(records, 'completed', `2026-09-11T${$('#actual-time').value}:00+08:00`));
  else if (['pause', 'resume', 'stop', 'delete', 'restore'].includes(name)) { const copy = { pause: ['暂停整个周期？', '此前应做和历史继续保留；暂停期间不产生应做记录。'], resume: ['继续以后的安排？', '下一次：9 月 11 日 19:00。只继续未来，不补暂停期间。'], stop: ['停止后续安排？', '历史和此前未完成保留；此系列不能直接继续，需要另建事项。'], delete: ['删除整个事项？', '整个系列、历史和提醒将从正常页面隐藏。可以从回收恢复。'], restore: ['恢复这个事项？', '历史及仍有效的权限保留，周期以暂停状态恢复；已失效成员不会恢复。'] }[name]; return confirm(...copy, () => { transitionTask(records.task, name); records.history.unshift({ action: ({ pause: '暂停周期', resume: '继续周期', stop: '停止后续', delete: '删除事项', restore: '恢复事项' })[name], operator: '妈妈', actual: '' }); message = name === 'restore' ? '已恢复为暂停状态，可到记录场景查看。' : '状态已更新。'; }); }
  else if (name === 'go-recycle') scene = 'recycle';
  else if (name === 'go-records') scene = 'records';
  else if (name === 'conflict-save') { feedback.draft = $('#conflict-draft').value; feedback.conflict = true; feedback.saved = false; }
  else if (name === 'load-latest') { feedback.draft = $('#conflict-draft').value; feedback.latest = true; }
  else if (name === 'merge') { feedback.draft = $('#conflict-draft').value; feedback.conflict = false; feedback.latest = false; feedback.saved = true; message = '已合并：采用最新标题并保留你的备注。'; }
  else if (name === 'retry-batch') { feedback.draft = $('#conflict-draft').value; feedback.failed = false; message = '只重试了失败的 1 项。'; }
  render();
}
document.addEventListener('click', (event) => {
  const target = event.target.closest('button'); if (!target || target.closest('dialog')) return;
  if (target.dataset.scene) { if (scene === 'feedback') feedback.draft = $('#conflict-draft').value; scene = target.dataset.scene; message = ''; render(); $('#flow-screen').scrollTop = 0; }
  else if (target.dataset.removeTime !== undefined) { draft.times.splice(Number(target.dataset.removeTime), 1); render(); }
  else if (target.dataset.action) { try { action(target.dataset.action); } catch (error) { message = error.message; render(); } }
});
document.addEventListener('input', (event) => {
  const target = event.target;
  const fields = { 'task-title': 'title', 'task-note': 'note', 'task-start': 'start', 'task-end': 'end' };
  if (fields[target.id]) draft[fields[target.id]] = target.value;
  if (target.dataset.time !== undefined) draft.times[Number(target.dataset.time)] = target.value;
  if (scene === 'editor' && $('#schedule-preview')) $('#schedule-preview').innerHTML = nextSlots();
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'task-family') { draft.family = target.value; draft.subject = 'me'; draft.viewers = []; draft.helpers = []; draft.reminders = []; message = '已清空之前的成员选择。'; }
  else if (target.id === 'task-subject') { draft.subject = target.value; if (['dad', 'gran'].includes(draft.subject)) setViewer(draft, draft.subject, true); }
  else if (target.id === 'task-repeat') { draft.repeat = target.value; if (draft.repeat === 'once') { draft.times = draft.times.slice(0, 1); draft.end = ''; } }
  else if (target.id === 'remind-me') draft.remindMe = target.checked;
  else if (target.dataset.day) { const day = Number(target.dataset.day); draft.weekdays = target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((item) => item !== day); }
  else if (target.dataset.permission) { const id = target.dataset.member; const key = target.dataset.permission; const checked = target.checked;
    if (key === 'viewers') { if (!checked && (draft.helpers.includes(id) || draft.reminders.includes(id))) { target.checked = true; return confirm('取消查看权限？', '同时取消这位家人的代记与提醒权限。取消确认会保留原设置。', () => setViewer(draft, id, false), '一并取消'); } setViewer(draft, id, checked); }
    else if (checked && !draft.viewers.includes(id)) { message = '请先授予查看权限。'; }
    else draft[key] = checked ? [...new Set([...draft[key], id])] : draft[key].filter((item) => item !== id);
  } else return;
  render();
});
$('#dialog-close').onclick = () => $('#flow-dialog').close();
$('#flow-reset').onclick = () => { draft = createDemo().task; familyState = createDemo(); records = createDemo(); feedback = { conflict: false, latest: false, saved: false, failed: true }; message = '所有演示数据已重置。'; render(); };
render();
