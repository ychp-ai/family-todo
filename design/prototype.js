// Isolated design prototype. All records are fictional and reset on reload.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = '') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const families = { personal: '个人', mine: '我的小家', parents: '爸妈家' };
const people = { self: { name: '我', mark: '我', tone: 'lavender' }, child: { name: '小宝', mark: '宝', tone: 'peach' }, dad: { name: '爸爸', mark: '爸', tone: 'mint' }, mom: { name: '妈妈', mark: '妈', tone: 'rose' }, grandma: { name: '奶奶', mark: '奶', tone: 'rose' } };
const initialTasks = [
  { id: 'milk', title: '买牛奶和鸡蛋', family: 'personal', person: 'self', date: 'today', time: '18:00', done: false, group: 'self', manage: true, canComplete: true, reminder: true },
  { id: 'coat', title: '取回干洗的外套', family: 'personal', person: 'self', date: 'today', time: '', done: false, group: 'self', manage: true, canComplete: true, reminder: true },
  { id: 'walk', title: '晚饭后散步 20 分钟', family: 'parents', person: 'dad', date: 'today', time: '18:00', done: false, group: 'help', repeat: true, manage: true, canComplete: true, reminder: true, visible: ['爸爸', '妈妈'] },
  { id: 'read', title: '阅读 20 分钟', family: 'mine', person: 'child', date: 'today', time: '16:00', done: true, group: 'help', repeat: true, manage: true, canComplete: true, reminder: true, operator: '奶奶', completedAt: '16:24', visible: ['爸爸', '奶奶'], helpers: ['爸爸', '奶奶'], note: '读完后，可以和家人说说今天最喜欢的故事。' },
  { id: 'bag', title: '整理明天的书包', family: 'mine', person: 'child', date: 'today', time: '19:30', done: false, group: 'help', repeat: true, manage: true, canComplete: true, reminder: true, visible: ['爸爸', '奶奶'], helpers: ['爸爸', '奶奶'] },
  { id: 'plants', title: '给阳台的花浇水', family: 'parents', person: 'mom', date: 'today', time: '', done: false, group: 'view', manage: false, canComplete: false, visible: ['我'] },
  { id: 'toys', title: '收好玩具', family: 'mine', person: 'child', date: 'today', time: '', done: true, group: 'help', manage: true, canComplete: true, reminder: true, operator: '奶奶', completedAt: '15:40', visible: ['爸爸', '奶奶'], helpers: ['爸爸', '奶奶'] },
  { id: 'photos', title: '整理旅行照片', family: 'personal', person: 'self', date: '2026-09-10', time: '', done: false, group: 'self', manage: true, canComplete: true, reminder: true }
];
let tasks = structuredClone(initialTasks);
let currentDate = 'today';
let currentFamily = 'all';
let progressFamily = 'mine';
let currentTaskId = 'read';
let hideCompleted = false;
let batchMode = false;
let selected = new Set();
let demoState = 'ready';
let dismissedReminders = new Set();
let extraMembers = [];
const sheet = $('#sheet');
const avatar = (person, name) => `<span class="avatar ${people[person].tone}" aria-hidden="true">${escape(name || people[person].mark)}</span>`;
const dateLabel = (date) => ({ today: '今天 · 9 月 11 日', tomorrow: '明天 · 9 月 12 日', unscheduled: '未安排' })[date] || date;
const isDue = (task) => task.reminder && !task.done && !task.skipped && task.date === 'today' && Boolean(task.time) && task.time <= '18:30';
const dueTasks = () => tasks.filter(isDue);
const toastTimers = new Map();
function toast(message, target = 'home') {
  const element = $(`#${target}-toast`);
  clearTimeout(toastTimers.get(target));
  element.textContent = message;
  element.classList.add('visible');
  toastTimers.set(target, setTimeout(() => element.classList.remove('visible'), 2600));
}
function openSheet(title, body, initialize) {
  if (sheet.open) sheet.close();
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = body;
  sheet.showModal();
  initialize?.();
}
$('#sheet-close').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (event) => {
  if (event.target !== sheet) return;
  const rect = sheet.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) sheet.close();
});
function taskCard(task) {
  let action;
  if (batchMode) {
    action = task.manage ? `<button class="check-button" data-select="${task.id}" aria-label="选择${escape(task.title)}" aria-pressed="${selected.has(task.id)}"><span class="check-circle">${selected.has(task.id) ? icon('check') : ''}</span></button>` : '<span class="check-button"><span class="readonly-badge">不可<br>多选</span></span>';
  } else {
    action = task.canComplete ? `<button class="check-button" data-complete="${task.id}" aria-label="${task.done ? '撤销完成' : '完成'}：${escape(task.title)}" aria-pressed="${task.done}"><span class="check-circle">${task.done ? icon('check') : ''}</span></button>` : '<span class="check-button"><span class="readonly-badge">仅可<br>查看</span></span>';
  }
  return `<article class="task-card ${task.done ? 'is-done' : ''} ${selected.has(task.id) ? 'selected' : ''}">${action}<button class="task-main" data-detail="${task.id}"><strong>${escape(task.title)}</strong><span class="task-meta"><span class="house-tag ${task.family === 'personal' ? 'personal' : ''}">${families[task.family]}</span>${task.person !== 'self' ? `<span>${people[task.person].name}</span><span>·</span>` : ''}<span>${task.time || '不限定时刻'}</span>${task.repeat ? icon('repeat') : ''}</span>${task.done ? `<span class="record-note">${task.person === 'self' ? '自己记录完成' : `${people[task.person].name}已完成 · ${escape(task.operator)}记录`}</span>` : ''}</button></article>`;
}
function renderHome() {
  const list = $('#task-list');
  const visible = tasks.filter((task) => task.date === currentDate && (currentFamily === 'all' || task.family === currentFamily));
  const finished = visible.filter((task) => task.done).length;
  $('#summary-text').textContent = demoState === 'partial' ? '数据未完整加载 · 暂不汇总' : demoState === 'ready' ? `已完成 ${finished} / ${visible.length} 件` : '—';
  $('#day-progress').style.width = demoState === 'ready' && visible.length ? `${finished / visible.length * 100}%` : '0%';
  $('#reminder-count').textContent = dueTasks().filter((task) => !dismissedReminders.has(task.id)).length;
  const backlog = tasks.filter((task) => task.date === '2026-09-10' && !task.done && (currentFamily === 'all' || task.family === currentFamily));
  $('#backlog-open').hidden = currentDate !== 'today' || demoState !== 'ready' || !backlog.length;
  $('#backlog-open span').textContent = `之前还有 ${backlog.length} 件未完成`;
  $('#completed-toggle').textContent = hideCompleted ? '显示已完成' : '隐藏已完成';
  $('#completed-toggle').setAttribute('aria-pressed', String(hideCompleted));
  $('#batch-toggle').textContent = batchMode ? '取消多选' : '多选';
  $('#quick-add').innerHTML = batchMode ? `增加可见人${selected.size ? ` · ${selected.size} 项` : ''}` : `${icon('plus')}记一件事`;
  $('#quick-add').disabled = batchMode && selected.size === 0;
  if (demoState === 'loading') { list.innerHTML = '<div role="status" aria-label="正在加载事项"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><p class="end-note">正在加载事项…</p></div>'; return; }
  if (demoState === 'error') { list.innerHTML = `<div class="state-box">${icon('repeat')}<h4>事项暂时没有加载出来</h4><p>请检查网络后重试，已保存的事项不会丢失。</p><button class="outline-button" data-retry>重新加载</button></div>`; return; }
  if (demoState === 'empty' || !visible.length) { list.innerHTML = `<div class="state-box">${icon('calendar')}<h4>${currentDate === 'tomorrow' ? '给明天留个小安排' : '这里还没有安排'}</h4><p>从一件小事开始，<br>只填标题也能记下来。</p><button class="outline-button" data-add>记一件事</button></div>`; return; }
  const groupNames = { self: '我来做', help: '帮家人', view: '关心一下' };
  list.innerHTML = (demoState === 'partial' ? '<div class="partial-warning">爸妈家的事项暂未加载，以下仅展示已加载内容。<button data-retry>重试</button></div>' : '') + (batchMode ? '<p class="batch-help">选择有管理权限的事项，按所属家庭增加可见人。</p>' : '') + Object.entries(groupNames).map(([key, label]) => {
    const items = visible.filter((task) => task.group === key && (!hideCompleted || !task.done) && (demoState !== 'partial' || task.family !== 'parents'));
    return items.length ? `<section class="task-group"><h4 class="group-label">${label}<span>${items.length}</span></h4>${items.map(taskCard).join('')}</section>` : '';
  }).join('');
  if (hideCompleted && visible.every((task) => task.done)) list.innerHTML += '<div class="state-box"><h4>这一页的事情都完成了</h4><p>点击“显示已完成”回看记录。</p></div>';
}
function renderDetail() {
  const task = tasks.find((item) => item.id === currentTaskId);
  const person = people[task.person];
  const visibility = task.visible?.length ? [...new Set(['我', ...task.visible])].join('、') : '仅自己可见';
  const viewerAvatars = task.visible?.length ? `<span class="avatar-stack">${avatar('self')}${task.visible.filter((name) => name !== '我').map((name) => avatar(Object.keys(people).find((key) => people[key].name === name) || 'self')).join('')}</span>` : icon('lock', 'tiny');
  const helpers = task.person === 'self' ? '仅自己' : task.canComplete ? ['妈妈（我）', ...(task.helpers || [])].join('、') : '你暂无代记权限';
  const isChild = task.person === 'child';
  const history = task.id === 'read' ? `<div class="section-title"><h4>每一次的小进步</h4><span>每天独立记录</span></div><div class="history-list"><div class="history-item"><time>${task.done ? escape(task.completedAt) : '待记录'}</time><strong>今天 · ${task.done ? '已完成' : '待完成'}</strong><p>${task.done ? `${escape(task.operator)}记录 · 小宝读完了今天的故事` : '今天尚未确认完成'}</p></div><div class="history-item"><time>16:35</time><strong>昨天 · 已完成</strong><p>奶奶记录 · 一起读了《小王子》</p></div><div class="history-item"><time>16:18</time><strong>9 月 9 日 · 已完成</strong><p>妈妈记录</p></div></div>` : `<div class="section-title"><h4>本次记录</h4></div><div class="history-list"><div class="history-item"><strong>${task.done ? `${escape(task.operator)}记录完成` : '尚未确认完成'}</strong><p>${task.done ? `实际完成：今天 ${escape(task.completedAt)} · 记录时间：今天 18:30` : '完成后，会在这里留下记录人和时间。'}</p></div></div>`;
  $('#detail-content').innerHTML = `<div class="detail-family">${icon(task.family === 'personal' ? 'lock' : 'home')}${families[task.family]}<span> / </span>${person.name}</div><h3 class="detail-title">${escape(task.title)}</h3><p class="detail-subtitle">${icon(task.repeat ? 'repeat' : 'calendar')}${task.repeat ? '每天' : dateLabel(task.date)}${task.time ? ` · ${task.time}` : ' · 不限定时刻'}</p><div class="completion-card ${task.done ? '' : 'pending'}"><span class="completion-badge">${icon(task.done ? 'check' : 'clock')}</span><div class="completion-copy"><strong>${person.name === '我' ? '' : person.name}${task.done ? '已完成' : '待完成'}</strong><p>${task.done ? `由${escape(task.operator)}记录 · 今天 ${escape(task.completedAt)}` : '没有记录，不代表没有完成'}</p></div></div><div class="section-title"><h4>这件事的安排</h4><span>${task.repeat ? '当前这一次' : '一次性事项'}</span></div><div class="detail-info"><div class="info-row"><span class="info-label">谁来做</span><span class="info-value">${avatar(task.person)}${person.name}${isChild ? '<span class="micro-tag">无账号成员</span>' : ''}</span></div><div class="info-row"><span class="info-label">谁可以看</span><span class="info-value">${viewerAvatars}${escape(visibility)}</span></div><div class="info-row"><span class="info-label">可代记家人</span><span class="info-value">${escape(helpers)}</span></div><div class="info-row"><span class="info-label">小程序内提醒</span><span class="info-value">${task.reminder ? task.time ? '我 · 到时提醒' : '已开启 · 待设置时刻' : '未开启'}</span></div></div>${task.note ? `<p class="detail-note">${escape(task.note)}</p>` : ''}${history}`;
  $('#detail-actions').innerHTML = `<div class="detail-buttons"><button class="outline-button" id="detail-more">${task.manage ? '事项设置' : '查看权限'}</button>${task.canComplete ? `<button class="primary-button ${task.done ? 'quiet-button' : ''}" id="detail-complete">${icon(task.done ? 'repeat' : 'check')}${task.done ? '撤销本次完成' : task.person === 'self' ? '完成本次' : '代记本次完成'}</button>` : '<span class="outline-button">仅可查看</span>'}</div><span class="home-indicator"></span>`;
  $('#detail-complete')?.addEventListener('click', () => toggleComplete(task.id, 'detail'));
  $('#detail-more').addEventListener('click', () => showSettings(task));
}
function renderFamily() {
  const mine = progressFamily === 'mine';
  $('#family-card-label').textContent = mine ? '在一起的每一天' : '隔着距离，也惦记着';
  $('#family-card-title').textContent = mine ? '小家里的大牵挂' : '爸妈的日常，放心上';
  $('#family-card-members').textContent = mine ? `${4 + extraMembers.length} 位家人 · ${1 + extraMembers.length} 位无账号成员` : '3 位家人';
  $('.family-portrait').innerHTML = mine ? '<span class="portrait lavender">妈</span><span class="portrait mint">爸</span><span class="portrait peach">宝</span><span class="portrait rose">奶</span>' : '<span class="portrait mint">爸</span><span class="portrait rose">妈</span><span class="portrait lavender">我</span>';
  const members = mine ? ['child', 'dad', 'grandma', 'self'] : ['dad', 'mom', 'self'];
  $('#member-list').innerHTML = members.map((id) => {
    const memberTasks = tasks.filter((task) => task.person === id && task.family === progressFamily && task.date === 'today');
    const complete = memberTasks.filter((task) => task.done).length;
    return `<button class="member-card" data-member="${id}">${avatar(id)}<span class="member-copy"><span class="member-name">${people[id].name}${id === 'child' ? '<span class="micro-tag">家人代记</span>' : id === 'self' && mine ? '<span class="micro-tag">家庭拥有人</span>' : ''}</span><p>${memberTasks.length ? `${complete} 件已完成 · ${memberTasks.length - complete} 件待完成` : '暂无共享给你的今日安排'}</p></span>${memberTasks.length ? `<span class="member-meter" style="--meter:${complete / memberTasks.length * 100}"><svg viewBox="0 0 36 36"><circle class="meter-track" cx="18" cy="18" r="15.5"/><circle class="meter-fill" cx="18" cy="18" r="15.5" pathLength="100"/></svg><span>${complete}/${memberTasks.length}</span></span>` : ''}${icon('chevron', 'chevron')}</button>`;
  }).join('') + (mine ? extraMembers.map((name) => `<div class="member-card">${avatar('child', name.slice(0, 1))}<span class="member-copy"><span class="member-name">${escape(name)}<span class="micro-tag">家人代记</span></span><p>还没有安排事项</p></span></div>`).join('') : '');
  $('#invite-family').textContent = mine ? '＋ 邀请家人一起记' : '查看家庭成员';
}
function renderAll() { renderHome(); renderDetail(); renderFamily(); }
function toggleComplete(id, target = 'home') {
  const task = tasks.find((item) => item.id === id);
  if (!task.canComplete) return;
  if (!task.done && task.repeat && task.date !== 'today') return toast('未来周期次数尚不能提前完成', target);
  task.done = !task.done;
  if (task.done) { task.operator = '妈妈（我）'; task.completedAt = '18:30'; }
  renderAll();
  toast(task.done ? `${task.person === 'self' ? '已完成' : `已为${people[task.person].name}记录完成`}，可撤销` : '已撤销本次完成', target);
}
function showTask(id) {
  currentTaskId = id;
  sheet.close();
  renderDetail();
  $('#detail-content').scrollTop = 0;
  $('#detail-artboard').scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
$('#task-list').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.complete) toggleComplete(button.dataset.complete);
  if (button.dataset.detail) showTask(button.dataset.detail);
  if (button.dataset.select) { const id = button.dataset.select; selected.has(id) ? selected.delete(id) : selected.add(id); renderHome(); }
  if (button.hasAttribute('data-add')) showQuickAdd();
  if (button.hasAttribute('data-retry')) { demoState = 'ready'; $('#demo-state').value = 'ready'; renderHome(); }
});
$('#home-family').addEventListener('change', (event) => { currentFamily = event.target.value; renderHome(); });
$$('[data-date]').forEach((button) => button.addEventListener('click', () => {
  currentDate = button.dataset.date;
  $$('[data-date]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
  renderHome();
}));
$('#date-picker-open').addEventListener('click', () => openSheet('查看其他日期', '<label class="field-label" for="chosen-date">计划日期</label><input id="chosen-date" class="form-input" type="date" value="2026-09-11"><button id="apply-date" class="primary-button full-width" style="margin-top:20px">查看这一天</button>', () => $('#apply-date').addEventListener('click', () => {
  const date = $('#chosen-date').value;
  if (!date) return;
  currentDate = ({ '2026-09-11': 'today', '2026-09-12': 'tomorrow' })[date] || date;
  $$('[data-date]').forEach((button) => { button.classList.toggle('active', button.dataset.date === currentDate); button.setAttribute('aria-pressed', String(button.dataset.date === currentDate)); });
  renderHome(); sheet.close(); toast(`正在查看 ${date}`);
})));
$('#completed-toggle').addEventListener('click', () => { hideCompleted = !hideCompleted; renderHome(); });
$('#batch-toggle').addEventListener('click', () => { batchMode = !batchMode; selected = new Set(); renderHome(); });
$('#quick-add').addEventListener('click', () => batchMode ? showBatchShare() : showQuickAdd());
$('#demo-state').addEventListener('change', (event) => { demoState = event.target.value; renderHome(); });
$('#reset-demo').addEventListener('click', () => location.reload());
['detail-back', 'family-back'].forEach((id) => $(`#${id}`).addEventListener('click', () => $('#home-artboard').scrollIntoView({ block: 'start', behavior: 'auto' })));
$$('[data-family]').forEach((button) => button.addEventListener('click', () => {
  progressFamily = button.dataset.family;
  $$('[data-family]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
  renderFamily();
}));
$('#member-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-member]');
  if (!button) return;
  const person = button.dataset.member;
  const memberTasks = tasks.filter((task) => task.family === progressFamily && task.person === person && task.date === 'today');
  openSheet(`${people[person].name}的今日安排`, `<p class="sheet-message">${families[progressFamily]} · 9 月 11 日<br>仅展示共享给你的事项。</p>${memberTasks.length ? memberTasks.map(taskCard).join('') : '<div class="state-box"><h4>暂无可见的今日安排</h4><p>家人共享事项后，可以在这里查看。</p></div>'}`, wireSheetTasks);
});
function wireSheetTasks() {
  $$('[data-detail]', $('#sheet-body')).forEach((button) => button.addEventListener('click', () => showTask(button.dataset.detail)));
  $$('[data-complete]', $('#sheet-body')).forEach((button) => button.addEventListener('click', () => { toggleComplete(button.dataset.complete); sheet.close(); }));
}
$('#backlog-open').addEventListener('click', () => {
  const backlog = tasks.filter((task) => /^2026-09-10$/.test(task.date) && !task.done && (currentFamily === 'all' || task.family === currentFamily));
  openSheet('之前未完成的事', `<p class="sheet-message">保留原计划日期，不会自动挪到今天。</p>${backlog.length ? backlog.map((task) => `<h3 class="sheet-list-title">9 月 10 日 · 星期四</h3>${taskCard(task)}`).join('') : '<div class="state-box"><h4>这个范围没有积压事项</h4></div>'}`, wireSheetTasks);
});
$('#reminder-open').addEventListener('click', showReminders);
function showReminders() {
  const reminders = dueTasks();
  openSheet('到时提醒', `<p class="sheet-message">汇总所有家庭中提醒你的事项。<br>仅在使用小程序时提示，关闭后不会发送微信通知。</p>${reminders.length ? reminders.map((task) => `<div class="reminder-item"><h3>${escape(task.title)}</h3><p>${families[task.family]} · ${people[task.person].name} · 今天 ${task.time}${dismissedReminders.has(task.id) ? '<br>你已收起这条提示，事项仍待完成' : ''}</p><div><button class="outline-button" data-dismiss="${task.id}" ${dismissedReminders.has(task.id) ? 'disabled' : ''}>${dismissedReminders.has(task.id) ? '已收起' : '收起提示'}</button><button class="primary-button" data-reminder-detail="${task.id}">查看事项</button></div></div>`).join('') : '<div class="state-box"><h4>暂时没有待处理的到时提醒</h4><p>完成事项后，对应提示会一起撤下。</p></div>'}`, () => {
    $$('[data-dismiss]').forEach((button) => button.addEventListener('click', () => { dismissedReminders.add(button.dataset.dismiss); renderHome(); showReminders(); }));
    $$('[data-reminder-detail]').forEach((button) => button.addEventListener('click', () => showTask(button.dataset.reminderDetail)));
  });
}
function showQuickAdd() {
  let chosenDate = currentDate === 'today' ? 'today' : currentDate;
  let expanded = false;
  openSheet('记一件事', `<form id="quick-form"><input class="title-input" id="task-title" maxlength="80" placeholder="想记下什么小事？" aria-label="事项标题" required autocomplete="off"><span class="field-label">哪天做</span><div class="form-pills">${[['today', '今天'], ['tomorrow', '明天'], ['unscheduled', '未安排']].map(([date, label]) => `<button type="button" data-new-date="${date}" class="${chosenDate === date ? 'active' : ''}" aria-pressed="${chosenDate === date}">${label}</button>`).join('')}</div><div id="basic-privacy" class="privacy-note">${icon('lock')}<span>个人事项 · 仅自己可见<br>不设置具体时刻，也可以保存。</span></div><label class="checkbox-label"><input id="new-reminder" type="checkbox" checked>小程序内提醒我</label><p class="form-helper">默认开启，可手动关闭。设置具体时刻后，到时在小程序内提示。</p><button type="button" id="expand-settings" class="sheet-secondary">家庭、时刻、重复与共享${icon('chevron')}</button><div id="advanced-fields" hidden><label class="field-label" for="new-family">所属家庭</label><select id="new-family" class="form-select"><option value="personal">个人 · 暂不归属家庭</option><option value="mine">我的小家</option><option value="parents">爸妈家</option></select><label class="field-label" for="new-person">谁来做</label><select id="new-person" class="form-select"><option value="self">自己</option></select><div class="two-fields"><div><label class="field-label" for="new-repeat">重复</label><select id="new-repeat" class="form-select"><option value="once">不重复</option><option value="daily">每天</option></select></div><div><label class="field-label" for="new-time">时刻（可选）</label><input id="new-time" class="form-input" type="time"></div></div><p class="form-helper" id="new-privacy">仅自己可见。增加可见人不会同时开启对方的提醒或代记权限。</p><div id="new-viewers"></div></div><p id="quick-error" class="form-error" role="alert"></p><p id="quick-success" class="sheet-success" role="status"></p><div class="sheet-actions"><button type="button" class="outline-button" id="save-next">保存并继续记</button><button class="primary-button" type="submit">保存事项</button></div></form>`, () => {
    $$('[data-new-date]').forEach((button) => button.addEventListener('click', () => { chosenDate = button.dataset.newDate; $$('[data-new-date]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); }));
    $('#expand-settings').addEventListener('click', () => { expanded = !expanded; $('#advanced-fields').hidden = !expanded; $('#basic-privacy').hidden = expanded; });
    function updatePrivacy() {
      const family = $('#new-family').value;
      const person = $('#new-person').value;
      $('#new-privacy').textContent = person === 'child' ? '小宝由家人代记。事项归属妈妈（家庭拥有人），由你管理；未默认向全家公开。' : person === 'self' ? '默认仅自己可见。增加可见人不会同时开启对方的提醒或代记权限。' : `为${people[person].name}安排时，${people[person].name}需要可见；其他家人不默认加入。`;
      const names = family === 'mine' ? ['爸爸', '奶奶'] : family === 'parents' ? ['爸爸', '妈妈'] : [];
      $('#new-viewers').innerHTML = names.length ? `<span class="field-label">增加可见家人</span>${names.map((name) => `<label class="checkbox-label"><input type="checkbox" value="${name}" ${name === people[person].name && person !== 'self' ? 'checked disabled' : ''}>${name}</label>`).join('')}` : '';
    }
    $('#new-family').addEventListener('change', () => {
      const family = $('#new-family').value;
      const options = family === 'mine' ? ['self', 'child', 'dad', 'grandma'] : family === 'parents' ? ['self', 'dad', 'mom'] : ['self'];
      $('#new-person').innerHTML = options.map((person) => `<option value="${person}">${person === 'self' ? '自己' : people[person].name}${person === 'child' ? ' · 无账号成员' : ''}</option>`).join('');
      updatePrivacy();
    });
    $('#new-person').addEventListener('change', updatePrivacy);
    function save(continueAdding) {
      const title = $('#task-title').value.trim();
      if (!title) { $('#quick-error').textContent = '先写下要做的事情。'; $('#task-title').focus(); return; }
      const family = expanded ? $('#new-family').value : 'personal';
      const person = expanded ? $('#new-person').value : 'self';
      const repeat = expanded && $('#new-repeat').value === 'daily';
      const time = expanded ? $('#new-time').value : '';
      if (repeat && chosenDate === 'unscheduled') { $('#quick-error').textContent = '每日事项需要选择开始日期。'; return; }
      if (repeat && chosenDate === 'today' && time && time <= '18:30') { $('#quick-error').textContent = '今天这个时刻已过，请选择未来时刻或从明天开始。'; return; }
      tasks.push({ id: `new-${crypto.randomUUID()}`, title, family, person, date: chosenDate, time, done: false, group: person === 'self' ? 'self' : 'help', manage: true, canComplete: true, repeat, reminder: $('#new-reminder').checked, visible: expanded ? $$('#new-viewers input:checked').map((input) => input.value) : [] });
      demoState = 'ready'; $('#demo-state').value = 'ready'; renderAll();
      if (continueAdding) { $('#task-title').value = ''; $('#quick-error').textContent = ''; $('#quick-success').textContent = `已保存“${title}”，继续记下一件吧。`; $('#task-title').focus(); }
      else { sheet.close(); toast(`已保存到${dateLabel(chosenDate).split(' · ')[0]}`); }
    }
    $('#quick-form').addEventListener('submit', (event) => { event.preventDefault(); save(false); });
    $('#save-next').addEventListener('click', () => save(true));
    $('#task-title').focus();
  });
}
function showSettings(task) {
  if (!task.manage) return openSheet('你可以查看这件事', '<p class="sheet-message">妈妈将这件事共享给你查看。你可以了解完成进度，目前不能编辑、代记或再次共享。</p>');
  openSheet('事项设置', `<p class="sheet-message">${escape(task.title)} · ${families[task.family]}</p>${task.person === 'child' ? '<div class="privacy-note">' + icon('people') + '<span>小宝是无账号成员，事项实际归属妈妈（家庭拥有人）。执行对象仍是小宝，代记会保留真实记录人。</span></div>' : ''}<label class="field-label" for="edit-title">事项名称</label><input id="edit-title" class="form-input" value="${escape(task.title)}" maxlength="80"><p class="form-helper">${task.repeat ? '修改周期应只影响未来记录；本设计稿演示名称编辑。' : task.family === 'personal' ? '个人事项默认仅自己可见。' : '家庭事项按已设置的可见范围共享。'}</p><p class="form-error" id="settings-error" role="alert"></p><button id="save-title" class="primary-button full-width" style="margin-top:22px">保存名称</button>`, () => $('#save-title').addEventListener('click', () => { const title = $('#edit-title').value.trim(); if (!title) { $('#settings-error').textContent = '事项名称不能为空。'; return; } task.title = title; renderAll(); sheet.close(); toast('名称已更新', 'detail'); }));
}
function showBatchShare() {
  const chosen = tasks.filter((task) => selected.has(task.id) && task.manage);
  const grouped = Object.groupBy(chosen, (task) => task.family);
  openSheet('批量增加可见人', `<p class="sheet-message">共 ${chosen.length} 项，按家庭分别选择。<br>保留已有可见人，不增加代记或提醒权限。</p>${Object.entries(grouped).map(([family, items]) => `<section data-share-group="${family}"><h3 class="sheet-list-title">${families[family]} · ${items.length} 项</h3>${family === 'personal' ? '<label class="field-label" for="share-family">先明确归属一个家庭</label><select id="share-family" class="form-select"><option value="mine">我的小家</option><option value="parents">爸妈家</option></select>' : ''}<div class="share-people">${(family === 'parents' ? ['爸爸', '妈妈'] : ['爸爸', '奶奶']).map((name) => `<label class="checkbox-label"><input type="checkbox" value="${name}">${name}</label>`).join('')}</div></section>`).join('')}<p id="share-error" class="form-error" role="alert"></p><button class="primary-button full-width" id="apply-share" style="margin-top:20px">确认增加可见人</button>`, () => {
    $('#share-family')?.addEventListener('change', (event) => { const names = event.target.value === 'mine' ? ['爸爸', '奶奶'] : ['爸爸', '妈妈']; $('[data-share-group="personal"] .share-people').innerHTML = names.map((name) => `<label class="checkbox-label"><input type="checkbox" value="${name}">${name}</label>`).join(''); });
    $('#apply-share').addEventListener('click', () => {
      const groups = $$('[data-share-group]');
      if (groups.some((group) => !$('input:checked', group))) { $('#share-error').textContent = '请为每个家庭分组至少选择一位可见人。'; return; }
      groups.forEach((group) => {
        const names = $$('input:checked', group).map((input) => input.value);
        grouped[group.dataset.shareGroup].forEach((task) => { if (task.family === 'personal') task.family = $('#share-family').value; task.visible = [...new Set([...(task.visible || []), ...names])]; });
      });
      batchMode = false; selected = new Set(); renderAll(); sheet.close(); toast(`已为 ${chosen.length} 项增加可见人`);
    });
  });
}
$('#view-family').addEventListener('click', () => $('#family-artboard').scrollIntoView({ block: 'start', behavior: 'auto' }));
$('#manage-family').addEventListener('click', showFamilyManagement);
function showFamilyManagement() {
  const mine = progressFamily === 'mine';
  const members = mine ? [['妈妈（我）', '家庭拥有人', 'self'], ['爸爸', '真实成员', 'dad'], ['奶奶', '真实成员', 'grandma'], ['小宝', '无账号成员 · 家人代记', 'child'], ...extraMembers.map((name) => [name, '无账号成员 · 家人代记', 'child'])] : [['爸爸', '家庭拥有人', 'dad'], ['妈妈', '真实成员', 'mom'], ['我', '真实成员', 'self']];
  openSheet(families[progressFamily], `<p class="sheet-message">${mine ? '你是这个家庭的拥有人，可以邀请家人、创建无账号成员。' : '爸爸是这个家庭的拥有人，负责管理家庭成员。'}</p>${members.map(([name, role, person]) => `<div class="manage-member">${avatar(person)}<span>${escape(name)}<small>${role}</small></span></div>`).join('')}${mine ? '<button id="add-virtual" class="outline-button full-width" style="margin-top:22px">＋ 添加无账号成员</button>' : '<p class="form-helper" style="margin-top:20px">退出家庭时，你在本家庭的事项管理职责将交接给爸爸，包括原本仅自己可见的家庭事项。个人事项和其他家庭不受影响。</p>'}`, () => $('#add-virtual')?.addEventListener('click', () => openSheet('添加无账号成员', '<p class="sheet-message">孩子或老人没有账号，也能由家人帮忙记录。<br>相关事项归属你，日常展示这个成员的称呼。</p><label class="field-label" for="virtual-name">怎么称呼</label><input id="virtual-name" class="form-input" maxlength="12" placeholder="例如：小宝、爷爷"><p class="form-error" id="virtual-error" role="alert"></p><button class="primary-button full-width" id="save-virtual" style="margin-top:20px">添加成员</button>', () => $('#save-virtual').addEventListener('click', () => { const name = $('#virtual-name').value.trim(); if (!name) { $('#virtual-error').textContent = '请填写家人称呼。'; return; } extraMembers.push(name); renderFamily(); showFamilyManagement(); }))));
}
$('#invite-family').addEventListener('click', () => {
  if (progressFamily === 'parents') return showFamilyManagement();
  openSheet('邀请家人加入', '<p class="sheet-message">加入「我的小家」后，可以一起记录日常。<br>只有明确共享的事项，家人才看得到。</p><div class="invitation-code">我的小家</div><p class="form-helper">设计示意：正式小程序通过邀请卡片分享，对方确认后加入。本预览不会生成真实邀请或发送消息。</p>');
});
renderAll();
