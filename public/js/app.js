const state = {
  user: null,
  dashboard: null,
  tasks: [],
  goals: [],
  notes: [],
  rooms: [],
  communities: [],
  events: [],
  ranking: null,
  activeNoteId: null,
  activeCommunityId: null,
  activeRoomId: null,
  activeCommunityTab: 'home',
  communityDirectoryFilter: 'all',
  roomDetail: null,
  communityDetail: null,
  roomPomo: { total:120, focus:25, shortBreak:5, longBreak:15, longEvery:4, goal:'Bloque de estudio profundo' },
  personalPomo: { total:120, focus:25, shortBreak:5, longBreak:15, longEvery:4, goal:'Bloque de estudio profundo' },
  personalPomoTask: null,
  flashCommunityId: null,
  pendingTaskIds: new Set(),
  aiMode: 'explain',
  calendarCursor: new Date(),
  calendarSelectedDate: null,
  sidebarMode: 'dynamic',
  sidebarManualCollapsed: false,
  searchResults: [],
  searchRequest: 0,
  searchActiveIndex: 0,
  searchTimer: null,
  focus: { active: false, paused: false, total: 0, remaining: 0, interval: null },
  admin: { tab: 'dashboard', users: [], communities: [], rooms: [], events: [], reports: null, moderation: [], settings: null }
};

const socket = typeof io === 'function' ? io() : null;
const liveRefresh = { timer: null, resources: new Set() };
const pomodoroPresets = [
  { name:'Rápido', total:20, focus:15, shortBreak:5, longBreak:5, longEvery:2 },
  { name:'Clásico', total:30, focus:25, shortBreak:5, longBreak:5, longEvery:2 },
  { name:'Doble enfoque', total:60, focus:25, shortBreak:5, longBreak:5, longEvery:2 },
  { name:'Ciclo profundo', total:135, focus:25, shortBreak:5, longBreak:20, longEvery:4 }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = 'ui-icon') => window.FocurionIcons?.svg(name, className) || '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[char]));
}

function formatDate(value, options = { day: '2-digit', month: 'short' }) {
  if (!value) return 'Sin fecha';
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-MX', options).format(date);
}

function timeAgo(value) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

function initials(name = 'F') {
  return name.split(/\s+/).filter(Boolean).slice(0,2).map(part => part[0]).join('').toUpperCase() || 'F';
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  $('#toastContainer').append(item);
  setTimeout(() => item.remove(), 3600);
}

async function api(url, options = {}) {
  const config = { cache: 'no-store', credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(url, config);
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (response.status === 401) {
    window.location.href = '/';
    throw new Error('Sesión vencida.');
  }
  if (!response.ok) throw new Error(data.error || 'Ocurrió un error inesperado.');
  return data;
}

function setUserUI() {
  const name = state.user.name;
  const isAdmin = state.user.role === 'admin';
  const canAdmin = ['admin','moderator'].includes(state.user.role);

  $('#sidebarName').textContent = name;
  $('#sidebarXp').textContent = isAdmin ? 'Administrador' : `${state.user.xp} XP`;
  $('#welcomeName').textContent = name.split(' ')[0];
  $('#sidebarAvatar').textContent = initials(name);
  $('#topAvatar').textContent = initials(name);
  $('#settingsAvatar').textContent = initials(name);
  $('#settingsNamePreview').textContent = name;
  $('#settingsEmail').textContent = state.user.email;

  document.body.classList.toggle('admin-mode', isAdmin);
  $$('.student-nav').forEach(el => el.classList.toggle('hidden', isAdmin));
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !canAdmin));

  const quick = $('#quickSession');
  if (quick) quick.innerHTML = isAdmin ? `${icon('plus')} Nuevo registro` : `${icon('bolt')} Nueva sesión`;
  const search = $('#globalSearch');
  if (search) search.placeholder = isAdmin
    ? 'Buscar usuarios, comunidades, salas o eventos…'
    : 'Buscar tareas, salas, eventos o comunidades…';

  document.body.classList.toggle('light-theme', state.user.theme === 'light');
  $('#themeQuick').innerHTML = icon(state.user.theme === 'light' ? 'moon' : 'sun');
  $('#miniPomoTime').textContent = `${String(state.user.pomodoro_minutes).padStart(2,'0')}:00`;
  $('#personalPomoTime').textContent = `${String(state.user.pomodoro_minutes).padStart(2,'0')}:00`;
  applySidebarMode(readSidebarMode(), false);
}

function sidebarStorageKey() { return `focurionSidebarMode:${state.user?.id || 'guest'}`; }

function readSidebarMode() {
  try { return ['manual','fixed'].includes(localStorage.getItem(sidebarStorageKey())) ? 'manual' : 'dynamic'; }
  catch (_) { return 'dynamic'; }
}

function sidebarManualStorageKey() { return `focurionSidebarManualCollapsed:${state.user?.id || 'guest'}`; }

function readSidebarManualCollapsed() {
  try { return localStorage.getItem(sidebarManualStorageKey()) === '1'; }
  catch (_) { return false; }
}

function sidebarIsExpanded() {
  return state.sidebarMode === 'dynamic'
    ? document.body.classList.contains('sidebar-hovered')
    : !state.sidebarManualCollapsed;
}

function animateSidebarToggle() {
  const button = $('#sidebarToggle');
  if (!button) return;
  button.classList.remove('is-moving');
  void button.offsetWidth;
  button.classList.add('is-moving');
  window.setTimeout(() => button.classList.remove('is-moving'), 440);
}

function updateSidebarToggle(animate = false) {
  const button = $('#sidebarToggle');
  if (!button) return;
  const expanded = sidebarIsExpanded();
  const label = state.sidebarMode === 'dynamic'
    ? (expanded ? 'Barra dinámica abierta; activar control manual' : 'Barra dinámica cerrada; activar control manual')
    : (expanded ? 'Ocultar barra lateral' : 'Mostrar barra lateral');
  button.innerHTML = icon(expanded ? 'arrowLeft' : 'arrowRight');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(expanded));
  if (animate) animateSidebarToggle();
}

function applySidebarMode(mode = 'dynamic', persist = false, manualCollapsed = null) {
  const normalized = ['manual','fixed'].includes(mode) ? 'manual' : 'dynamic';
  state.sidebarMode = normalized;
  if (manualCollapsed !== null) state.sidebarManualCollapsed = Boolean(manualCollapsed);
  else if (normalized === 'manual') state.sidebarManualCollapsed = readSidebarManualCollapsed();
  const collapsed = normalized === 'dynamic' || state.sidebarManualCollapsed;
  document.body.classList.toggle('sidebar-mode-dynamic', normalized === 'dynamic');
  document.body.classList.toggle('sidebar-mode-manual', normalized === 'manual');
  document.body.classList.remove('sidebar-hovered');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  updateSidebarToggle();
  ['#settingsForm','#adminSettingsForm'].forEach(selector => {
    const form = $(selector);
    if (form?.elements.sidebar_behavior) form.elements.sidebar_behavior.value = normalized;
  });
  if (persist) {
    try { localStorage.setItem(sidebarStorageKey(), normalized); } catch (_) {}
    try { localStorage.setItem(sidebarManualStorageKey(), state.sidebarManualCollapsed ? '1' : '0'); } catch (_) {}
  }
}

function toggleSidebarMode() {
  const nextMode = 'manual';
  const nextCollapsed = state.sidebarMode === 'dynamic' ? false : !state.sidebarManualCollapsed;
  const sidebar = $('#sidebar');
  sidebar?.classList.remove('sidebar-force-collapse');
  sidebar?.classList.remove('sidebar-revealing');
  applySidebarMode(nextMode, true, nextCollapsed);
  animateSidebarToggle();
  if (nextCollapsed && sidebar) {
    sidebar.classList.add('sidebar-force-collapse');
    $('#sidebarToggle')?.blur();
    window.setTimeout(() => sidebar.classList.remove('sidebar-force-collapse'), 520);
  } else if (sidebar) {
    sidebar.classList.add('sidebar-revealing');
    window.setTimeout(() => sidebar.classList.remove('sidebar-revealing'), 520);
  }
  toast(nextCollapsed ? 'Barra lateral contraída manualmente.' : 'Barra lateral mostrada manualmente.');
}

const searchKindMeta = {
  task:['check','Tarea'], event:['calendar','Evento'], room:['users','Sala'], community:['network','Comunidad'],
  goal:['target','Meta'], note:['file','Nota'], resource:['link','Recurso'], project:['folder','Proyecto'],
  challenge:['trending','Reto'], user:['users','Usuario'], report:['shield','Moderación']
};

function hideGlobalSearchResults() {
  $('#globalSearchResults').classList.remove('open');
  $('#globalSearch').setAttribute('aria-expanded','false');
  state.searchActiveIndex = 0;
}

function renderGlobalSearchResults(message = '') {
  const container = $('#globalSearchResults');
  if (message) {
    container.innerHTML = `<div class="global-search-state">${escapeHtml(message)}</div>`;
  } else if (!state.searchResults.length) {
    container.innerHTML = '<div class="global-search-state">No encontramos coincidencias.</div>';
  } else {
    container.innerHTML = state.searchResults.map((item,index) => {
      const [iconName,label] = searchKindMeta[item.kind] || ['search','Resultado'];
      return `<button class="global-search-result ${index===state.searchActiveIndex?'active':''}" type="button" role="option" aria-selected="${index===state.searchActiveIndex}" data-search-result="${index}"><span class="global-search-result-icon">${icon(iconName)}</span><span class="global-search-result-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.subtitle||label)}</small></span><span class="global-search-kind">${label}</span>${icon('arrowRight')}</button>`;
    }).join('');
  }
  container.classList.add('open');
  $('#globalSearch').setAttribute('aria-expanded','true');
}

async function performGlobalSearch(query) {
  const clean = query.trim();
  if (clean.length < 2) { state.searchResults=[]; hideGlobalSearchResults(); return; }
  const request = ++state.searchRequest;
  state.searchResults = [];
  state.searchActiveIndex = 0;
  renderGlobalSearchResults('Buscando en Focurion…');
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(clean)}`);
    if (request !== state.searchRequest || $('#globalSearch').value.trim() !== clean) return;
    state.searchResults = data.results || [];
    state.searchActiveIndex = 0;
    renderGlobalSearchResults();
  } catch (error) {
    if (request === state.searchRequest) renderGlobalSearchResults(error.message);
  }
}

function focusSearchResult(index) {
  if (!state.searchResults.length) return;
  state.searchActiveIndex = (index + state.searchResults.length) % state.searchResults.length;
  $$('.global-search-result').forEach((button,position) => {
    button.classList.toggle('active',position===state.searchActiveIndex);
    button.setAttribute('aria-selected',String(position===state.searchActiveIndex));
  });
  $(`.global-search-result[data-search-result="${state.searchActiveIndex}"]`)?.scrollIntoView({block:'nearest'});
}

function flashSearchTarget(element) {
  if (!element) return;
  element.classList.remove('search-target-flash');
  requestAnimationFrame(() => element.classList.add('search-target-flash'));
  element.scrollIntoView({behavior:'smooth',block:'center'});
  setTimeout(() => element.classList.remove('search-target-flash'), 1800);
}

async function openGlobalSearchResult(item) {
  if (!item) return;
  hideGlobalSearchResults();
  $('#globalSearch').blur();
  if (['admin','moderator'].includes(state.user.role)) {
    const tabByKind={user:'users',community:'communities',room:'rooms',event:'events',report:'moderation'};
    const inputByKind={user:'#adminUserSearch',community:'#adminCommunitySearch',room:'#adminRoomSearch',event:'#adminEventSearch',report:'#adminModerationSearch'};
    showView('admin');
    const tab=tabByKind[item.kind]||'dashboard';
    showAdminTab(tab);
    setTimeout(()=>{const input=$(inputByKind[item.kind]);if(input){input.value=item.title;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}},220);
    return;
  }
  if (['task','goal','note'].includes(item.kind)) {
    showView('personal');
    await loadPersonal();
    const tab={task:'tasks',goal:'goals',note:'notes'}[item.kind];
    $(`.section-tab[data-personal-tab="${tab}"]`)?.click();
    if(item.kind==='note') { state.activeNoteId=Number(item.id); selectNote(item.id); }
    const root=item.kind==='task'?$('#tasksList'):item.kind==='goal'?$('#goalsList'):$('#notesList');
    const selector=item.kind==='task'?`[data-task-id="${item.id}"]`:item.kind==='goal'?`[data-goal-id="${item.id}"]`:`[data-note-id="${item.id}"]`;
    setTimeout(()=>flashSearchTarget($(selector,root)),80);
    return;
  }
  if (item.kind==='event') return openCalendarDate(item.start_date);
  if (item.kind==='room') {
    showView('rooms'); await loadRooms();
    if(Number(item.joined)) return openRoomDetail(item.id);
    $('#roomSearch').value=item.title; renderRooms();
    return flashSearchTarget($(`[data-room-action="${item.id}"]`)?.closest('article'));
  }
  if (item.kind==='community') {
    showView('communities'); await loadCommunities();
    if(Number(item.joined)) return openCommunity(item.id);
    $('#communitySearch').value=item.title; renderCommunities();
    return flashSearchTarget($(`[data-community-action="${item.id}"]`)?.closest('article'));
  }
  if (['resource','project','challenge'].includes(item.kind)) {
    showView('communities'); await loadCommunities();
    state.activeCommunityTab=item.tab;
    await openCommunity(item.community_id);
    renderCommunityTab(item.tab);
    return;
  }
  if (item.kind==='user') {
    showView('ranking'); await loadRanking();
    return flashSearchTarget($(`[data-ranking-user="${item.id}"]`));
  }
}

function showView(name, updateHash = true) {
  if (state.user?.role === 'admin' && name !== 'admin') name = 'admin';
  if (state.focus.active) {
    toast('La sesión de enfoque está bloqueando la navegación.', 'error');
    return;
  }
  const target = $(`#view-${name}`);
  if (!target) return;
  $$('.view').forEach(view => view.classList.remove('active'));
  target.classList.add('active');
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#sidebar').classList.remove('open');
  if (updateHash) history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const loaders = {
    dashboard: loadDashboard,
    personal: loadPersonal,
    rooms: loadRooms,
    ai: loadAiHistory,
    communities: loadCommunities,
    ranking: loadRanking,
    calendar: loadEvents,
    settings: fillSettings,
    admin: loadAdmin
  };
  loaders[name]?.();
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const first = modal.querySelector('input,textarea,select');
  setTimeout(() => first?.focus(), 80);
}

function closeModals() {
  $$('.modal.open').forEach(modal => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  });
}

function setFormPending(form, pending, pendingLabel = 'Guardando…') {
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
  form.classList.toggle('is-submitting', pending);
  button.disabled = pending;
  button.setAttribute('aria-busy', String(pending));
  button.textContent = pending ? pendingLabel : button.dataset.defaultLabel;
}

function metricCard(iconName, value, label, color) {
  return `<article class="metric-card" style="--metric-color:${color}"><div class="metric-icon">${icon(iconName)}</div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`;
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  state.dashboard = data;
  state.tasks = data.tasks;
  state.user.xp = data.metrics.xp;
  setUserUI();
  $('#dashboardMetrics').innerHTML = [
    metricCard('target', `${data.metrics.productivity}%`, 'Enfoque semanal', '#45c4ff'),
    metricCard('clock', `${Math.floor(data.metrics.studyMinutes / 60)} h ${data.metrics.studyMinutes % 60} m`, 'Tiempo estudiado', '#a15cff'),
    metricCard('check', data.metrics.completedTasks, 'Tareas completadas', '#2dd4bf'),
    metricCard('trending', `${data.metrics.streak} días`, 'Racha activa', '#4b8cff')
  ].join('');
  renderDashboardTasks(data.tasks);
  renderDashboardGoals(data.goals);
  renderDashboardEvents(data.events);
  renderDashboardRooms(data.rooms);
  renderDashboardRanking(data.ranking);
}

function taskRow(task, full = false) {
  const completed = task.status === 'completed';
  const busy = state.pendingTaskIds.has(Number(task.id));
  const focusAction = completed ? '' : `<button class="task-focus-button" data-focus-task="${task.id}" type="button" title="Iniciar Pomodoro para ${escapeHtml(task.title)}" aria-label="Iniciar Pomodoro para ${escapeHtml(task.title)}">${icon('play')}<span>Enfocarme</span></button>`;
  const deleteAction = full ? '<button data-delete-task title="Eliminar" aria-label="Eliminar tarea">×</button>' : '';
  return `<div class="task-row ${completed ? 'completed' : ''} ${busy ? 'task-updating' : ''}" data-task-id="${task.id}" data-task-status="${escapeHtml(task.status)}">
    <input class="task-check" type="checkbox" ${completed ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${completed ? 'Reabrir' : 'Completar'} tarea: ${escapeHtml(task.title)}">
    <div class="task-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.description || formatDate(task.due_date))}</small></div>
    <div class="task-tags"><span class="task-state ${completed ? 'done' : 'pending'}">${completed ? '✓ Completada' : 'Pendiente'}</span><span class="priority ${task.priority}">${task.priority === 'high' ? 'Alta' : task.priority === 'low' ? 'Baja' : 'Media'}</span></div>
    <div class="row-actions">${focusAction}${deleteAction}</div>
  </div>`;
}

function startTaskPomodoro(id) {
  const task = (state.tasks || state.dashboard?.tasks || []).find(item => Number(item.id) === Number(id));
  if (!task) return toast('No se encontró la tarea seleccionada.', 'error');
  if (state.focus.active) return toast('Ya hay una sesión de enfoque activa.', 'error');
  openPersonalPomoSettings(task);
}

function toggleTaskFromRow(event) {
  if (event.target.closest('input, button, a, select, textarea')) return;
  const row = event.target.closest('[data-task-id]');
  const checkbox = row?.querySelector('.task-check');
  if (!checkbox || checkbox.disabled) return;
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event('change', { bubbles:true }));
}

function renderDashboardTasks(tasks) {
  const pending = tasks.filter(task => task.status !== 'completed').slice(0,5);
  $('#dashboardTasks').innerHTML = pending.length ? pending.map(task => taskRow(task)).join('') : '<div class="empty-inline">No tienes tareas pendientes. Buen trabajo.</div>';
}

function renderDashboardGoals(goals) {
  $('#dashboardGoals').innerHTML = goals.length ? goals.slice(0,4).map(goal => {
    const pct = Math.min(100, Math.round((goal.current / goal.target) * 100));
    return `<div class="goal-row"><div class="goal-row-head"><strong>${escapeHtml(goal.title)}</strong><span>${pct}%</span></div><div class="progress-bar"><span style="width:${pct}%"></span></div></div>`;
  }).join('') : '<div class="empty-inline">Crea una meta semanal para medir tu avance.</div>';
}

function renderDashboardEvents(events) {
  $('#dashboardEvents').innerHTML = events.length ? events.slice(0,4).map(event => `<button class="task-row dashboard-event-link" type="button" data-dashboard-date="${escapeHtml(event.start_date)}" aria-label="Ver ${escapeHtml(event.title)} en el calendario"><span class="entity-icon" style="width:30px;height:30px;border-radius:9px;background:${escapeHtml(event.color)}22;color:${escapeHtml(event.color)}">${icon('calendar')}</span><div class="task-copy"><strong>${escapeHtml(event.title)}</strong><small>${formatDate(event.start_date, { weekday:'short', day:'2-digit', month:'short' })}</small></div><span class="priority medium">${formatDate(event.start_date)}</span><span class="dashboard-link-arrow">${icon('arrowRight')}</span></button>`).join('') : '<div class="empty-inline">No hay fechas próximas.</div>';
}

function renderDashboardRooms(rooms) {
  $('#dashboardRooms').innerHTML = rooms.length ? rooms.slice(0,4).map(room => `<button class="mini-room-card" data-dashboard-room="${room.id}" style="text-align:left;color:inherit;cursor:pointer"><strong>${escapeHtml(room.name)}</strong><small>${escapeHtml(room.topic)} · ${room.members} miembros</small></button>`).join('') : '<div class="empty-inline">No hay salas disponibles.</div>';
}

function renderDashboardRanking(users) {
  $('#dashboardRanking').innerHTML = users.map((user,index) => `<button type="button" class="ranking-mini-row dashboard-ranking-link ${user.id === state.user.id ? 'me' : ''}" data-dashboard-ranking aria-label="Abrir ranking universitario"><b>${index+1}</b><strong>${escapeHtml(user.name)}</strong><span>${user.xp} XP</span></button>`).join('');
}

function openCalendarDate(date) {
  const target = new Date(`${date}T12:00:00`);
  if (Number.isNaN(target.getTime())) return;
  state.calendarCursor = target;
  state.calendarSelectedDate = date;
  showView('calendar');
}

function renderPersonalSummary() {
  const completed = state.tasks.filter(task => task.status === 'completed').length;
  const activeGoals = state.goals.filter(goal => goal.status === 'active').length;
  const summary = $('#personalSummary');
  if (!summary) return;
  summary.innerHTML = [
    `<div class="summary-stat"><strong>${state.tasks.length}</strong><span>Tareas totales</span></div>`,
    `<div class="summary-stat"><strong>${completed}</strong><span>Completadas</span></div>`,
    `<div class="summary-stat"><strong>${activeGoals}</strong><span>Metas activas</span></div>`,
    `<div class="summary-stat"><strong>${state.notes.length}</strong><span>Notas guardadas</span></div>`
  ].join('');
}

async function loadPersonal() {
  await Promise.all([loadTasks(), loadGoals(), loadNotes()]);
  renderPersonalSummary();
}

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks;
  renderTasks();
}

function renderTasks() {
  $('#tasksList').innerHTML = state.tasks.length ? state.tasks.map(task => taskRow(task, true)).join('') : '<div class="empty-inline">Aún no tienes tareas.</div>';
}

async function createTask(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  await api('/api/tasks', { method:'POST', body:JSON.stringify(payload) });
  form.reset();
  closeModals();
  toast('Tarea creada.');
  await Promise.all([loadTasks(), loadDashboard()]);
}

async function toggleTask(id, completed) {
  const taskId = Number(id);
  if (state.pendingTaskIds.has(taskId)) return;
  const task = state.tasks.find(item => Number(item.id) === taskId);
  const previousStatus = task?.status || (completed ? 'pending' : 'completed');
  state.pendingTaskIds.add(taskId);

  const rows = $$(`[data-task-id="${taskId}"]`);
  rows.forEach(row => {
    row.classList.add('task-updating');
    row.classList.toggle('completed', completed);
    row.classList.toggle('task-completing', completed);
    row.classList.toggle('task-reopening', !completed);
    row.dataset.taskStatus = completed ? 'completed' : 'pending';
    const checkbox = $('.task-check', row);
    if (checkbox) { checkbox.checked = completed; checkbox.disabled = true; }
    const status = $('.task-state', row);
    if (status) {
      status.className = `task-state ${completed ? 'done' : 'pending'}`;
      status.textContent = completed ? '✓ Completada' : 'Pendiente';
    }
  });
  if (task) task.status = completed ? 'completed' : 'pending';
  renderPersonalSummary();

  try {
    await api(`/api/tasks/${taskId}`, { method:'PATCH', body:JSON.stringify({ status: completed ? 'completed' : 'pending' }) });
    toast(completed ? 'Tarea completada. ¡Sumaste XP!' : 'Tarea reabierta.');
    if (completed) await new Promise(resolve => setTimeout(resolve, 420));
    await Promise.all([loadTasks(), loadDashboard()]);
    renderPersonalSummary();
  } catch (error) {
    if (task) task.status = previousStatus;
    rows.forEach(row => {
      row.classList.toggle('completed', previousStatus === 'completed');
      const checkbox = $('.task-check', row);
      if (checkbox) checkbox.checked = previousStatus === 'completed';
    });
    renderPersonalSummary();
    throw error;
  } finally {
    state.pendingTaskIds.delete(taskId);
    $$(`[data-task-id="${taskId}"]`).forEach(row => {
      row.classList.remove('task-updating','task-completing','task-reopening');
      const checkbox = $('.task-check', row);
      if (checkbox) checkbox.disabled = false;
    });
  }
}

async function deleteTask(id) {
  if (!confirm('¿Eliminar esta tarea?')) return;
  await api(`/api/tasks/${id}`, { method:'DELETE' });
  toast('Tarea eliminada.');
  await Promise.all([loadTasks(), loadDashboard()]);
}

async function loadGoals() {
  const data = await api('/api/goals');
  state.goals = data.goals;
  renderGoals();
}

function renderGoals() {
  $('#goalsList').innerHTML = state.goals.length ? state.goals.map(goal => {
    const pct = Math.min(100, Math.round(goal.current / goal.target * 100));
    return `<article class="goal-card" data-goal-id="${goal.id}">
      <div class="goal-card-head"><strong>${escapeHtml(goal.title)}</strong><button class="link-btn" data-delete-goal>Eliminar</button></div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      <small>${goal.current} de ${goal.target} ${escapeHtml(goal.unit)} · ${pct}%</small>
      <div class="goal-update"><input type="number" min="0" max="${goal.target}" step="1" value="${goal.current}" aria-label="Progreso actual"><button class="btn btn-secondary btn-small" data-update-goal>Actualizar</button></div>
    </article>`;
  }).join('') : '<div class="empty-inline">Crea una meta para empezar.</div>';
}

async function createGoal(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  await api('/api/goals', { method:'POST', body:JSON.stringify(payload) });
  form.reset();
  closeModals();
  toast('Meta creada.');
  await Promise.all([loadGoals(), loadDashboard()]);
}

async function updateGoal(id, current) {
  await api(`/api/goals/${id}`, { method:'PATCH', body:JSON.stringify({ current }) });
  toast('Progreso actualizado.');
  await Promise.all([loadGoals(), loadDashboard()]);
}

async function deleteGoal(id) {
  if (!confirm('¿Eliminar esta meta?')) return;
  await api(`/api/goals/${id}`, { method:'DELETE' });
  toast('Meta eliminada.');
  await loadGoals();
}

async function loadNotes() {
  const data = await api('/api/notes');
  state.notes = data.notes;
  renderNotes();
  if (state.activeNoteId) selectNote(state.activeNoteId);
  else if (state.notes[0]) selectNote(state.notes[0].id);
}

function renderNotes() {
  $('#notesList').innerHTML = state.notes.length ? state.notes.map(note => `<button class="note-list-item ${note.id === state.activeNoteId ? 'active' : ''}" data-note-id="${note.id}"><strong>${escapeHtml(note.title)}</strong><span>${escapeHtml(note.content.slice(0,80) || 'Nota vacía')}</span></button>`).join('') : '<div class="empty-inline">No hay notas todavía.</div>';
}

function selectNote(id) {
  const note = state.notes.find(item => item.id === Number(id));
  if (!note) return;
  state.activeNoteId = note.id;
  $('#noteTitle').value = note.title;
  $('#noteContent').value = note.content;
  $('#noteStatus').textContent = `Actualizada ${timeAgo(note.updated_at)}`;
  $('#saveNoteButton').disabled = false;
  $('#deleteNoteButton').disabled = false;
  renderNotes();
}

async function newNote() {
  const data = await api('/api/notes', { method:'POST', body:JSON.stringify({ title:'Nueva nota', content:'' }) });
  state.activeNoteId = data.note.id;
  toast('Nota creada.');
  await loadNotes();
  $('#noteTitle').focus();
}

async function saveNote() {
  if (!state.activeNoteId) return;
  await api(`/api/notes/${state.activeNoteId}`, { method:'PATCH', body:JSON.stringify({ title:$('#noteTitle').value, content:$('#noteContent').value }) });
  toast('Nota guardada.');
  await loadNotes();
}

async function deleteNote() {
  if (!state.activeNoteId || !confirm('¿Eliminar esta nota?')) return;
  await api(`/api/notes/${state.activeNoteId}`, { method:'DELETE' });
  state.activeNoteId = null;
  $('#noteTitle').value = '';
  $('#noteContent').value = '';
  $('#saveNoteButton').disabled = true;
  $('#deleteNoteButton').disabled = true;
  toast('Nota eliminada.');
  await loadNotes();
}

async function loadRooms() {
  const data = await api('/api/rooms');
  state.rooms = data.rooms;
  populateRoomFilter();
  renderRooms();
  if (state.activeRoomId && !$('#roomDetailScreen').classList.contains('hidden')) await openRoomDetail(state.activeRoomId, false);
}

function populateRoomFilter() {
  const current = $('#roomFilter').value || 'all';
  const topics = [...new Set(state.rooms.map(room => room.topic))].sort();
  $('#roomFilter').innerHTML = '<option value="all">Todos los temas</option>' + topics.map(topic => `<option value="${escapeHtml(topic)}">${escapeHtml(topic)}</option>`).join('');
  $('#roomFilter').value = topics.includes(current) ? current : 'all';
  $('#roomFilterChips').innerHTML = ['all',...topics].map(topic => `<button class="${($('#roomFilter').value||'all')===topic?'active':''}" data-room-filter="${escapeHtml(topic)}">${topic==='all'?'Todas':escapeHtml(topic)}</button>`).join('');
}

function renderRooms() {
  const search = $('#roomSearch').value.trim().toLowerCase();
  const filter = $('#roomFilter').value;
  const rooms = state.rooms.filter(room => (filter === 'all' || room.topic === filter) && `${room.name} ${room.topic} ${room.description}`.toLowerCase().includes(search));
  const iconByTopic = topic => /sql|datos/i.test(topic) ? 'database' : /seguridad/i.test(topic) ? 'shield' : /red/i.test(topic) ? 'network' : /react|video/i.test(topic) ? 'play' : 'code';
  $('#roomsGrid').innerHTML = rooms.length ? rooms.map(room => `<article class="room-showcase-card">
    <div class="room-card-top"><div class="room-topic-icon accent-${Number(room.id)%4}">${icon(iconByTopic(room.topic))}</div><span class="active-pill"><i></i>${room.members} activos</span></div>
    <div><h3>${escapeHtml(room.name)}</h3><p>Tema: ${escapeHtml(room.topic || room.category || 'General')}</p></div>
    <button class="room-join-button" data-room-action="${room.id}" data-joined="${room.joined}">${room.joined ? 'Entrar' : 'Unirse'}</button>
  </article>`).join('') : '<div class="empty-inline">No encontramos salas con esos filtros.</div>';
}

async function createRoom(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.is_private = form.elements.is_private.checked;
  await api('/api/rooms', { method:'POST', body:JSON.stringify(payload) });
  form.reset(); closeModals(); toast('Sala creada.'); await loadRooms();
}

async function roomAction(id, joined) {
  const room = state.rooms.find(item => item.id === Number(id));
  if (!room) return;
  if (!joined) {
    let access_code = '';
    if (room.is_private) access_code = prompt('Código de acceso de la sala:') || '';
    await api(`/api/rooms/${id}/join`, { method:'POST', body:JSON.stringify({ access_code }) });
    toast('Te uniste a la sala.');
    await loadRooms();
  }
  openRoomDetail(id);
}

async function openRoomDetail(id, scroll = true) {
  const room = state.rooms.find(item => item.id === Number(id));
  if (!room) return;
  state.activeRoomId = room.id;
  const data = await api(`/api/rooms/${id}/detail`);
  state.roomDetail = data;
  $('#roomsListScreen').classList.add('hidden');
  $('#roomDetailScreen').classList.remove('hidden');
  $('#roomDetailName').textContent = data.room.name;
  $('#roomDetailDescription').textContent = data.room.description || `Sala para estudiar ${data.room.topic}.`;
  $('#roomDetailActive').textContent = `${data.members.length} activos`;
  $('#roomMembersTotal').textContent = `${data.members.length} en total`;
  $('#roomPomoTime').textContent = `${String(state.roomPomo.focus).padStart(2,'0')}:00`;
  $('#roomPomoGoal').textContent = state.roomPomo.goal;
  $('#roomObjectives').innerHTML = data.objectives.length ? data.objectives.map(item => `<label class="room-objective ${item.completed?'completed':''}"><input type="checkbox" data-objective-id="${item.id}" ${item.completed?'checked':''} ${item.user_id!==state.user.id?'disabled':''}><span class="avatar avatar-sm" style="background:${escapeHtml(item.avatar_color||'#6d5dfc')}">${initials(item.name)}</span><span><b>${escapeHtml(item.name)}:</b> ${escapeHtml(item.content)}</span></label>`).join('') : '<div class="empty-inline">Agrega el primer objetivo de la sesión.</div>';
  $('#roomResources').innerHTML = data.resources.length ? data.resources.map(item => `<a class="room-resource" href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><span>${icon(item.resource_type==='repository'?'folder':item.resource_type==='video'?'play':item.resource_type==='document'?'file':'link')}</span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.name)}</small></a>`).join('') : '<div class="empty-inline">Todavía no hay recursos.</div>';
  $('#roomMembers').innerHTML = data.members.map((item,index) => `<div class="member-status-row"><div class="avatar avatar-sm" style="background:${escapeHtml(item.avatar_color||'#6d5dfc')}">${initials(item.name)}</div><strong>${escapeHtml(item.name)}</strong><span class="member-state ${index%3===2?'break':index%3===1?'available':'focused'}">${index%3===2?'Descanso':index%3===1?'Disponible':'Enfocado'}</span></div>`).join('');
  renderRoomMessages(data.messages);
  socket?.emit('room:join', room.id);
  history.replaceState(null,'',`#rooms/${room.id}`);
  if (scroll) window.scrollTo({top:0,behavior:'smooth'});
}

function closeRoomDetail() {
  state.activeRoomId = null;
  state.roomDetail = null;
  $('#roomDetailScreen').classList.add('hidden');
  $('#roomsListScreen').classList.remove('hidden');
  history.replaceState(null,'','#rooms');
}

async function leaveActiveRoom() {
  if (!state.activeRoomId || !confirm('¿Salir de esta sala colaborativa?')) return;
  await api(`/api/rooms/${state.activeRoomId}/leave`,{method:'POST',body:'{}'});
  closeRoomDetail();
  toast('Saliste de la sala.');
  await loadRooms();
}

function renderRoomMessages(messages) {
  $('#roomChatMessages').innerHTML = messages.length ? messages.map(roomMessageHtml).join('') : '<div class="empty-inline">Sé la primera persona en escribir.</div>';
  $('#roomChatMessages').scrollTop = $('#roomChatMessages').scrollHeight;
}

function roomMessageHtml(message) {
  return `<div class="room-message ${message.user_id === state.user.id ? 'mine' : ''}"><div class="avatar avatar-sm">${initials(message.name)}</div><div class="room-message-copy"><strong>${escapeHtml(message.name)} · ${timeAgo(message.created_at)}</strong><p>${escapeHtml(message.content)}</p></div></div>`;
}

async function createRoomObjective(form) {
  await api(`/api/rooms/${state.activeRoomId}/objectives`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});
  form.reset(); closeModals(); toast('Objetivo agregado.'); await openRoomDetail(state.activeRoomId,false);
}

async function createRoomResource(form) {
  await api(`/api/rooms/${state.activeRoomId}/resources`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});
  form.reset(); closeModals(); toast('Recurso compartido.'); await openRoomDetail(state.activeRoomId,false);
}

function renderPomoPresets() {
  $$('[data-pomodoro-presets]').forEach(container => {
    const target = container.dataset.pomodoroPresets;
    container.innerHTML = pomodoroPresets.map(preset => `<button type="button" data-pomodoro-preset="${target}" data-total="${preset.total}" data-focus="${preset.focus}" data-short-break="${preset.shortBreak}" data-long-break="${preset.longBreak}" data-long-every="${preset.longEvery}"><strong>${preset.name}</strong><span>${preset.total} min · ${preset.focus} enfoque · ${preset.shortBreak}/${preset.longBreak} descansos</span></button>`).join('');
  });
}

function applyPomoPreset(button) {
  const form = button.dataset.pomodoroPreset === 'room' ? $('#roomPomodoroForm') : $('#personalPomodoroForm');
  if (!form) return;
  form.elements.total.value = button.dataset.total;
  form.elements.focus.value = button.dataset.focus;
  form.elements.shortBreak.value = button.dataset.shortBreak;
  form.elements.longBreak.value = button.dataset.longBreak;
  form.elements.longEvery.value = button.dataset.longEvery;
  $$('[data-pomodoro-preset]', form).forEach(item => item.classList.toggle('active', item === button));
  if (button.dataset.pomodoroPreset === 'room') updateRoomPomoPreview();
  else updatePersonalPomoPreview();
}

function syncPomoConstraints(form) {
  const rawTotal = Number(form.elements.total.value);
  if (!Number.isFinite(rawTotal) || rawTotal < 5) return null;
  const total = Math.min(300, rawTotal);
  form.elements.total.value = total;
  form.elements.focus.max = total;
  form.elements.focus.value = Math.min(total, Math.max(1, Number(form.elements.focus.value || 1)));
  const availableBreak = Math.max(0, total - Number(form.elements.focus.value));
  ['shortBreak','longBreak'].forEach(name => {
    const input = form.elements[name];
    input.max = availableBreak;
    input.value = Math.min(availableBreak, Math.max(0, Number(input.value || 0)));
  });
  return {
    total,
    focus:Number(form.elements.focus.value),
    shortBreak:Number(form.elements.shortBreak.value),
    longBreak:Number(form.elements.longBreak.value),
    longEvery:Math.max(2, Number(form.elements.longEvery.value || 4))
  };
}

function buildPomoPlan(settings) {
  const phases = [];
  let elapsed = 0;
  let focusMinutes = 0;
  let breakMinutes = 0;
  let focusBlocks = 0;
  let shortBreaks = 0;
  let longBreaks = 0;
  let adjusted = false;
  while (elapsed < settings.total) {
    const focusDuration = Math.min(settings.focus, settings.total - elapsed);
    phases.push({ type:'focus', duration:focusDuration });
    elapsed += focusDuration;
    focusMinutes += focusDuration;
    focusBlocks += 1;
    if (elapsed >= settings.total) break;
    const long = focusBlocks % settings.longEvery === 0;
    const requestedBreak = long ? settings.longBreak : settings.shortBreak;
    if (requestedBreak <= 0) continue;
    const duration = Math.min(requestedBreak, settings.total - elapsed);
    if (duration < requestedBreak) adjusted = true;
    phases.push({ type:long ? 'longBreak' : 'shortBreak', duration });
    elapsed += duration;
    breakMinutes += duration;
    if (long) longBreaks += 1;
    else shortBreaks += 1;
  }
  return { phases, focusMinutes, breakMinutes, focusBlocks, shortBreaks, longBreaks, total:elapsed, adjusted };
}

function pomoPreviewMarkup(plan) {
  const blockLabel = plan.focusBlocks === 1 ? 'bloque' : 'bloques';
  const adjustment = plan.adjusted ? '<small>El último descanso se ajustó para respetar la duración total.</small>' : '';
  return `<strong>Vista previa automática</strong><span>• ${plan.focusBlocks} ${blockLabel} de enfoque · ${plan.focusMinutes} min</span><span>• ${plan.shortBreaks} descansos cortos y ${plan.longBreaks} largos · ${plan.breakMinutes} min</span><span>• Duración total exacta: ${plan.total} min</span>${adjustment}`;
}

function updateRoomPomoPreview() {
  const form=$('#roomPomodoroForm'); if(!form)return;
  const settings=syncPomoConstraints(form);
  if(!settings){$('#roomPomoPreview').innerHTML='<strong>Vista previa automática</strong><span>Ingresa una duración total mínima de 5 minutos.</span>';return;}
  $('#roomPomoPreview').innerHTML=pomoPreviewMarkup(buildPomoPlan(settings));
}

function saveRoomPomoSettings() {
  const form=$('#roomPomodoroForm');
  const settings=syncPomoConstraints(form);
  if(!settings||!form.reportValidity())return false;
  state.roomPomo={...settings,goal:form.elements.goal.value.trim()||'Bloque de estudio profundo'};
  $('#roomPomoTime').textContent=`${String(state.roomPomo.focus).padStart(2,'0')}:00`;
  $('#roomPomoGoal').textContent=state.roomPomo.goal;
  return true;
}

function openPersonalPomoSettings(task = null) {
  const taskContext = task && task.id ? task : null;
  state.personalPomoTask = taskContext;
  const saved = state.personalPomo;
  const form = $('#personalPomodoroForm');
  form.elements.total.value = saved.total;
  form.elements.focus.value = state.user.pomodoro_minutes ?? saved.focus;
  form.elements.shortBreak.value = state.user.short_break_minutes ?? saved.shortBreak;
  form.elements.longBreak.value = state.user.long_break_minutes ?? saved.longBreak;
  form.elements.longEvery.value = saved.longEvery;
  form.elements.goal.value = taskContext ? `Tarea: ${taskContext.title}` : saved.goal;
  $('#personalPomoModalTitle').textContent = taskContext ? 'Preparar enfoque para tarea' : 'Personalizar Pomodoro';
  $('#personalPomoModalHint').textContent = taskContext ? `Ajusta la sesión para “${taskContext.title}” o inicia con la configuración actual.` : 'La duración total se reparte entre enfoque y descansos.';
  updatePersonalPomoPreview();
  openModal('personalPomodoroModal');
}

function updatePersonalPomoPreview() {
  const form = $('#personalPomodoroForm');
  if (!form) return;
  const settings = syncPomoConstraints(form);
  if (!settings) { $('#personalPomoPreview').innerHTML='<strong>Vista previa automática</strong><span>Ingresa una duración total mínima de 5 minutos.</span>'; return; }
  $('#personalPomoPreview').innerHTML = pomoPreviewMarkup(buildPomoPlan(settings));
}

async function savePersonalPomoSettings(startAfterSave = false) {
  const form = $('#personalPomodoroForm');
  if (!form.reportValidity()) return;
  const settings = syncPomoConstraints(form);
  const taskContext = state.personalPomoTask;
  const sessionGoal = form.elements.goal.value.trim() || (taskContext ? `Tarea: ${taskContext.title}` : 'Bloque de estudio profundo');
  const sessionPomo = { ...settings, goal:sessionGoal };
  state.personalPomo = {
    ...settings,
    goal:taskContext ? state.personalPomo.goal : sessionGoal
  };
  localStorage.setItem('focurionPersonalPomo', JSON.stringify(state.personalPomo));
  const data = await api('/api/me', { method:'PATCH', body:JSON.stringify({
    pomodoro_minutes:state.personalPomo.focus,
    short_break_minutes:state.personalPomo.shortBreak,
    long_break_minutes:state.personalPomo.longBreak
  }) });
  state.user = data.user;
  setUserUI();
  closeModals();
  toast('Pomodoro personalizado.');
  state.personalPomoTask = null;
  if (startAfterSave) {
    if (taskContext) beginPomoPlan(sessionPomo, 'Tiempo de enfoque', `Pomodoro iniciado para “${taskContext.title}”.`, Number(taskContext.id));
    else startPomodoro();
  }
}

function startRoomPomodoro() {
  if(!saveRoomPomoSettings())return;
  closeModals();
  beginPomoPlan(state.roomPomo, state.roomDetail?.room?.name||'Modo Enfoque Grupal', 'Enfoque grupal iniciado.');
}

async function loadCommunities() {
  const data = await api('/api/communities');
  state.communities = data.communities;
  populateCommunityFilter();
  renderCommunities();
  if (state.activeCommunityId && !$('#communityDetail').classList.contains('hidden')) await openCommunity(state.activeCommunityId, false);
}

function populateCommunityFilter() {
  const current = $('#communityFilter').value;
  const categories = [...new Set(state.communities.map(item => item.category))].sort();
  $('#communityFilter').innerHTML = '<option value="all">Todas las categorías</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  $('#communityFilter').value = categories.includes(current) ? current : 'all';
}

function renderCommunities() {
  const search = $('#communitySearch').value.trim().toLowerCase();
  const filter = state.communityDirectoryFilter || 'all';
  let communities = state.communities.filter(item => `${item.name} ${item.description} ${item.category} ${item.university}`.toLowerCase().includes(search));
  if(filter==='joined')communities=communities.filter(item=>Number(item.joined));
  else if(filter==='recommended')communities=communities.filter(item=>!Number(item.joined));
  else if(filter==='active')communities.sort((a,b)=>Number(b.members)-Number(a.members));
  else if(filter==='new')communities.sort((a,b)=>Number(b.id)-Number(a.id));
  else if(filter!=='all'&&filter!=='México')communities=communities.filter(item=>item.category===filter);
  const joined=communities.filter(item=>Number(item.joined));
  const explore=communities.filter(item=>!Number(item.joined)&&item.status==='active');
  const communityCard=(item,joinedCard=false)=>{
    const pending = item.status && item.status !== 'active';
    const created = Number(item.id) === Number(state.flashCommunityId);
    return `<article class="community-directory-card ${created?'just-created':''}" data-community-id="${item.id}"><div class="community-card-top"><div class="community-initials">${initials(item.name)}</div>${joinedCard?`<span class="new-badge">${Math.max(0,Number(item.posts))} nuevas</span>`:''}</div><h3>${escapeHtml(item.name)}</h3>${joinedCard?'':`<p>${escapeHtml(item.description||'Comunidad académica y tecnológica.')}</p>`}<div class="community-card-meta"><span>${icon('users')} ${item.members} miembros</span><span>•</span><span>${Number(item.posts)||0} publicaciones</span></div><button class="${joinedCard?'community-enter':'room-join-button'}" data-community-action="${item.id}" data-joined="${item.joined}" ${pending&&!item.joined?'disabled':''}>${item.joined?'Entrar':pending?'En revisión':'Unirse'} ${joinedCard?icon('arrowRight'):''}</button>
    </article>`;
  };
  $('#joinedCommunitiesGrid').innerHTML=joined.length?joined.map(item=>communityCard(item,true)).join(''):'<div class="empty-inline">Todavía no te has unido a una comunidad.</div>';
  $('#communitiesGrid').innerHTML=explore.length?explore.map(item=>communityCard(item,false)).join(''):'<div class="empty-inline">No hay comunidades nuevas con esos filtros.</div>';
  const posts=state.communities.reduce((sum,item)=>sum+Number(item.posts||0),0);
  $('#communityActivityMetrics').innerHTML=`<div><strong>${joined.length}</strong><span>Comunidades unidas</span></div><div><strong>${posts}</strong><span>Publicaciones</span></div><div><strong>${Math.max(posts,joined.length*4)}</strong><span>Recursos guardados</span></div><div class="challenge-metric"><strong>${Math.min(9,Math.max(1,joined.length))}</strong><span>Retos activos</span></div>`;
}

async function createCommunity(form) {
  if (form.classList.contains('is-submitting')) return;
  setFormPending(form, true, 'Creando comunidad…');
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.is_private = form.elements.is_private.checked;
    const data = await api('/api/communities', { method:'POST', body:JSON.stringify(payload) });
    state.flashCommunityId = Number(data.community.id);
    state.activeCommunityId = Number(data.community.id);
    form.reset();
    closeModals();
    await loadCommunities();
    toast(data.community.status === 'pending' ? 'Comunidad creada y enviada a revisión.' : 'Comunidad creada correctamente.');
    await openCommunity(data.community.id);
    setTimeout(() => {
      state.flashCommunityId = null;
      document.querySelector(`[data-community-id="${data.community.id}"]`)?.classList.remove('just-created');
    }, 2200);
  } finally {
    setFormPending(form, false);
  }
}

async function communityAction(id, joined) {
  if (!joined) {
    await api(`/api/communities/${id}/join`, { method:'POST', body:'{}' });
    toast('Te uniste a la comunidad.');
    await loadCommunities();
  }
  openCommunity(id);
}

async function openCommunity(id, scroll = true) {
  const data = await api(`/api/communities/${id}/detail`);
  const localCommunity = state.communities.find(item => Number(item.id) === Number(id));
  const community = data.community || localCommunity;
  if (!community) throw new Error('No se pudo cargar la comunidad.');
  state.activeCommunityId = Number(id);
  state.communityDetail=data;
  $('#communitiesLanding').classList.add('hidden'); $('#communityDetail').classList.remove('hidden');
  $('#communityMonogram').textContent=initials(community.name);
  $('#communityDetailName').textContent=community.name;
  $('#communityDetailDescription').textContent=community.description||`${community.category} · ${community.university}`;
  $('#communityDetailStats').innerHTML=`<span>${icon('users')}<b>${community.members}</b> miembros</span><span>${icon('network')}<b>${community.rooms}</b> salas activas</span><span>${icon('folder')}<b>${community.resources}</b> recursos</span><span class="challenge-stat">${icon('trending')}<b>${data.challenges.length}</b> retos activos</span>`;
  renderCommunityTab(state.activeCommunityTab||'home');
  history.replaceState(null,'',`#communities/${community.id}`);
  if(scroll)window.scrollTo({top:0,behavior:'smooth'});
}

function closeCommunityDetail(){state.activeCommunityId=null;state.communityDetail=null;$('#communityDetail').classList.add('hidden');$('#communitiesLanding').classList.remove('hidden');history.replaceState(null,'','#communities');}

function renderPostsMarkup(posts) {
  return posts.length ? posts.map(post => `<article class="community-post-card">
    <div class="post-author"><div class="avatar avatar-sm">${initials(post.name)}</div><div><strong>${escapeHtml(post.name)}</strong><small>${timeAgo(post.created_at)}</small></div></div>
    <div class="post-content">${escapeHtml(post.content)}</div>
    <div class="post-actions" data-post-actions="${post.id}"><button type="button" class="${Number(post.liked)?'active':''}" data-post-action="like" aria-pressed="${Number(post.liked)?'true':'false'}">${icon('heart')} <span>Me gusta</span><b class="post-like-count">${Number(post.like_count)||''}</b></button><button type="button" data-post-action="comment">${icon('message')} <span>Comentar</span></button><button type="button" class="${Number(post.saved)?'active':''}" data-post-action="save" aria-pressed="${Number(post.saved)?'true':'false'}">${icon('bookmark')} <span>${Number(post.saved)?'Guardado':'Guardar'}</span></button><button type="button" data-post-action="share">${icon('share')} <span>Compartir</span></button></div>
    <div class="comments">${(post.comments||[]).map(comment => `<div class="comment"><div class="avatar avatar-sm">${initials(comment.name)}</div><div class="comment-body"><div class="comment-meta"><strong>${escapeHtml(comment.name)}</strong><span>${timeAgo(comment.created_at)}</span></div><p>${escapeHtml(comment.content)}</p></div></div>`).join('')}
      <form class="comment-form" data-post-id="${post.id}"><input name="content" placeholder="Escribe un comentario…" required><button class="btn btn-secondary btn-small">Enviar</button></form>
    </div>
  </article>`).join('') : '<div class="empty-inline">Todavía no hay publicaciones.</div>';
}

function syncPostReactionUI(post) {
  const actions = $(`[data-post-actions="${post.id}"]`);
  if (!actions) return;
  const like = $('[data-post-action="like"]', actions);
  const save = $('[data-post-action="save"]', actions);
  if (like) {
    like.classList.toggle('active', Boolean(Number(post.liked)));
    like.setAttribute('aria-pressed', Number(post.liked) ? 'true' : 'false');
    const count = $('.post-like-count', like);
    if (count) count.textContent = Number(post.like_count) || '';
  }
  if (save) {
    save.classList.toggle('active', Boolean(Number(post.saved)));
    save.setAttribute('aria-pressed', Number(post.saved) ? 'true' : 'false');
    const label = $('span', save);
    if (label) label.textContent = Number(post.saved) ? 'Guardado' : 'Guardar';
  }
}

async function togglePostReaction(postId, action) {
  const post = state.communityDetail?.posts?.find(item => Number(item.id) === Number(postId));
  if (!post || !['like','save'].includes(action)) return;
  const property = action === 'like' ? 'liked' : 'saved';
  const previous = Number(post[property]) ? 1 : 0;
  const previousLikes = Number(post.like_count || 0);
  post[property] = previous ? 0 : 1;
  if (action === 'like') post.like_count = Math.max(0, previousLikes + (post.liked ? 1 : -1));
  syncPostReactionUI(post);
  try {
    const data = await api(`/api/posts/${post.id}/${action}`, { method:'POST' });
    if (action === 'like') {
      post.liked = data.liked ? 1 : 0;
      post.like_count = Number(data.like_count || 0);
      toast(post.liked ? 'Publicación marcada con Me gusta.' : 'Me gusta retirado.');
    } else {
      post.saved = data.saved ? 1 : 0;
      toast(post.saved ? 'Publicación guardada.' : 'Publicación eliminada de guardados.');
    }
    syncPostReactionUI(post);
  } catch (error) {
    post[property] = previous;
    if (action === 'like') post.like_count = previousLikes;
    syncPostReactionUI(post);
    throw error;
  }
}

function renderCommunityTab(tab) {
  if(!state.communityDetail)return;
  state.activeCommunityTab=tab;
  $$('#communityTabs button').forEach(button=>button.classList.toggle('active',button.dataset.communityTab===tab));
  const d=state.communityDetail, c=d.community;
  const action=(modal,label)=>`<button class="btn btn-primary btn-small" data-open-modal="${modal}">${icon('plus')} ${label}</button>`;
  let html='';
  if(tab==='home')html=`<div class="community-home-layout"><div><article class="panel recent-activity"><h2>${icon('trending')} Actividad reciente</h2>${d.posts.slice(0,3).map(p=>`<p><span>${icon('message')}</span><b>${escapeHtml(p.name)}</b> publicó: ${escapeHtml(p.content.slice(0,90))}</p>`).join('')||'<p>Sin actividad reciente.</p>'}</article>${d.challenges[0]?`<article class="featured-challenge"><span>Publicación destacada</span><h2>Reto semanal: ${escapeHtml(d.challenges[0].title)}</h2><p>${escapeHtml(d.challenges[0].description)}</p><button class="btn btn-gradient btn-block" data-community-tab-jump="challenges">Ver reto</button></article>`:''}</div><aside><article class="panel"><h2>Recursos populares</h2>${d.resources.slice(0,4).map(r=>`<a class="side-resource" href="${escapeHtml(r.url)}" target="_blank">${icon('file')} ${escapeHtml(r.title)}</a>`).join('')||'<p class="muted-copy">Sin recursos.</p>'}</article><article class="panel"><h2>Salas activas</h2>${d.rooms.slice(0,4).map(r=>`<button class="side-room" data-community-room="${r.id}" data-joined="${r.joined}"><span>${escapeHtml(r.name)}</span><b>${r.members} activos</b></button>`).join('')||'<p class="muted-copy">Sin salas activas.</p>'}</article></aside></div>`;
  if(tab==='posts')html=`<div class="tab-heading">${action('communityPostModal','Crear publicación')}</div><div class="community-posts-column"><button class="post-composer" data-open-modal="communityPostModal"><span class="avatar avatar-sm">${initials(state.user.name)}</span><span>Comparte una duda, recurso, avance o proyecto…</span>${icon('send')}</button>${renderPostsMarkup(d.posts)}</div>`;
  if(tab==='resources')html=`<div class="tab-heading"><div class="filter-chips"><button class="active">Todos</button><button>Links</button><button>PDFs</button><button>Repositorios</button><button>Videos</button><button>Apuntes</button></div>${action('communityResourceModal','Compartir recurso')}</div><div class="community-resource-grid">${d.resources.map(r=>`<article class="community-resource-card"><span class="resource-icon">${icon(r.resource_type==='repository'?'folder':r.resource_type==='video'?'play':'file')}</span><h3>${escapeHtml(r.title)}</h3><b>${escapeHtml(r.resource_type)}</b><p>Compartido por: <strong>${escapeHtml(r.name)}</strong></p><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Abrir</a></article>`).join('')||'<div class="empty-inline">No hay recursos.</div>'}</div>`;
  if(tab==='projects')html=`<div class="tab-heading">${action('communityProjectModal','Publicar proyecto')}</div><div class="community-project-grid">${d.projects.map(p=>`<article class="community-project-card"><div><span class="resource-icon">${icon('folder')}</span><span class="project-status ${p.status}">${p.status==='completed'?'Terminado':p.status==='review'?'En revisión':'En desarrollo'}</span></div><h3>${escapeHtml(p.title)}</h3><p>Autor: <strong>${escapeHtml(p.name)}</strong></p><code>Stack: ${escapeHtml(p.stack||'Por definir')}</code>${p.project_url?`<a href="${escapeHtml(p.project_url)}" target="_blank">Ver proyecto</a>`:`<button type="button" data-project-preview="${p.id}">Ver proyecto</button>`}</article>`).join('')||'<div class="empty-inline">No hay proyectos.</div>'}</div>`;
  if(tab==='rooms')html=`<div class="tab-heading"><button class="btn btn-primary btn-small" data-open-modal="roomModal" data-community-context>${icon('plus')} Crear sala en esta comunidad</button></div><div class="community-room-grid">${d.rooms.map(r=>`<article><div><span class="resource-icon">${icon('network')}</span><span class="active-pill"><i></i>${r.members} activos</span></div><h3>${escapeHtml(r.name)}</h3><button data-community-room="${r.id}" data-joined="${r.joined}">${r.joined?'Entrar':'Unirse'}</button></article>`).join('')||'<div class="empty-inline">No hay salas.</div>'}</div>`;
  if(tab==='challenges')html=`<div class="tab-heading">${['admin','moderator'].includes(state.user.role)||Number(c.owner_id)===Number(state.user.id)?action('communityChallengeModal','Crear reto'):''}</div><div class="challenge-grid">${d.challenges.map(ch=>`<article><div><span class="challenge-icon">${icon('trending')}</span><b>+${ch.xp} XP</b></div><h3>${escapeHtml(ch.title)}</h3><dl><dt>Dificultad:</dt><dd>${escapeHtml(ch.difficulty)}</dd><dt>Tiempo estimado:</dt><dd>${escapeHtml(ch.estimated_time)}</dd></dl><button data-join-challenge="${ch.id}">Participar</button></article>`).join('')||'<div class="empty-inline">No hay retos activos.</div>'}</div>`;
  if(tab==='members')html=`<div class="member-toolbar"><div class="search-field"><span>${icon('search')}</span><input id="memberSearch" placeholder="Buscar miembro…"></div><div class="filter-chips"><button class="active">Todos</button><button>Más activos</button><button>Moderadores</button><button>Nuevos</button></div></div><div class="community-members-list">${d.members.map(m=>`<article data-member-name="${escapeHtml(m.name.toLowerCase())}"><div class="avatar" style="background:${escapeHtml(m.avatar_color||'#6d5dfc')}">${initials(m.name)}</div><div><h3>${escapeHtml(m.name)}</h3><p>${escapeHtml(m.university)} · ${escapeHtml(m.career)}</p></div><b>${m.xp} XP</b><button data-member-action="follow" data-member="${m.id}">Seguir</button><button data-member-action="invite" data-member="${m.id}">Invitar</button></article>`).join('')}</div>`;
  $('#communityTabContent').innerHTML=html; FocurionIcons.hydrate($('#communityTabContent'));
}

async function createPost() {
  const content = $('#communityPostForm').elements.content.value.trim();
  if (!state.activeCommunityId || !content) return;
  await api(`/api/communities/${state.activeCommunityId}/posts`, { method:'POST', body:JSON.stringify({ content }) });
  $('#communityPostForm').reset(); closeModals();
  toast('Publicación creada.');
  await openCommunity(state.activeCommunityId, false);
  renderCommunityTab('posts');
}

async function createComment(postId, content) {
  await api(`/api/posts/${postId}/comments`, { method:'POST', body:JSON.stringify({ content }) });
  toast('Comentario agregado.');
  await openCommunity(state.activeCommunityId, false);
  renderCommunityTab('posts');
}

async function createCommunityResource(form){await api(`/api/communities/${state.activeCommunityId}/resources`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});form.reset();closeModals();toast('Recurso compartido.');await openCommunity(state.activeCommunityId,false);renderCommunityTab('resources');}
async function createCommunityProject(form){await api(`/api/communities/${state.activeCommunityId}/projects`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});form.reset();closeModals();toast('Proyecto publicado.');await openCommunity(state.activeCommunityId,false);renderCommunityTab('projects');}
async function createCommunityChallenge(form){await api(`/api/communities/${state.activeCommunityId}/challenges`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});form.reset();closeModals();toast('Reto creado.');await openCommunity(state.activeCommunityId,false);renderCommunityTab('challenges');}

async function loadAiHistory() {
  const data = await api('/api/ai/history');
  $('#aiHistory').innerHTML = data.history.length ? data.history.map(item => `<div class="history-item" data-ai-prompt="${escapeHtml(item.prompt)}"><strong>${escapeHtml(item.prompt.slice(0,65))}</strong><span>${escapeHtml(item.mode)} · ${timeAgo(item.created_at)}</span></div>`).join('') : '<div class="empty-inline">Aún no hay consultas.</div>';
}

async function askAi() {
  const prompt = $('#aiPrompt').value.trim();
  if (!prompt) return;
  addAiMessage('user', state.user.name, prompt);
  $('#aiPrompt').value = '';
  const loading = addAiMessage('assistant', 'Focurion AI', 'Analizando localmente…', true);
  try {
    const data = await api('/api/ai', { method:'POST', body:JSON.stringify({ prompt, mode:state.aiMode }) });
    loading.querySelector('p').textContent = data.response;
    await loadAiHistory();
  } catch (error) {
    loading.querySelector('p').textContent = error.message;
  }
}

function addAiMessage(kind, name, content, loading = false) {
  const message = document.createElement('div');
  message.className = `chat-message ${kind}${loading ? ' loading' : ''}`;
  message.innerHTML = `<div class="avatar avatar-sm">${kind === 'assistant' ? '✦' : initials(name)}</div><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(content)}</p></div>`;
  $('#aiMessages').append(message);
  $('#aiMessages').scrollTop = $('#aiMessages').scrollHeight;
  return message;
}

async function loadRanking() {
  const data = await api('/api/ranking');
  state.ranking = data;
  $('#rankingTable').innerHTML = data.users.map((user,index) => `<tr class="${user.id === state.user.id ? 'me-row' : ''}" data-ranking-user="${user.id}"><td><span class="table-position ${index === 0 ? 'gold' : ''}">${index+1}</span></td><td><div class="table-user"><div class="avatar avatar-sm">${initials(user.name)}</div><strong>${escapeHtml(user.name)}</strong></div></td><td>${escapeHtml(user.university)}</td><td><strong style="color:#55caed">${user.xp} XP</strong></td><td>${user.streak} días 🔥</td></tr>`).join('');
  const position = data.users.findIndex(user => user.id === state.user.id) + 1;
  const level = Math.max(1, Math.floor(state.user.xp / 100));
  $('#rankingProfile').innerHTML = `<div class="avatar avatar-xl">${initials(state.user.name)}</div><h2>${escapeHtml(state.user.name)}</h2><p style="color:var(--muted)">Posición #${position || '—'}</p><div class="level-badge">Nivel ${level}</div><strong>${state.user.xp} XP</strong><div class="progress-bar" style="margin-top:14px"><span style="width:${state.user.xp % 100}%"></span></div>`;
  $('#universityRanking').innerHTML = data.universities.map((item,index) => `<div class="ranking-mini-row"><b>${index+1}</b><strong>${escapeHtml(item.university)}</strong><span>${item.xp} XP</span></div>`).join('');
}

async function loadEvents() {
  const data = await api('/api/events');
  state.events = data.events;
  renderCalendar();
}

function renderCalendar() {
  const cursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth(), 1);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  $('#calendarTitle').textContent = new Intl.DateTimeFormat('es-MX', { month:'long', year:'numeric' }).format(cursor);
  const firstGrid = new Date(year, month, 1 - cursor.getDay());
  const todayKey = new Date().toISOString().slice(0,10);
  const cells = [];
  for (let index = 0; index < 42; index++) {
    const day = new Date(firstGrid);
    day.setDate(firstGrid.getDate() + index);
    const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
    const dayEvents = state.events.filter(event => event.start_date === key);
    cells.push(`<div class="calendar-day ${day.getMonth() !== month ? 'outside' : ''} ${key === todayKey ? 'today' : ''} ${key === state.calendarSelectedDate ? 'selected-date' : ''}" data-calendar-date="${key}"><div class="day-number">${day.getDate()}</div>${dayEvents.slice(0,3).map(event => `<button class="day-event" style="background:${escapeHtml(event.color)}" title="${escapeHtml(event.title)}" data-event-id="${event.id}">${escapeHtml(event.title)}</button>`).join('')}</div>`);
  }
  $('#calendarGrid').innerHTML = cells.join('');
  const upcoming = state.events.filter(event => event.start_date >= todayKey).sort((a,b) => a.start_date.localeCompare(b.start_date)).slice(0,8);
  $('#calendarUpcoming').innerHTML = upcoming.length ? upcoming.map(event => {
    const owned = Number(event.user_id) === Number(state.user.id);
    const action = owned ? `<button class="link-btn" data-delete-event="${event.id}">Eliminar</button>` : '<span class="event-readonly-label">Oficial</span>';
    return `<div class="task-row calendar-upcoming-row" data-edit-event="${event.id}" role="button" tabindex="0" aria-label="${owned ? 'Editar' : 'Ver'} evento ${escapeHtml(event.title)}"><span style="width:5px;height:34px;border-radius:9px;background:${escapeHtml(event.color)}"></span><div class="task-copy"><strong>${escapeHtml(event.title)}</strong><small>${formatDate(event.start_date, { weekday:'long', day:'numeric', month:'long' })}</small></div>${action}<span></span></div>`;
  }).join('') : '<div class="empty-inline">No hay eventos próximos.</div>';
}

function setEventFormMode(calendarEvent = null, date = '') {
  const form = $('#eventForm');
  form.reset();
  const owned = calendarEvent && Number(calendarEvent.user_id) === Number(state.user.id);
  const editable = !calendarEvent || owned;
  form.elements.event_id.value = calendarEvent?.id || '';
  if (calendarEvent) {
    form.elements.title.value = calendarEvent.title || '';
    form.elements.description.value = calendarEvent.description || '';
    form.elements.start_date.value = calendarEvent.start_date || '';
    form.elements.color.value = calendarEvent.color || '#5b8cff';
  } else {
    form.elements.start_date.value = date;
    form.elements.color.value = '#5b8cff';
  }
  ['title','description','start_date','color'].forEach(name => { form.elements[name].disabled = !editable; });
  $('#eventDatePickerButton').disabled = !editable;
  $('#eventModalTitle').textContent = !calendarEvent ? 'Agregar evento' : owned ? 'Editar evento' : 'Detalles del evento';
  $('#eventModalHint').textContent = !calendarEvent ? 'Completa los datos para guardar una nueva fecha.' : owned ? 'Actualiza la información de este evento.' : 'Este es un evento oficial y está disponible en modo de solo lectura.';
  $('#deleteEventButton').classList.toggle('hidden', !owned);
  $('#eventSubmitButton').classList.toggle('hidden', !editable);
  $('#eventSubmitButton').innerHTML = `${icon('check')} ${calendarEvent ? 'Guardar cambios' : 'Guardar evento'}`;
  openModal('eventModal');
}

function openNewEvent(date = '') { setEventFormMode(null, date); }

function openEventEditor(id) {
  const calendarEvent = (state.events || []).find(item => Number(item.id) === Number(id));
  if (!calendarEvent) return toast('No se encontró el evento seleccionado.', 'error');
  setEventFormMode(calendarEvent);
}

async function saveEvent(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const id = payload.event_id;
  delete payload.event_id;
  payload.end_date = payload.start_date;
  await api(id ? `/api/events/${id}` : '/api/events', { method:id ? 'PATCH' : 'POST', body:JSON.stringify(payload) });
  form.reset(); closeModals(); toast(id ? 'Evento actualizado.' : 'Evento agregado.'); await Promise.all([loadEvents(),loadDashboard()]);
}

async function deleteEvent(id) {
  if (!confirm('¿Eliminar este evento?')) return;
  await api(`/api/events/${id}`, { method:'DELETE' });
  closeModals();
  toast('Evento eliminado.');
  await Promise.all([loadEvents(),loadDashboard()]);
}

function fillSettings() {
  const form = $('#settingsForm');
  ['name','university','career','theme','language','timezone','pomodoro_minutes','short_break_minutes','long_break_minutes','weekly_goal_hours'].forEach(key => {
    if (form.elements[key]) form.elements[key].value = state.user[key] ?? '';
  });
  form.elements.notifications.checked = Boolean(state.user.notifications);
  form.elements.sidebar_behavior.value = state.sidebarMode;
  $('#settingsNamePreview').textContent = state.user.name;
  $('#settingsEmail').textContent = state.user.email;
}

async function saveSettings() {
  const form = $('#settingsForm');
  const payload = Object.fromEntries(new FormData(form).entries());
  const sidebarMode = payload.sidebar_behavior;
  delete payload.sidebar_behavior;
  payload.notifications = form.elements.notifications.checked;
  const data = await api('/api/me', { method:'PATCH', body:JSON.stringify(payload) });
  state.user = data.user;
  applySidebarMode(sidebarMode, true);
  setUserUI();
  toast('Configuración guardada.');
}

async function changePassword() {
  const currentPassword = $('#currentPassword').value;
  const newPassword = $('#newPassword').value;
  if (!currentPassword || newPassword.length < 8) return toast('Completa ambas contraseñas; la nueva debe tener 8 caracteres.', 'error');
  await api('/api/me/password', { method:'POST', body:JSON.stringify({ currentPassword,newPassword }) });
  $('#currentPassword').value = '';
  $('#newPassword').value = '';
  toast('Contraseña actualizada.');
}

function adminBadge(status) {
  const labels = { active:'Activo', pending:'Pendiente', suspended:'Suspendido', closed:'Cerrada', scheduled:'Programado', rejected:'Rechazado', completed:'Completado', resolved:'Resuelto', dismissed:'Descartado' };
  return `<span class="admin-status ${escapeHtml(status || 'pending')}">${escapeHtml(labels[status] || status || 'Pendiente')}</span>`;
}

function adminEmpty(message = 'No hay datos disponibles.') {
  return `<tr><td colspan="9"><div class="empty-inline">${escapeHtml(message)}</div></td></tr>`;
}

async function loadAdmin() {
  if (!['admin','moderator'].includes(state.user.role)) return;
  showAdminTab(state.admin.tab || 'dashboard');
}

function showAdminTab(tab) {
  state.admin.tab = tab;
  if (window.innerWidth <= 880) $('#sidebar')?.classList.remove('open');
  $$('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.adminTab === tab));
  $$('[data-admin-side-tab]').forEach(button => button.classList.toggle('active', button.dataset.adminSideTab === tab));
  $$('[data-admin-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.adminPanel === tab));
  const loaders = {
    dashboard: loadAdminDashboard,
    users: loadAdminUsers,
    communities: loadAdminCommunities,
    rooms: loadAdminRooms,
    events: loadAdminEvents,
    reports: loadAdminReports,
    moderation: loadAdminModeration,
    settings: loadAdminSettings
  };
  loaders[tab]?.().catch(error => toast(error.message, 'error'));
}

async function loadAdminDashboard() {
  const data = await api('/api/admin/overview');
  $('#adminMetrics').innerHTML = [
    metricCard('users', data.metrics.users.toLocaleString('es-MX'), 'Usuarios registrados', '#4b8cff'),
    metricCard('network', data.metrics.communities, 'Comunidades activas', '#a15cff'),
    metricCard('message', data.metrics.rooms, 'Salas colaborativas', '#2dd4bf'),
    metricCard('calendar', data.metrics.events, 'Eventos programados', '#ffb84b')
  ].join('');
  const max = Math.max(1, ...data.activity.map(item => item.total));
  $('#adminActivityChart').innerHTML = data.activity.map(item => `<div class="activity-column"><span style="height:${Math.max(10, Math.round(item.total / max * 100))}%"></span><small>${formatDate(item.date,{weekday:'short'})}</small><b>${item.total}</b></div>`).join('');
  $('#adminRecentUsers').innerHTML = data.recentUsers.length ? data.recentUsers.map(user => `<tr><td><div class="table-user"><div class="avatar avatar-sm">${initials(user.name)}</div><strong>${escapeHtml(user.name)}</strong></div></td><td>${escapeHtml(user.university)}</td><td>${escapeHtml(user.role)}</td><td>${adminBadge(user.status)}</td><td>${user.xp}</td></tr>`).join('') : adminEmpty();
  $('#adminRecentActivity').innerHTML = data.recentActivity.length ? data.recentActivity.map(item => `<div class="history-item"><strong>${escapeHtml(item.name || 'Sistema')}</strong><span>${escapeHtml(item.action)}</span><small>${timeAgo(item.created_at)}</small></div>`).join('') : '<div class="empty-inline">Sin actividad reciente.</div>';
  $('#adminAlerts').innerHTML = [
    `<button data-admin-go="moderation"><span>Reportes pendientes</span><b>${data.alerts.reports}</b></button>`,
    `<button data-admin-go="communities"><span>Comunidades por revisar</span><b>${data.alerts.communities}</b></button>`,
    `<button data-admin-go="rooms"><span>Solicitudes de sala</span><b>${data.alerts.rooms}</b></button>`
  ].join('');
}

async function loadAdminUsers() {
  const data = await api('/api/admin/users');
  state.admin.users = data.users;
  renderAdminUsers();
}

function renderAdminUsers() {
  const query = ($('#adminUserSearch')?.value || '').toLowerCase();
  const status = $('#adminUserStatus')?.value || 'all';
  const users = state.admin.users.filter(user => (!query || `${user.name} ${user.email} ${user.university}`.toLowerCase().includes(query)) && (status === 'all' || user.status === status));
  $('#adminUsersTable').innerHTML = users.length ? users.map(user => `<tr data-admin-user="${user.id}"><td><div class="table-user"><div class="avatar avatar-sm">${initials(user.name)}</div><strong>${escapeHtml(user.name)}</strong></div></td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.university)}</td><td><select data-admin-role><option value="student" ${user.role==='student'?'selected':''}>Estudiante</option><option value="moderator" ${user.role==='moderator'?'selected':''}>Moderador</option><option value="admin" ${user.role==='admin'?'selected':''}>Admin</option></select></td><td><select data-admin-status><option value="active" ${user.status==='active'?'selected':''}>Activo</option><option value="pending" ${user.status==='pending'?'selected':''}>Pendiente</option><option value="suspended" ${user.status==='suspended'?'selected':''}>Suspendido</option></select></td><td><input data-admin-xp type="number" min="0" value="${user.xp}" style="width:90px"></td><td><div class="row-actions"><button data-save-admin title="Guardar">✓</button><button data-delete-admin title="Eliminar">×</button></div></td></tr>`).join('') : adminEmpty('No se encontraron usuarios.');
}

async function createAdminUser(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});
  form.reset(); closeModals(); toast('Usuario registrado.'); await Promise.all([loadAdminUsers(), loadAdminDashboard()]);
}

async function saveAdminUser(row) {
  const id = row.dataset.adminUser;
  const payload = { role:$('[data-admin-role]',row).value, status:$('[data-admin-status]',row).value, xp:Number($('[data-admin-xp]',row).value) };
  await api(`/api/admin/users/${id}`, { method:'PATCH', body:JSON.stringify(payload) });
  toast('Usuario actualizado.'); await loadAdminUsers();
}

async function deleteAdminUser(row) {
  if (!confirm('¿Eliminar definitivamente este usuario y todos sus datos?')) return;
  await api(`/api/admin/users/${row.dataset.adminUser}`, { method:'DELETE' });
  toast('Usuario eliminado.'); await Promise.all([loadAdminUsers(), loadAdminDashboard()]);
}

async function loadAdminCommunities() {
  const data = await api('/api/admin/communities');
  state.admin.communities = data.communities;
  renderAdminCommunities();
  const options = data.communities.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  if ($('#adminRoomCommunity')) $('#adminRoomCommunity').innerHTML = `<option value="">Sin comunidad</option>${options}`;
  if ($('#adminEventCommunity')) $('#adminEventCommunity').innerHTML = `<option value="">General</option>${options}`;
}

function renderAdminCommunities() {
  const query = ($('#adminCommunitySearch')?.value || '').toLowerCase();
  const status = $('#adminCommunityStatus')?.value || 'all';
  const rows = state.admin.communities.filter(item => (!query || `${item.name} ${item.university}`.toLowerCase().includes(query)) && (status === 'all' || item.status === status));
  $('#adminCommunitiesTable').innerHTML = rows.length ? rows.map(item => `<tr data-admin-community="${item.id}"><td><div class="table-user"><div class="entity-icon">♧</div><strong>${escapeHtml(item.name)}</strong></div></td><td>${escapeHtml(item.university)}</td><td>${item.members}</td><td>${item.rooms}</td><td><select data-community-status><option value="active" ${item.status==='active'?'selected':''}>Activa</option><option value="pending" ${item.status==='pending'?'selected':''}>Pendiente</option><option value="suspended" ${item.status==='suspended'?'selected':''}>Suspendida</option></select></td><td><div class="row-actions"><button data-save-community title="Guardar">✓</button><button data-delete-community title="Eliminar">×</button></div></td></tr>`).join('') : adminEmpty('No se encontraron comunidades.');
}

async function createAdminCommunity(form) {
  if (form.classList.contains('is-submitting')) return;
  setFormPending(form, true, 'Creando comunidad…');
  try {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.is_private = form.elements.is_private.checked;
    await api('/api/admin/communities',{method:'POST',body:JSON.stringify(payload)});
    form.reset();
    closeModals();
    toast('Comunidad creada y visible en el panel.');
    await Promise.all([loadAdminCommunities(),loadAdminDashboard()]);
  } finally {
    setFormPending(form, false);
  }
}

async function updateAdminCommunity(row) {
  await api(`/api/admin/communities/${row.dataset.adminCommunity}`,{method:'PATCH',body:JSON.stringify({status:$('[data-community-status]',row).value})}); toast('Comunidad actualizada.'); await loadAdminCommunities();
}

async function deleteAdminCommunity(row) {
  if(!confirm('¿Eliminar esta comunidad con sus salas y publicaciones?'))return; await api(`/api/admin/communities/${row.dataset.adminCommunity}`,{method:'DELETE'}); toast('Comunidad eliminada.'); await Promise.all([loadAdminCommunities(),loadAdminDashboard()]);
}

async function loadAdminRooms() {
  const [roomData] = await Promise.all([api('/api/admin/rooms'), state.admin.communities.length ? Promise.resolve() : loadAdminCommunities()]);
  state.admin.rooms = roomData.rooms; renderAdminRooms();
}

function renderAdminRooms() {
  const query = ($('#adminRoomSearch')?.value || '').toLowerCase(); const status = $('#adminRoomStatus')?.value || 'all';
  const rows = state.admin.rooms.filter(item => (!query || `${item.name} ${item.community_name||''} ${item.category}`.toLowerCase().includes(query)) && (status === 'all' || item.status === status));
  $('#adminRoomsTable').innerHTML = rows.length ? rows.map(item => `<tr data-admin-room="${item.id}"><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.community_name||'Sin comunidad')}</td><td>${escapeHtml(item.category)}</td><td>${item.is_private?'Privada':'Pública'}</td><td>${item.active_users}</td><td><select data-room-status><option value="active" ${item.status==='active'?'selected':''}>Activa</option><option value="pending" ${item.status==='pending'?'selected':''}>Pendiente</option><option value="closed" ${item.status==='closed'?'selected':''}>Cerrada</option></select></td><td><div class="row-actions"><button data-save-room>✓</button><button data-delete-room>×</button></div></td></tr>`).join('') : adminEmpty('No se encontraron salas.');
}

async function createAdminRoom(form) {
  const payload=Object.fromEntries(new FormData(form).entries()); await api('/api/admin/rooms',{method:'POST',body:JSON.stringify(payload)}); form.reset(); closeModals(); toast('Sala creada.'); await Promise.all([loadAdminRooms(),loadAdminDashboard()]);
}

async function updateAdminRoom(row) { await api(`/api/admin/rooms/${row.dataset.adminRoom}`,{method:'PATCH',body:JSON.stringify({status:$('[data-room-status]',row).value})}); toast('Sala actualizada.'); await loadAdminRooms(); }
async function deleteAdminRoom(row) { if(!confirm('¿Eliminar esta sala?'))return; await api(`/api/admin/rooms/${row.dataset.adminRoom}`,{method:'DELETE'}); toast('Sala eliminada.'); await Promise.all([loadAdminRooms(),loadAdminDashboard()]); }

async function loadAdminEvents() {
  if (!state.admin.communities.length) await loadAdminCommunities();
  const data=await api('/api/admin/events'); state.admin.events=data.events; renderAdminEvents();
}

function renderAdminEvents() {
  const query=($('#adminEventSearch')?.value||'').toLowerCase(); const status=$('#adminEventStatus')?.value||'all';
  const rows=state.admin.events.filter(item=>(!query||`${item.title} ${item.community_name||''} ${item.type}`.toLowerCase().includes(query))&&(status==='all'||item.status===status));
  $('#adminEventsTable').innerHTML=rows.length?rows.map(item=>`<tr data-admin-event="${item.id}"><td><strong>${escapeHtml(item.title)}</strong></td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.community_name||'General')}</td><td>${formatDate(item.start_date)} ${escapeHtml(item.start_time||'')}</td><td>${adminBadge(item.status)}</td><td><div class="row-actions">${item.status==='pending'?'<button data-approve-event title="Aprobar">✓</button><button data-reject-event title="Rechazar">−</button>':''}<button data-delete-admin-event title="Eliminar">×</button></div></td></tr>`).join(''):adminEmpty('No se encontraron eventos.');
  const requests=state.admin.events.filter(item=>item.status==='pending');
  $('#adminEventRequests').innerHTML=requests.length?requests.map(item=>`<div class="request-card" data-admin-event="${item.id}"><strong>${escapeHtml(item.community_name||item.creator_name)}</strong><p>solicitó “${escapeHtml(item.title)}”</p><small>${formatDate(item.start_date)}</small><div><button class="btn btn-primary btn-small" data-approve-event>Revisar y aprobar</button><button class="icon-btn" data-reject-event>×</button></div></div>`).join(''):'<div class="empty-inline">No hay solicitudes pendientes.</div>';
  const active=state.admin.events.filter(e=>e.status==='active').length, scheduled=state.admin.events.filter(e=>e.status==='scheduled').length, pending=requests.length;
  $('#adminEventMetrics').innerHTML=[metricCard('play',active,'Eventos activos','#2dd4bf'),metricCard('calendar',scheduled,'Programados','#4b8cff'),metricCard('network',new Set(state.admin.events.map(e=>e.community_id).filter(Boolean)).size,'Comunidades participantes','#a15cff'),metricCard('bell',pending,'Solicitudes pendientes','#ffb84b')].join('');
}

async function createAdminEvent(form) { const payload=Object.fromEntries(new FormData(form).entries()); payload.is_official=form.elements.is_official.checked; await api('/api/admin/events',{method:'POST',body:JSON.stringify(payload)}); form.reset(); closeModals(); toast('Evento creado.'); await Promise.all([loadAdminEvents(),loadAdminDashboard()]); }
async function reviewAdminEvent(id,action){await api(`/api/admin/events/${id}/review`,{method:'POST',body:JSON.stringify({action})});toast(action==='approve'?'Evento aprobado.':'Evento rechazado.');await Promise.all([loadAdminEvents(),loadAdminDashboard()]);}
async function deleteAdminEvent(id){if(!confirm('¿Eliminar este evento?'))return;await api(`/api/admin/events/${id}`,{method:'DELETE'});toast('Evento eliminado.');await loadAdminEvents();}

async function loadAdminReports() {
  const data=await api('/api/admin/reports'); state.admin.reports=data;
  $('#adminReportMetrics').innerHTML=[metricCard('users',data.summary.activeUsers,'Usuarios activos','#4b8cff'),metricCard('clock',data.summary.pomodoros,'Pomodoros totales','#a15cff'),metricCard('message',data.summary.activeRooms,'Salas activas','#2dd4bf'),metricCard('network',data.summary.topCommunity,'Comunidad top','#ffb84b')].join('');
  const userMax=Math.max(1,...data.usersSeries.map(i=>i.total)); $('#adminUsersChart').innerHTML=data.usersSeries.map(i=>`<div><span style="height:${Math.max(8,i.total/userMax*100)}%"></span><small>${escapeHtml(i.label)}</small><b>${i.total}</b></div>`).join('');
  const communityMax=Math.max(1,...data.communityParticipation.map(i=>i.total)); $('#adminCommunityChart').innerHTML=data.communityParticipation.map(i=>`<div><label>${escapeHtml(i.name)}</label><span><i style="width:${i.total/communityMax*100}%"></i></span><b>${i.total}</b></div>`).join('');
  $('#adminTopCategories').innerHTML=data.topCategories.map((i,n)=>`<div class="ranking-mini-row"><b>${n+1}</b><strong>${escapeHtml(i.category)}</strong><span>${i.total}</span></div>`).join('');
  $('#adminTopUsers').innerHTML=data.topUsers.map((i,n)=>`<div class="ranking-mini-row"><b>${n+1}</b><strong>${escapeHtml(i.name)}</strong><span>${i.xp} XP</span></div>`).join('');
}

async function loadAdminModeration() { const data=await api('/api/admin/moderation'); state.admin.moderation=data.reports; renderAdminModeration(); }
function renderAdminModeration(){const query=($('#adminModerationSearch')?.value||'').toLowerCase(),status=$('#adminModerationStatus')?.value||'all';const rows=state.admin.moderation.filter(i=>(!query||`${i.entity_name} ${i.reason} ${i.entity_type}`.toLowerCase().includes(query))&&(status==='all'||i.status===status));$('#adminModerationTable').innerHTML=rows.length?rows.map(i=>`<tr data-admin-report="${i.id}"><td>${escapeHtml(i.entity_type)}</td><td><strong>${escapeHtml(i.entity_name)}</strong></td><td>${escapeHtml(i.reason)}</td><td>${timeAgo(i.created_at)}</td><td>${adminBadge(i.status)}</td><td><div class="row-actions">${i.status==='pending'?'<button data-resolve-report title="Resolver">✓</button><button data-dismiss-report title="Descartar">×</button>':'—'}</div></td></tr>`).join(''):adminEmpty('No se encontraron incidencias.');}
async function moderateReport(id,action){await api(`/api/admin/moderation/${id}`,{method:'PATCH',body:JSON.stringify({action})});toast(action==='resolve'?'Incidencia resuelta.':'Incidencia descartada.');await Promise.all([loadAdminModeration(),loadAdminDashboard()]);}

async function loadAdminSettings(){const data=await api('/api/admin/settings');state.admin.settings=data.settings;const form=$('#adminSettingsForm');form.elements.name.value=data.profile.name;form.elements.email.value=data.profile.email;form.elements.sidebar_behavior.value=state.sidebarMode;$('#adminProfileName').textContent=data.profile.name;$('#adminProfileEmail').textContent=data.profile.email;$('#adminBackupPanel')?.classList.toggle('hidden',state.user.role!=='admin');['admin_theme','report_notifications','room_alerts','allow_registration','community_auto_approval'].forEach(key=>form.elements[key].checked=String(data.settings[key])==='1'||data.settings[key]==='dark');}
async function saveAdminSettings(form){const sidebarMode=form.elements.sidebar_behavior.value;const profile=await api('/api/me',{method:'PATCH',body:JSON.stringify({name:form.elements.name.value})});state.user=profile.user;applySidebarMode(sidebarMode,true);setUserUI();const settings={};['admin_theme','report_notifications','room_alerts','allow_registration','community_auto_approval'].forEach(key=>settings[key]=form.elements[key].checked?(key==='admin_theme'?'dark':'1'):(key==='admin_theme'?'light':'0'));await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({settings})});toast('Configuración administrativa guardada.');await loadAdminSettings();}

async function downloadAdminBackup(button) {
  if (!button || button.disabled) return;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `${icon('clock')} Preparando respaldo…`;
  try {
    const response = await fetch('/api/admin/backup', { cache:'no-store', credentials:'same-origin' });
    if (response.status === 401) {
      window.location.href = '/';
      throw new Error('Sesión vencida.');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo generar el respaldo.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `focurion-respaldo-${new Date().toISOString().slice(0,10)}.json`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Respaldo descargado correctamente.');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function startPomodoro() {
  if (state.focus.active) return;
  beginPomoPlan(state.personalPomo, 'Tiempo de enfoque', 'Sesión bloqueante iniciada.');
}

function beginPomoPlan(settings, focusLabel, message, taskId = null) {
  if (state.focus.active) return;
  const plan = buildPomoPlan(settings);
  state.focus = {
    active:true,
    paused:false,
    total:0,
    remaining:0,
    interval:null,
    plan:plan.phases,
    phaseIndex:0,
    focusMinutes:plan.focusMinutes,
    focusLabel,
    goal:settings.goal || 'Bloque de estudio profundo',
    taskId
  };
  $('#pomodoroOverlay').classList.add('active');
  $('#pomodoroOverlay').setAttribute('aria-hidden','false');
  document.body.classList.add('focus-locked');
  applyFocusPhase(0);
  state.focus.interval = setInterval(focusTick, 1000);
  document.documentElement.requestFullscreen?.().catch(() => {});
  toast(message);
}

function applyFocusPhase(index) {
  const phase = state.focus.plan?.[index];
  if (!phase) return;
  state.focus.phaseIndex = index;
  state.focus.total = phase.duration * 60;
  state.focus.remaining = phase.duration * 60;
  if (phase.type === 'focus') {
    $('#focusLabel').textContent = state.focus.focusLabel;
    $('#focusTaskLabel').textContent = state.focus.goal;
  } else {
    $('#focusLabel').textContent = phase.type === 'longBreak' ? 'Descanso largo' : 'Descanso corto';
    $('#focusTaskLabel').textContent = 'Respira y recarga energía. El siguiente bloque comenzará automáticamente.';
  }
  updateFocusDisplay();
}

function focusTick() {
  if (!state.focus.active || state.focus.paused) return;
  state.focus.remaining -= 1;
  updateFocusDisplay();
  if (state.focus.remaining <= 0) {
    const next = Number(state.focus.phaseIndex || 0) + 1;
    if (state.focus.plan && next < state.focus.plan.length) applyFocusPhase(next);
    else completePomodoro();
  }
}

function updateFocusDisplay() {
  const minutes = Math.floor(Math.max(0,state.focus.remaining)/60);
  const seconds = Math.max(0,state.focus.remaining)%60;
  $('#focusTimer').textContent = `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  const pct = state.focus.total ? ((state.focus.total-state.focus.remaining)/state.focus.total)*100 : 0;
  $('#focusProgress').style.width = `${pct}%`;
  $('#focusPause').textContent = state.focus.paused ? 'Continuar' : 'Pausar';
  document.title = state.focus.active ? `${$('#focusTimer').textContent} · Focurion` : 'Focurion';
}

async function completePomodoro() {
  clearInterval(state.focus.interval);
  const duration = Math.max(1,Math.round(state.focus.focusMinutes || state.focus.total/60));
  state.focus.active = false;
  $('#focusLabel').textContent = '¡Sesión completada!';
  $('#focusTaskLabel').textContent = 'Tu tiempo de enfoque quedó registrado y ganaste experiencia.';
  $('#focusPause').classList.add('hidden');
  $('#focusAbandon').textContent = 'Volver a Focurion';
  $('#focusAbandon').classList.remove('btn-danger');
  $('#focusAbandon').classList.add('btn-primary');
  await api('/api/pomodoro/complete', { method:'POST', body:JSON.stringify({ duration_minutes:duration, task_id:state.focus.taskId || null }) });
  toast('Pomodoro completado. Ganaste XP.');
  await loadDashboard();
}

function closeFocus() {
  clearInterval(state.focus.interval);
  state.focus = { active:false, paused:false, total:0, remaining:0, interval:null };
  $('#pomodoroOverlay').classList.remove('active');
  $('#pomodoroOverlay').setAttribute('aria-hidden','true');
  $('#focusLabel').textContent = 'Tiempo de enfoque';
  $('#focusTaskLabel').textContent = 'Mantén esta pantalla abierta. La navegación está bloqueada mientras estudias.';
  $('#focusPause').classList.remove('hidden');
  $('#focusAbandon').textContent = 'Abandonar';
  $('#focusAbandon').classList.add('btn-danger');
  $('#focusAbandon').classList.remove('btn-primary');
  document.body.classList.remove('focus-locked');
  document.title = 'Focurion';
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function abandonFocus() {
  if (!state.focus.active) return closeFocus();
  if (!confirm('¿Seguro que quieres abandonar? Esta sesión no contará para tu progreso.')) return;
  closeFocus();
  toast('Sesión abandonada.', 'error');
}

function bindEvents() {
  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  $$('[data-view-link]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showView(link.dataset.viewLink); }));
  document.addEventListener('click', event => {
    const preset = event.target.closest('[data-pomodoro-preset]');
    if (preset) applyPomoPreset(preset);
    const jump = event.target.closest('[data-view-jump]');
    if (jump) showView(jump.dataset.viewJump);
    const opener = event.target.closest('[data-open-modal]');
    if (opener) {
      if (opener.dataset.openModal === 'roomModal') $('#roomForm').elements.community_id.value = opener.hasAttribute('data-community-context') ? (state.activeCommunityId || '') : '';
      if (opener.dataset.openModal === 'eventModal') openNewEvent();
      else openModal(opener.dataset.openModal);
    }
    if (event.target.closest('[data-close-modal]')) closeModals();
    const dashboardRoom = event.target.closest('[data-dashboard-room]');
    if (dashboardRoom) { showView('rooms'); setTimeout(() => roomAction(dashboardRoom.dataset.dashboardRoom, Boolean(state.rooms.find(r=>r.id===Number(dashboardRoom.dataset.dashboardRoom))?.joined)), 250); }
    const dashboardDate = event.target.closest('[data-dashboard-date]');
    if (dashboardDate) openCalendarDate(dashboardDate.dataset.dashboardDate);
    if (event.target.closest('[data-dashboard-ranking]')) showView('ranking');
  });
  $('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#eventDatePickerButton').addEventListener('click', () => {
    const input = $('#eventDateInput');
    if (typeof input.showPicker === 'function') input.showPicker();
    else { input.focus(); input.click(); }
  });
  $('#sidebarToggle').addEventListener('click', toggleSidebarMode);
  $('#sidebar').addEventListener('mouseenter', () => {
    if (state.sidebarMode !== 'dynamic' || window.innerWidth <= 880) return;
    document.body.classList.add('sidebar-hovered');
    updateSidebarToggle(true);
  });
  $('#sidebar').addEventListener('mouseleave', () => {
    if (state.sidebarMode !== 'dynamic') return;
    document.body.classList.remove('sidebar-hovered');
    updateSidebarToggle(true);
  });
  $('#topAvatar').addEventListener('click', () => {
    if (state.user.role === 'admin') { showView('admin'); showAdminTab('settings'); }
    else showView('settings');
  });
  $('#logoutButton').addEventListener('click', async () => { await api('/api/auth/logout',{method:'POST'}); window.location.href='/'; });
  $('#themeQuick').addEventListener('click', async () => {
    const theme = state.user.theme === 'light' ? 'dark' : 'light';
    const data = await api('/api/me',{method:'PATCH',body:JSON.stringify({ theme })});
    state.user = data.user; setUserUI(); fillSettings();
  });
  $('#quickSession').addEventListener('click', () => state.user.role === 'admin' ? openModal('adminUserModal') : startPomodoro());
  $$('[data-start-pomodoro]').forEach(button => button.addEventListener('click', startPomodoro));

  $('#taskForm').addEventListener('submit', event => { event.preventDefault(); createTask(event.currentTarget).catch(error=>toast(error.message,'error')); });
  $('#goalForm').addEventListener('submit', event => { event.preventDefault(); createGoal(event.currentTarget).catch(error=>toast(error.message,'error')); });
  $('#roomForm').addEventListener('submit', event => { event.preventDefault(); createRoom(event.currentTarget).catch(error=>toast(error.message,'error')); });
  $('#communityForm').addEventListener('submit', event => { event.preventDefault(); createCommunity(event.currentTarget).catch(error=>toast(error.message,'error')); });
  $('#eventForm').addEventListener('submit', event => { event.preventDefault(); saveEvent(event.currentTarget).catch(error=>toast(error.message,'error')); });
  $('#deleteEventButton').addEventListener('click', () => {
    const id = $('#eventForm').elements.event_id.value;
    if (id) deleteEvent(id).catch(error=>toast(error.message,'error'));
  });

  $('#tasksList').addEventListener('change', event => {
    if (event.target.matches('.task-check')) toggleTask(event.target.closest('[data-task-id]').dataset.taskId,event.target.checked).catch(error=>toast(error.message,'error'));
  });
  $('#tasksList').addEventListener('click', event => {
    const focus = event.target.closest('[data-focus-task]');
    if (focus) return startTaskPomodoro(focus.dataset.focusTask);
    const button = event.target.closest('[data-delete-task]');
    if (button) return deleteTask(button.closest('[data-task-id]').dataset.taskId).catch(error=>toast(error.message,'error'));
    toggleTaskFromRow(event);
  });
  $('#dashboardTasks').addEventListener('change', event => {
    if (event.target.matches('.task-check')) toggleTask(event.target.closest('[data-task-id]').dataset.taskId,event.target.checked).catch(error=>toast(error.message,'error'));
  });
  $('#dashboardTasks').addEventListener('click', event => {
    const focus = event.target.closest('[data-focus-task]');
    if (focus) return startTaskPomodoro(focus.dataset.focusTask);
    toggleTaskFromRow(event);
  });
  $('#goalsList').addEventListener('click', event => {
    const card = event.target.closest('[data-goal-id]');
    if (!card) return;
    if (event.target.closest('[data-update-goal]')) updateGoal(card.dataset.goalId,card.querySelector('input').value).catch(error=>toast(error.message,'error'));
    if (event.target.closest('[data-delete-goal]')) deleteGoal(card.dataset.goalId).catch(error=>toast(error.message,'error'));
  });

  $$('.section-tab').forEach(button => button.addEventListener('click', () => {
    $$('.section-tab').forEach(tab => tab.classList.toggle('active',tab===button));
    $$('.personal-tab').forEach(tab => tab.classList.toggle('active',tab.id===`personal-${button.dataset.personalTab}`));
  }));
  $('#notesList').addEventListener('click', event => { const item=event.target.closest('[data-note-id]'); if(item) selectNote(item.dataset.noteId); });
  $('#newNoteButton').addEventListener('click', () => newNote().catch(error=>toast(error.message,'error')));
  $('#saveNoteButton').addEventListener('click', () => saveNote().catch(error=>toast(error.message,'error')));
  $('#deleteNoteButton').addEventListener('click', () => deleteNote().catch(error=>toast(error.message,'error')));

  $('#roomSearch').addEventListener('input',renderRooms);
  $('#roomFilter').addEventListener('change',renderRooms);
  $('#roomFilterChips').addEventListener('click',event=>{const button=event.target.closest('[data-room-filter]');if(!button)return;$('#roomFilter').value=button.dataset.roomFilter;$$('#roomFilterChips button').forEach(item=>item.classList.toggle('active',item===button));renderRooms();});
  $('#roomsGrid').addEventListener('click',event=>{ const button=event.target.closest('[data-room-action]'); if(button) roomAction(button.dataset.roomAction,button.dataset.joined==='1').catch(error=>toast(error.message,'error')); });
  $('#roomChatForm').addEventListener('submit',event=>{ event.preventDefault(); const content=$('#roomChatInput').value.trim(); if(content&&state.activeRoomId){ socket?.emit('room:message',{roomId:state.activeRoomId,content}); $('#roomChatInput').value=''; } });
  $('#backToRooms').addEventListener('click',closeRoomDetail);
  $('#leaveRoom').addEventListener('click',()=>leaveActiveRoom().catch(error=>toast(error.message,'error')));
  $('#addRoomObjective').addEventListener('click',()=>openModal('roomObjectiveModal'));
  $('#addRoomResource').addEventListener('click',()=>openModal('roomResourceModal'));
  $('#roomObjectives').addEventListener('change',event=>{const input=event.target.closest('[data-objective-id]');if(!input)return;api(`/api/rooms/${state.activeRoomId}/objectives/${input.dataset.objectiveId}`,{method:'PATCH',body:JSON.stringify({completed:input.checked})}).then(()=>openRoomDetail(state.activeRoomId,false)).catch(error=>toast(error.message,'error'));});
  $('#roomObjectiveForm').addEventListener('submit',event=>{event.preventDefault();createRoomObjective(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#roomResourceForm').addEventListener('submit',event=>{event.preventDefault();createRoomResource(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#customizeRoomFocus').addEventListener('click',()=>{updateRoomPomoPreview();openModal('roomPomodoroModal');});
  $('#startRoomFocus').addEventListener('click',()=>startRoomPomodoro());
  $('#roomPomodoroForm').addEventListener('input',updateRoomPomoPreview);
  $('#roomPomodoroForm').addEventListener('submit',event=>{event.preventDefault();if(saveRoomPomoSettings()){closeModals();toast('Pomodoro personalizado.');}});
  $('#saveAndStartRoomPomo').addEventListener('click',startRoomPomodoro);
  $$('[data-customize-personal-pomodoro]').forEach(button => button.addEventListener('click',()=>openPersonalPomoSettings()));
  $('#personalPomodoroForm').addEventListener('input',updatePersonalPomoPreview);
  $('#personalPomodoroForm').addEventListener('submit',event=>{event.preventDefault();savePersonalPomoSettings(false).catch(error=>toast(error.message,'error'));});
  $('#saveAndStartPersonalPomo').addEventListener('click',()=>savePersonalPomoSettings(true).catch(error=>toast(error.message,'error')));

  $('#communitySearch').addEventListener('input',renderCommunities);
  $('#communityFilter').addEventListener('change',renderCommunities);
  $('#communityFilterChips').addEventListener('click',event=>{const button=event.target.closest('[data-community-filter]');if(!button)return;state.communityDirectoryFilter=button.dataset.communityFilter;$$('#communityFilterChips button').forEach(item=>item.classList.toggle('active',item===button));renderCommunities();});
  [$('#communitiesGrid'),$('#joinedCommunitiesGrid')].forEach(grid=>grid.addEventListener('click',event=>{ const button=event.target.closest('[data-community-action]'); if(button) communityAction(button.dataset.communityAction,button.dataset.joined==='1').catch(error=>toast(error.message,'error')); }));
  $('#backToCommunities').addEventListener('click',closeCommunityDetail);
  $('#communityTabs').addEventListener('click',event=>{const button=event.target.closest('[data-community-tab]');if(button)renderCommunityTab(button.dataset.communityTab);});
  $('#communityTabContent').addEventListener('click',event=>{
    const jump=event.target.closest('[data-community-tab-jump]');if(jump)return renderCommunityTab(jump.dataset.communityTabJump);
    const room=event.target.closest('[data-community-room]');if(room){showView('rooms');setTimeout(()=>roomAction(room.dataset.communityRoom,room.dataset.joined==='1').catch(error=>toast(error.message,'error')),120);}
    const postAction=event.target.closest('[data-post-action]');
    if(postAction){
      const action=postAction.dataset.postAction;
      if(action==='comment')postAction.closest('.community-post-card')?.querySelector('.comment-form input')?.focus();
      if(action==='like'||action==='save'){const postId=postAction.closest('[data-post-actions]')?.dataset.postActions;if(postId)togglePostReaction(postId,action).catch(error=>toast(error.message,'error'));}
      if(action==='share'){const url=`${location.origin}/app#communities/${state.activeCommunityId}`;navigator.clipboard?.writeText(url).then(()=>toast('Enlace de la comunidad copiado.')).catch(()=>toast('Copia el enlace desde la barra del navegador.'));}
    }
    const challenge=event.target.closest('[data-join-challenge]');if(challenge){challenge.disabled=true;challenge.textContent='Participando';toast('Te registraste en el reto.');}
    const project=event.target.closest('[data-project-preview]');if(project)toast('Este proyecto todavía no tiene un enlace público.','error');
    const memberAction=event.target.closest('[data-member-action]');if(memberAction){memberAction.classList.toggle('active');memberAction.textContent=memberAction.dataset.memberAction==='follow'?(memberAction.classList.contains('active')?'Siguiendo':'Seguir'):'Invitación enviada';toast(memberAction.dataset.memberAction==='follow'?'Preferencia de seguimiento actualizada.':'Invitación enviada.');}
  });
  $('#communityTabContent').addEventListener('submit',event=>{const form=event.target.closest('.comment-form');if(!form)return;event.preventDefault();createComment(form.dataset.postId,form.elements.content.value).catch(error=>toast(error.message,'error'));});
  $('#communityTabContent').addEventListener('input',event=>{if(event.target.id!=='memberSearch')return;const query=event.target.value.trim().toLowerCase();$$('.community-members-list article',$('#communityTabContent')).forEach(row=>row.classList.toggle('hidden',!row.dataset.memberName.includes(query)));});
  $('#heroCreatePost').addEventListener('click',()=>openModal('communityPostModal'));
  $('#heroShareResource').addEventListener('click',()=>openModal('communityResourceModal'));
  $('#heroJoinRoom').addEventListener('click',()=>{const room=state.communityDetail?.rooms?.[0];if(!room)return toast('Esta comunidad todavía no tiene salas.','error');showView('rooms');setTimeout(()=>roomAction(room.id,room.joined===1).catch(error=>toast(error.message,'error')),120);});
  $('#quickShareResource').addEventListener('click',async()=>{const joined=state.communities.find(item=>Number(item.joined));if(!joined)return toast('Únete primero a una comunidad.','error');await openCommunity(joined.id);openModal('communityResourceModal');});
  $('#communityPostForm').addEventListener('submit',event=>{event.preventDefault();createPost().catch(error=>toast(error.message,'error'));});
  $('#communityResourceForm').addEventListener('submit',event=>{event.preventDefault();createCommunityResource(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#communityProjectForm').addEventListener('submit',event=>{event.preventDefault();createCommunityProject(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#communityChallengeForm').addEventListener('submit',event=>{event.preventDefault();createCommunityChallenge(event.currentTarget).catch(error=>toast(error.message,'error'));});

  $$('.chip[data-ai-mode]').forEach(button=>button.addEventListener('click',()=>{ state.aiMode=button.dataset.aiMode; $$('.chip[data-ai-mode]').forEach(item=>item.classList.toggle('active',item===button)); }));
  $('#aiForm').addEventListener('submit',event=>{ event.preventDefault(); askAi().catch(error=>toast(error.message,'error')); });
  $('#aiHistory').addEventListener('click',event=>{ const item=event.target.closest('[data-ai-prompt]'); if(item) $('#aiPrompt').value=item.dataset.aiPrompt; });

  $('#prevMonth').addEventListener('click',()=>{ state.calendarSelectedDate=null; state.calendarCursor=new Date(state.calendarCursor.getFullYear(),state.calendarCursor.getMonth()-1,1); renderCalendar(); });
  $('#nextMonth').addEventListener('click',()=>{ state.calendarSelectedDate=null; state.calendarCursor=new Date(state.calendarCursor.getFullYear(),state.calendarCursor.getMonth()+1,1); renderCalendar(); });
  $('#todayButton').addEventListener('click',()=>{ state.calendarCursor=new Date(); state.calendarSelectedDate=new Date().toISOString().slice(0,10); renderCalendar(); });
  $('#calendarGrid').addEventListener('click',event=>{
    const existing = event.target.closest('[data-event-id]');
    if (existing) return openEventEditor(existing.dataset.eventId);
    const day=event.target.closest('[data-calendar-date]');
    if(day){ state.calendarSelectedDate=day.dataset.calendarDate; renderCalendar(); openNewEvent(day.dataset.calendarDate); }
  });
  $('#calendarUpcoming').addEventListener('click',event=>{
    const button=event.target.closest('[data-delete-event]');
    if(button) return deleteEvent(button.dataset.deleteEvent).catch(error=>toast(error.message,'error'));
    const row=event.target.closest('[data-edit-event]');
    if(row) openEventEditor(row.dataset.editEvent);
  });

  $('#settingsForm').addEventListener('submit',event=>{ event.preventDefault(); saveSettings().catch(error=>toast(error.message,'error')); });
  $('#changePasswordButton').addEventListener('click',()=>changePassword().catch(error=>toast(error.message,'error')));

  $$('.admin-tab').forEach(button=>button.addEventListener('click',()=>showAdminTab(button.dataset.adminTab)));
  $$('[data-admin-side-tab]').forEach(button=>button.addEventListener('click',()=>{ showView('admin'); showAdminTab(button.dataset.adminSideTab); }));
  $('#view-admin').addEventListener('click',event=>{
    const go=event.target.closest('[data-admin-go]'); if(go) showAdminTab(go.dataset.adminGo);
    const userRow=event.target.closest('[data-admin-user]'); if(userRow){if(event.target.closest('[data-save-admin]'))saveAdminUser(userRow).catch(error=>toast(error.message,'error'));if(event.target.closest('[data-delete-admin]'))deleteAdminUser(userRow).catch(error=>toast(error.message,'error'));}
    const communityRow=event.target.closest('[data-admin-community]'); if(communityRow){if(event.target.closest('[data-save-community]'))updateAdminCommunity(communityRow).catch(error=>toast(error.message,'error'));if(event.target.closest('[data-delete-community]'))deleteAdminCommunity(communityRow).catch(error=>toast(error.message,'error'));}
    const roomRow=event.target.closest('[data-admin-room]'); if(roomRow){if(event.target.closest('[data-save-room]'))updateAdminRoom(roomRow).catch(error=>toast(error.message,'error'));if(event.target.closest('[data-delete-room]'))deleteAdminRoom(roomRow).catch(error=>toast(error.message,'error'));}
    const eventRow=event.target.closest('[data-admin-event]'); if(eventRow){if(event.target.closest('[data-approve-event]'))reviewAdminEvent(eventRow.dataset.adminEvent,'approve').catch(error=>toast(error.message,'error'));if(event.target.closest('[data-reject-event]'))reviewAdminEvent(eventRow.dataset.adminEvent,'reject').catch(error=>toast(error.message,'error'));if(event.target.closest('[data-delete-admin-event]'))deleteAdminEvent(eventRow.dataset.adminEvent).catch(error=>toast(error.message,'error'));}
    const reportRow=event.target.closest('[data-admin-report]'); if(reportRow){if(event.target.closest('[data-resolve-report]'))moderateReport(reportRow.dataset.adminReport,'resolve').catch(error=>toast(error.message,'error'));if(event.target.closest('[data-dismiss-report]'))moderateReport(reportRow.dataset.adminReport,'dismiss').catch(error=>toast(error.message,'error'));}
  });
  $('#adminUserForm').addEventListener('submit',event=>{event.preventDefault();createAdminUser(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#adminCommunityForm').addEventListener('submit',event=>{event.preventDefault();createAdminCommunity(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#adminRoomForm').addEventListener('submit',event=>{event.preventDefault();createAdminRoom(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#adminEventForm').addEventListener('submit',event=>{event.preventDefault();createAdminEvent(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#adminSettingsForm').addEventListener('submit',event=>{event.preventDefault();saveAdminSettings(event.currentTarget).catch(error=>toast(error.message,'error'));});
  $('#downloadBackupButton')?.addEventListener('click',event=>downloadAdminBackup(event.currentTarget).catch(error=>toast(error.message,'error')));
  $('#adminChangePassword').addEventListener('click',async()=>{try{const currentPassword=$('#adminCurrentPassword').value,newPassword=$('#adminNewPassword').value;if(!currentPassword||newPassword.length<8)return toast('Completa ambas contraseñas.','error');await api('/api/me/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});$('#adminCurrentPassword').value='';$('#adminNewPassword').value='';toast('Contraseña actualizada.');}catch(error){toast(error.message,'error');}});
  [['#adminUserSearch',renderAdminUsers],['#adminUserStatus',renderAdminUsers],['#adminCommunitySearch',renderAdminCommunities],['#adminCommunityStatus',renderAdminCommunities],['#adminRoomSearch',renderAdminRooms],['#adminRoomStatus',renderAdminRooms],['#adminEventSearch',renderAdminEvents],['#adminEventStatus',renderAdminEvents],['#adminModerationSearch',renderAdminModeration],['#adminModerationStatus',renderAdminModeration]].forEach(([selector,fn])=>$(selector)?.addEventListener(selector.includes('Search')?'input':'change',fn));

  $('#focusPause').addEventListener('click',()=>{ state.focus.paused=!state.focus.paused; updateFocusDisplay(); });
  $('#focusAbandon').addEventListener('click',abandonFocus);
  window.addEventListener('beforeunload',event=>{ if(state.focus.active){ event.preventDefault(); event.returnValue=''; } });
  document.addEventListener('visibilitychange',()=>{ if(state.focus.active&&document.hidden) toast('Regresa a tu sesión de enfoque.', 'error'); });

  $('#globalSearch').addEventListener('input',event=>{
    clearTimeout(state.searchTimer);
    const value=event.currentTarget.value;
    if(value.trim().length<2){state.searchResults=[];hideGlobalSearchResults();return;}
    state.searchTimer=setTimeout(()=>performGlobalSearch(value),220);
  });
  $('#globalSearch').addEventListener('focus',event=>{if(event.currentTarget.value.trim().length>=2)performGlobalSearch(event.currentTarget.value);});
  $('#globalSearch').addEventListener('keydown',event=>{
    if(event.key==='Escape'){hideGlobalSearchResults();event.currentTarget.blur();return;}
    if(event.key==='ArrowDown'){event.preventDefault();focusSearchResult(state.searchActiveIndex+1);return;}
    if(event.key==='ArrowUp'){event.preventDefault();focusSearchResult(state.searchActiveIndex-1);return;}
    if(event.key==='Enter'){
      event.preventDefault();
      if(state.searchResults.length)return openGlobalSearchResult(state.searchResults[state.searchActiveIndex]).catch(error=>toast(error.message,'error'));
      if(event.currentTarget.value.trim().length>=2)performGlobalSearch(event.currentTarget.value);
    }
  });
  $('#globalSearchResults').addEventListener('mousemove',event=>{const button=event.target.closest('[data-search-result]');if(button)focusSearchResult(Number(button.dataset.searchResult));});
  $('#globalSearchResults').addEventListener('click',event=>{const button=event.target.closest('[data-search-result]');if(button)openGlobalSearchResult(state.searchResults[Number(button.dataset.searchResult)]).catch(error=>toast(error.message,'error'));});
  document.addEventListener('click',event=>{if(!event.target.closest('#globalSearchBox'))hideGlobalSearchResults();});
}


function activeViewName() {
  return $('.view.active')?.id?.replace('view-', '') || '';
}

function scheduleLiveRefresh(resources = []) {
  resources.forEach(resource => liveRefresh.resources.add(resource));
  clearTimeout(liveRefresh.timer);
  liveRefresh.timer = setTimeout(() => {
    const pending = [...liveRefresh.resources];
    liveRefresh.resources.clear();
    refreshLiveResources(pending).catch(error => console.error('Live refresh:', error));
  }, 180);
}

async function refreshLiveResources(resources) {
  if (!state.user || !resources.length) return;
  const changed = new Set(resources);
  const view = activeViewName();
  const jobs = [];
  const addJob = fn => jobs.push(Promise.resolve().then(fn));
  const hasAny = (...items) => items.some(item => changed.has(item));

  if (state.user.role === 'admin') {
    const tab = state.admin.tab || 'dashboard';
    const adminLoaders = {
      dashboard: loadAdminDashboard,
      users: loadAdminUsers,
      communities: loadAdminCommunities,
      rooms: loadAdminRooms,
      events: loadAdminEvents,
      reports: loadAdminReports,
      moderation: loadAdminModeration,
      settings: loadAdminSettings
    };
    const tabResources = {
      dashboard: ['admin-dashboard'],
      users: ['admin-users'],
      communities: ['admin-communities', 'communities'],
      rooms: ['admin-rooms', 'rooms'],
      events: ['admin-events', 'events'],
      reports: ['admin-reports'],
      moderation: ['admin-moderation'],
      settings: ['admin-settings', 'profile']
    };
    if (view === 'admin' && hasAny(...(tabResources[tab] || []))) addJob(adminLoaders[tab]);
    return Promise.allSettled(jobs);
  }

  if (view === 'dashboard' && hasAny('dashboard', 'tasks', 'goals', 'events', 'rooms', 'ranking', 'profile')) {
    addJob(loadDashboard);
  }
  if (view === 'personal') {
    if (changed.has('tasks')) addJob(loadTasks);
    if (changed.has('goals')) addJob(loadGoals);
    if (changed.has('notes')) addJob(loadNotes);
  }
  if (view === 'communities' && hasAny('communities', 'posts')) addJob(loadCommunities);
  if (view === 'rooms' && changed.has('rooms')) addJob(loadRooms);
  if (view === 'calendar' && changed.has('events')) addJob(loadEvents);
  if (view === 'ranking' && changed.has('ranking')) addJob(loadRanking);
  if (view === 'settings' && changed.has('profile')) addJob(async () => {
    const data = await api('/api/me');
    state.user = data.user;
    setUserUI();
    fillSettings();
  });

  await Promise.allSettled(jobs);
  if (view === 'personal') renderPersonalSummary();
}

function bindSocket() {
  if (!socket) return;
  socket.on('connect_error', () => {});
  socket.on('data:changed', payload => {
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    if (resources.length) scheduleLiveRefresh(resources);
  });
  socket.on('room:message', message => {
    if (message.room_id !== state.activeRoomId) return;
    const empty = $('#roomChatMessages .empty-inline');
    if (empty) empty.remove();
    $('#roomChatMessages').insertAdjacentHTML('beforeend',roomMessageHtml(message));
    $('#roomChatMessages').scrollTop = $('#roomChatMessages').scrollHeight;
  });
}

async function init() {
  try {
    const data = await api('/api/me');
    state.user = data.user;
    try {
      const savedPomo = JSON.parse(localStorage.getItem('focurionPersonalPomo') || 'null');
      if (savedPomo && typeof savedPomo === 'object') state.personalPomo = { ...state.personalPomo, ...savedPomo };
    } catch (_) {}
    renderPomoPresets();
    setUserUI();
    bindEvents();
    bindSocket();
    const initial = location.hash.replace('#','');
    const allowed = ['dashboard','personal','rooms','ai','communities','ranking','calendar','settings','admin'];
    const view = state.user.role === 'admin'
      ? 'admin'
      : (allowed.includes(initial) ? initial : 'dashboard');
    if (view === 'admin' && !['admin','moderator'].includes(state.user.role)) showView('dashboard',false);
    else {
      showView(view,false);
      if (state.user.role === 'admin') showAdminTab('dashboard');
    }
  } catch (_) {
    window.location.href = '/';
  }
}

init();
