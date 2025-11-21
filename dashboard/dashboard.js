import { attachHoldToOverride } from '../shared/hold-to-override.js';

const params = new URLSearchParams(window.location.search);
const blockedHost = params.get('blocked') || '';
const originalUrl = params.get('original') || '';
const cooldownMinutes = Number(params.get('cooldown')) || 15;
const holdDurationMs = Number(params.get('holdMs')) || 5000;

const heroLede = document.getElementById('hero-lede');
const overrideCard = document.getElementById('override-card');
const overrideTitle = document.getElementById('override-title');
const overrideHint = document.getElementById('override-hint');
const overridePill = document.getElementById('override-pill');
const overrideButton = document.getElementById('override-button');

const readingListEl = document.getElementById('reading-list');
const readingEmptyEl = document.getElementById('reading-empty');
const refreshReadingBtn = document.getElementById('refresh-reading');

const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoListEl = document.getElementById('todo-list');
const toggleDoneEl = document.getElementById('toggle-done');

const clockLabel = document.getElementById('clock-label');
const clockHands = {
  hour: document.querySelector('[data-hand="hour"]'),
  minute: document.querySelector('[data-hand="minute"]'),
  second: document.querySelector('[data-hand="second"]')
};
// Track cumulative turns so the hands never sweep backward when they wrap.
const handRotationState = {
  hour: { prev: null, turns: 0 },
  minute: { prev: null, turns: 0 },
  second: { prev: null, turns: 0 }
};

let currentTabId = null;
let todos = [];
let showDone = false;

init();

async function init() {
  heroLede.textContent = blockedHost
    ? `We paused ${blockedHost}. Take a breath, pick a saved read, or nudge one to-do forward.`
    : 'Set the tone for the day. Pick a saved read or capture a quick task before you browse.';

  await resolveTab();
  setupOverride();
  attachClock();
  bindReadingList();
  bindTodos();
}

async function resolveTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    currentTabId = tab?.id ?? null;
  } catch (_error) {
    currentTabId = null;
  }
}

function setupOverride() {
  if (!overrideCard) return;
  if (!blockedHost || !originalUrl) {
    overridePill.textContent = 'No override needed';
    overrideTitle.textContent = 'Browse intentionally';
    overrideHint.textContent = 'Open a saved article or capture a to-do before you jump elsewhere.';
    overrideButton.disabled = true;
    overrideButton.querySelector('[data-role="hold-label"]').textContent = 'Override unavailable';
    return;
  }

  const seconds = Math.round(holdDurationMs / 1000);
  overridePill.textContent = 'Blocked site';
  overrideTitle.textContent = `Hold to visit ${blockedHost}`;
  overrideHint.textContent = `Override snoozes blocking for ${formatMinutes(cooldownMinutes)}.`;

  attachHoldToOverride(overrideButton, {
    durationMs: holdDurationMs,
    progressVar: '--hold-progress',
    completedLabel: 'Redirecting…',
    formatLabel: ({ remainingMs }) => `Keep holding… ${Math.ceil(remainingMs / 1000)}s`,
    onFinalize: () => {
      overrideButton.classList.add('hold-btn--active');
    },
    onCancel: () => {
      overrideButton.classList.remove('hold-btn--active');
    },
    onComplete: async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'focus:override',
        payload: {
          blockedHost,
          originalUrl,
          tabId: currentTabId
        }
      });
      if (response?.status !== 'ok') {
        throw new Error(response?.message || 'Unable to override.');
      }
    },
    onError: (error) => {
      overrideHint.textContent = error?.message || 'Unable to override right now.';
      overrideButton.classList.remove('hold-btn--active');
    }
  });
  overrideButton.querySelector('[data-role="hold-label"]').textContent = `Hold for ${seconds}s`;
}

function attachClock() {
  if (!clockLabel || !clockHands.hour || !clockHands.minute || !clockHands.second) return;

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });

  let timerId = null;

  const sync = () => {
    const now = new Date();
    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours = now.getHours() + minutes / 60;

    setHandRotation(clockHands.second, seconds * 6, 'second');
    setHandRotation(clockHands.minute, minutes * 6, 'minute');
    setHandRotation(clockHands.hour, ((hours % 12) / 12) * 360, 'hour');

    clockLabel.textContent = formatter.format(now);

    const delay = Math.max(16, 1000 - now.getMilliseconds());
    timerId = setTimeout(sync, delay);
  };

  const start = () => {
    if (timerId) clearTimeout(timerId);
    sync();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      start();
    } else if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  });

  start();
}

function setHandRotation(el, deg, key) {
  if (!el || !key) return;
  const state = handRotationState[key] || { prev: null, turns: 0 };
  let normalized = deg % 360;
  if (normalized < 0) normalized += 360;
  if (state.prev != null && normalized < state.prev) {
    state.turns += 1;
  }
  state.prev = normalized;
  const total = normalized + state.turns * 360;
  handRotationState[key] = state;
  el.style.setProperty('--rotation', `${total}deg`);
}

function bindReadingList() {
  refreshReadingBtn?.addEventListener('click', loadReadingList);
  loadReadingList();
}

async function loadReadingList() {
  try {
    const entries = await chrome.readingList.query({ hasBeenRead: false });
    entries.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
    renderReading(entries || []);
  } catch (error) {
    readingEmptyEl.hidden = false;
    readingEmptyEl.textContent = 'Reading List unavailable. Is the permission enabled?';
    console.error('Reading List load failed', error);
  }
}

function renderReading(entries) {
  readingListEl.innerHTML = '';
  if (!entries.length) {
    readingEmptyEl.hidden = false;
    return;
  }
  readingEmptyEl.hidden = true;
  entries.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'reading-card';
    card.role = 'listitem';

    const title = document.createElement('p');
    title.className = 'reading-title';
    title.textContent = entry.title || readableHost(entry.url) || 'Saved page';

    const meta = document.createElement('p');
    meta.className = 'reading-meta';
    meta.textContent = `${readableHost(entry.url)} • ${relativeTime(entry.creationTime)}`;

    const actions = document.createElement('div');
    actions.className = 'reading-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-inline primary';
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => navigate(entry.url));

    const markBtn = document.createElement('button');
    markBtn.className = 'btn-inline';
    markBtn.type = 'button';
    markBtn.textContent = 'Mark read';
    markBtn.addEventListener('click', () => markEntry(entry));

    actions.append(openBtn, markBtn);
    card.append(title, meta, actions);
    readingListEl.appendChild(card);
  });
}

async function markEntry(entry) {
  try {
    await chrome.readingList.removeEntry({ url: entry.url });
    await loadReadingList();
  } catch (error) {
    console.error('Failed to remove entry', error);
  }
}

function readableHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_error) {
    return url;
  }
}

function relativeTime(timestamp) {
  if (!timestamp) return 'just now';
  const delta = Date.now() - timestamp;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

async function navigate(url) {
  if (!currentTabId) return;
  try {
    await chrome.tabs.update(currentTabId, { url });
  } catch (error) {
    console.error('Navigation failed', error);
  }
}

function bindTodos() {
  todoForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = todoInput.value.trim();
    if (!value) return;
    addTodo(value);
    todoInput.value = '';
  });
  toggleDoneEl?.addEventListener('change', (event) => {
    showDone = event.target.checked;
    renderTodos();
  });
  loadTodos();
}

async function loadTodos() {
  try {
    const { dashboardTodos = [] } = await chrome.storage.local.get('dashboardTodos');
    todos = Array.isArray(dashboardTodos) ? dashboardTodos : [];
  } catch (_error) {
    todos = [];
  }
  renderTodos();
}

async function saveTodos() {
  await chrome.storage.local.set({ dashboardTodos: todos });
}

function renderTodos() {
  todoListEl.innerHTML = '';
  const filtered = showDone ? todos : todos.filter((t) => !t.done);
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = showDone ? 'No to-dos yet.' : 'Nothing open right now.';
    todoListEl.appendChild(empty);
    return;
  }
  filtered.forEach((todo) => {
    const item = document.createElement('li');
    item.className = 'todo-item';
    item.dataset.id = todo.id;
    item.draggable = true;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(todo.done);
    checkbox.addEventListener('change', () => toggleTodo(todo.id, checkbox.checked));

    const text = document.createElement('div');
    text.textContent = todo.text;
    text.className = todo.done ? 'todo-text_done' : '';

    const deleteBtn = document.createElement('button');
    deleteBtn.setAttribute('aria-label', 'Delete');
    deleteBtn.innerHTML = '✕';
    deleteBtn.addEventListener('click', () => deleteTodo(todo.id));

    item.append(checkbox, text, deleteBtn);
    wireDrag(item);
    todoListEl.appendChild(item);
  });
}

function addTodo(text) {
  const makeId = () => {
    try {
      if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    } catch (_error) {
      // ignore
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  };
  const next = {
    id: makeId(),
    text,
    done: false,
    createdAt: Date.now()
  };
  todos = [next, ...todos];
  saveTodos();
  renderTodos();
}

function toggleTodo(id, done) {
  todos = todos.map((t) => (t.id === id ? { ...t, done } : t));
  saveTodos();
  renderTodos();
}

function deleteTodo(id) {
  todos = todos.filter((t) => t.id !== id);
  saveTodos();
  renderTodos();
}

function wireDrag(item) {
  item.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', item.dataset.id);
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));
  item.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    const draggingId = str(event.dataTransfer.getData('text/plain'));
    const targetId = item.dataset.id;
    if (!draggingId || draggingId === targetId) return;
    const fromIndex = todos.findIndex((t) => t.id === draggingId);
    const toIndex = todos.findIndex((t) => t.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    reorderTodos(fromIndex, toIndex);
  });
}

function reorderTodos(from, to) {
  const copy = [...todos];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  todos = copy;
  saveTodos();
  renderTodos();
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function formatMinutes(minutes) {
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}
