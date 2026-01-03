import { attachHoldToOverride } from '../shared/hold-to-override.js';
import { getAsciiLabel } from '../shared/ascii-progress.js';
import { createSyncWriter } from '../shared/sync-writer.js';

const params = new URLSearchParams(window.location.search);
const blockedHost = params.get('blocked') || '';
const originalUrl = params.get('original') || '';
const cooldownMinutes = Number(params.get('cooldown')) || 15;
const holdDurationMs = Number(params.get('holdMs')) || 5000;

const RECURRING_STORAGE_KEY = 'dashboardRecurring';
const RECURRING_DEFAULTS = [
  {
    id: 'journal',
    label: 'Write journal',
    description: 'Capture today in Obsidian.',
    actionLabel: 'Open Obsidian',
    actionUrl: 'obsidian://open'
  }
];

// Elements that might exist in the new layout
const overrideCard = document.getElementById('override-card');
const overrideTitle = document.getElementById('override-title');
const overrideHint = document.getElementById('override-hint');
const overrideButton = document.getElementById('override-button');

const readingListEl = document.getElementById('reading-list');
const readingEmptyEl = document.getElementById('reading-empty');

const blockChartEl = document.getElementById('block-chart');
const blockChartLabelsEl = document.getElementById('block-chart-labels');
const blockChartFootnoteEl = document.getElementById('block-chart-footnote');
const metricAttemptsEl = document.getElementById('metric-attempts');
const metricSavedEl = document.getElementById('metric-saved');
const statTotalSavedEl = document.getElementById('stat-total-saved');
const statSitesBlockedEl = document.getElementById('stat-sites-blocked');

const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoListEl = document.getElementById('todo-list');
const toggleDoneEl = document.getElementById('toggle-done');

const recurringListEl = document.getElementById('recurring-list');
const recurringEmptyEl = document.getElementById('recurring-empty');
const recurringResetEl = document.getElementById('recurring-reset-label');

const clockLabel = document.getElementById('clock-label');
const asciiClockEl = document.getElementById('ascii-clock');
const bookmarkListEl = document.getElementById('bookmark-list');
const bookmarkEmptyEl = document.getElementById('bookmark-empty');

let currentTabId = null;
let todos = [];
let showDone = false;
let recurringTasks = [];
let bookmarks = [];

const syncWriter = createSyncWriter({
  delayMs: 800,
  backlogKey: '__syncWriterBacklog_dashboard',
  onWriteError: (error) => {
    console.warn('chrome.storage.sync write failed', error);
  }
});

init();

window.addEventListener('pagehide', () => {
  syncWriter.flush().catch(() => {});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    syncWriter.flush().catch(() => {});
  }
});

async function init() {
  // No hero lede in new design
  await resolveTab();
  setupOverride();
  attachClock();
  startAsciiClock();
  bindBlockStats();
  bindReadingList();
  bindRecurringTasks();
  bindTodos();
  bindBookmarks();
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
  if (!overrideCard || !overrideButton || !overrideTitle || !overrideHint) return;

  const labelSpan = overrideButton.querySelector('[data-role="hold-label"]');

  if (!blockedHost || !originalUrl) {
    overrideTitle.textContent = 'SYSTEM IDLE';
    overrideHint.textContent = '> WAITING FOR INTERVENTION...';
    overrideButton.disabled = true;
    overrideButton.classList.add('muted');
    if (labelSpan) labelSpan.textContent = 'NO THREAT DETECTED';
    return;
  }

  const seconds = Math.round(holdDurationMs / 1000);
  overrideTitle.textContent = `THREAT DETECTED: ${blockedHost}`;
  overrideHint.textContent = `> OVERRIDE PROTOCOL: ${formatMinutes(cooldownMinutes)} WINDOW`;

  attachHoldToOverride(overrideButton, {
    durationMs: holdDurationMs,
    progressVar: '--hold-progress',
    completedLabel: 'ACCESS GRANTED',
    formatLabel: getAsciiLabel,
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
        throw new Error(response?.message || 'ACCESS DENIED.');
      }
    },
    onError: (error) => {
      overrideHint.textContent = error?.message || 'SYSTEM ERROR.';
      overrideButton.classList.remove('hold-btn--active');
    }
  });

  if (labelSpan) labelSpan.textContent = `INITIATE OVERRIDE (${seconds}s)`;
}

function attachClock() {
  if (!clockLabel) return;

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const sync = () => {
    const now = new Date();
    clockLabel.textContent = formatter.format(now);
    setTimeout(sync, 1000);
  };

  sync();
}

function bindBlockStats() {
  if (!blockChartEl) return;
  loadBlockStats();
  setInterval(loadBlockStats, 30000);
}

async function loadBlockStats() {
  if (!blockChartEl) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'stats:get-block-activity',
      days: 14
    });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'STATS OFFLINE.');
    }
    renderBlockStats(response.stats);
  } catch (error) {
    renderBlockStats(null, error);
  }
}

function renderBlockStats(stats, error) {
  if (!blockChartEl) return;
  updateSummaryStats(stats, error);
  blockChartEl.innerHTML = '';
  blockChartLabelsEl.innerHTML = '';

  if (error || !stats || !Array.isArray(stats.days)) {
    const msg = document.createElement('div');
    msg.className = 'chart-empty';
    msg.textContent = `> ${error?.message || 'TELEMETRY UNAVAILABLE.'}`;
    blockChartEl.appendChild(msg);
    if (metricAttemptsEl) metricAttemptsEl.textContent = '--';
    if (metricSavedEl) metricSavedEl.textContent = '--';
    if (blockChartFootnoteEl) blockChartFootnoteEl.textContent = 'Retrying in 30s.';
    return;
  }

  const days = stats.days || [];
  const maxSaved = Math.max(...days.map((d) => d.savedMs || 0), 0);
  const totalSavedMs = stats.window?.savedMs ?? 0;
  const totalAttempts = stats.window?.count ?? 0;
  const windowDays = stats.window?.days ?? days.length;

  if (metricAttemptsEl) {
    metricAttemptsEl.textContent = `${totalAttempts} attempt${plural(
      totalAttempts
    )} · ${windowDays}d window`;
  }
  if (metricSavedEl) {
    metricSavedEl.textContent = `${formatDuration(totalSavedMs, { short: true })} saved`;
  }

  if (!days.length) {
    const msg = document.createElement('div');
    msg.className = 'chart-empty';
    msg.textContent = '> NO INTERCEPTS LOGGED YET.';
    blockChartEl.appendChild(msg);
    if (blockChartFootnoteEl) {
      blockChartFootnoteEl.textContent = 'We will chart time saved after the first block.';
    }
    return;
  }

  days.forEach((day) => {
    const savedMs = day.savedMs || 0;
    const attempts = day.count || 0;
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    const height =
      maxSaved > 0
        ? Math.max(8, Math.round((savedMs / maxSaved) * 100))
        : attempts
          ? 12
          : 4;
    bar.style.height = `${Math.min(100, height)}%`;
    bar.title = `${formatDayLabel(day.day)} · ${attempts} attempt${plural(
      attempts
    )} · ${formatDuration(savedMs)}`;

    const value = document.createElement('span');
    value.className = 'chart-bar__value';
    value.textContent = savedMs ? `${Math.round(savedMs / 60000)}m` : '';
    bar.appendChild(value);
    blockChartEl.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'chart-label';
    label.textContent = formatShortDay(day.day);
    label.title = formatDayLabel(day.day);
    blockChartLabelsEl.appendChild(label);
  });

  if (blockChartFootnoteEl) {
    const lifetimeSaved = stats.lifetime?.savedMs ?? totalSavedMs;
    const lifetimeAttempts = stats.lifetime?.count ?? totalAttempts;
    blockChartFootnoteEl.textContent = `Lifetime: ${formatDuration(
      lifetimeSaved,
      { short: true }
    )} across ${lifetimeAttempts} attempt${plural(
      lifetimeAttempts
    )} · Retention ${stats.retentionDays}d`;
  }
}

function updateSummaryStats(stats, error) {
  const setStats = (savedLabel, blockedLabel) => {
    if (statTotalSavedEl) statTotalSavedEl.textContent = savedLabel;
    if (statSitesBlockedEl) statSitesBlockedEl.textContent = blockedLabel;
  };

  if (error || !stats) {
    setStats('--', '--');
    return;
  }

  const totalSavedMs = stats.lifetime?.savedMs ?? 0;
  const totalBlocks = stats.lifetime?.count ?? 0;

  setStats(
    formatDuration(totalSavedMs, { short: true }),
    totalBlocks.toLocaleString()
  );
}

function bindReadingList() {
  if (!readingListEl || !readingEmptyEl) return;
  loadReadingList();
}

async function loadReadingList() {
  if (!readingListEl || !readingEmptyEl) return;
  try {
    const entries = await chrome.readingList.query({ hasBeenRead: false });
    entries.sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));
    renderReading(entries || []);
  } catch (error) {
    readingEmptyEl.hidden = false;
    readingEmptyEl.textContent = '> ERROR: READING LIST UNAVAILABLE.';
    console.error('Reading List load failed', error);
  }
}

function renderReading(entries) {
  if (!readingListEl || !readingEmptyEl) return;
  readingListEl.innerHTML = '';
  if (!entries.length) {
    readingEmptyEl.hidden = false;
    return;
  }
  readingEmptyEl.hidden = true;
  entries.forEach((entry) => {
    const card = document.createElement('div');
    card.className = 'reading-card';

    const title = document.createElement('div');
    title.className = 'reading-title';
    title.textContent = entry.title || readableHost(entry.url) || 'UNKNOWN DATA';
    title.title = entry.title; // Tooltip for full title

    const actions = document.createElement('div');
    actions.className = 'reading-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-inline btn-inline--icon';
    openBtn.textContent = '↗';
    openBtn.title = 'Open';
    openBtn.setAttribute('aria-label', 'Open');
    openBtn.addEventListener('click', () => navigate(entry.url));

    const markBtn = document.createElement('button');
    markBtn.className = 'btn-inline';
    markBtn.textContent = 'X';
    markBtn.title = 'Mark as Read';
    markBtn.addEventListener('click', () => markEntry(entry));

    actions.append(openBtn, markBtn);
    card.append(title, actions);
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

async function navigate(url) {
  if (!currentTabId) return;
  try {
    await chrome.tabs.update(currentTabId, { url });
    await keepEntryUnread(url);
  } catch (error) {
    console.error('Navigation failed', error);
  }
}

async function keepEntryUnread(url) {
  if (!url || !chrome?.readingList?.updateEntry) return;
  try {
    await chrome.readingList.updateEntry({ url, hasBeenRead: false });
  } catch (error) {
    console.warn('Failed to keep reading list entry unread', error);
  }
}

function bindRecurringTasks() {
  if (!recurringListEl || !recurringEmptyEl) return;
  loadRecurringTasks();
}

async function loadRecurringTasks() {
  const today = getTodayKey();
  let stored = [];
  try {
    const storedValue = await chrome.storage.sync.get(RECURRING_STORAGE_KEY);
    stored = Array.isArray(storedValue[RECURRING_STORAGE_KEY])
      ? storedValue[RECURRING_STORAGE_KEY]
      : [];
  } catch (_error) {
    stored = [];
  }

  if (!stored.length) {
    try {
      const legacyValue = await chrome.storage.local.get(RECURRING_STORAGE_KEY);
      const legacyStored = Array.isArray(legacyValue[RECURRING_STORAGE_KEY])
        ? legacyValue[RECURRING_STORAGE_KEY]
        : [];
      if (legacyStored.length) {
        stored = legacyStored;
        await chrome.storage.sync.set({ [RECURRING_STORAGE_KEY]: legacyStored });
        await chrome.storage.local.remove(RECURRING_STORAGE_KEY);
      }
    } catch (_error) {
      // ignore
    }
  }

  recurringTasks = mergeRecurringDefaults(stored).map((task) => {
    const last = typeof task.lastCompletedOn === 'string' ? task.lastCompletedOn : null;
    return {
      ...task,
      lastCompletedOn: last || null,
      errorMessage: ''
    };
  });
  if (recurringResetEl) recurringResetEl.textContent = `Resets daily • ${formatDayLabel(today)}`;
  renderRecurringTasks();
  saveRecurringTasks();
}

function mergeRecurringDefaults(stored) {
  const map = new Map(
    stored
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => [item.id, item])
  );
  const merged = RECURRING_DEFAULTS.map((task) => ({
    ...task,
    ...(map.get(task.id) || {})
  }));
  stored.forEach((task) => {
    if (!merged.find((t) => t.id === task.id)) merged.push(task);
  });
  return merged;
}

async function saveRecurringTasks() {
  const payload = recurringTasks.map(({ errorMessage, ...task }) => task);
  await syncWriter.queueSet({ [RECURRING_STORAGE_KEY]: payload });
}

function renderRecurringTasks() {
  if (!recurringListEl || !recurringEmptyEl) return;
  recurringListEl.innerHTML = '';
  const today = getTodayKey();
  const active = recurringTasks.filter((task) => task.lastCompletedOn !== today);

  if (!active.length) {
    recurringEmptyEl.hidden = false;
    return;
  }
  recurringEmptyEl.hidden = true;
  active.forEach((task) => {
    const card = document.createElement('div');
    const done = task.lastCompletedOn === today;
    card.className = `recurring-card${done ? ' recurring-card_done' : ''}`;

    const details = document.createElement('div');
    details.className = 'recurring-details';

    const title = document.createElement('div');
    title.className = 'recurring-title';
    title.textContent = task.label || 'Untitled Task';

    const status = document.createElement('div');
    status.className = 'recurring-status';
    if (task.errorMessage) {
      status.textContent = `Error: ${task.errorMessage}`;
    } else if (done) {
      status.textContent = 'Done today';
    } else {
      status.textContent = 'Ready • opens external app';
    }

    details.append(title, status);

    const actions = document.createElement('div');
    actions.className = 'recurring-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-inline recurring-action';
    openBtn.textContent = done ? '[ OPEN AGAIN ]' : `[ ${task.actionLabel || 'OPEN'} ]`;
    openBtn.addEventListener('click', () => handleRecurringAction(task.id));

    const doneChip = document.createElement('span');
    doneChip.className = 'chip';
    doneChip.textContent = done ? 'DONE' : 'PENDING';

    actions.append(openBtn, doneChip);

    card.append(details, actions);
    recurringListEl.appendChild(card);
  });
}

async function handleRecurringAction(taskId) {
  const task = recurringTasks.find((t) => t.id === taskId);
  if (!task) return;
  try {
    await launchRecurringAction(task);
    await markRecurringDone(taskId);
  } catch (error) {
    recurringTasks = recurringTasks.map((t) =>
      t.id === taskId ? { ...t, errorMessage: error?.message || 'Action failed' } : t
    );
    renderRecurringTasks();
  }
}

async function launchRecurringAction(task) {
  if (task.actionUrl) {
    try {
      await chrome.tabs.create({ url: task.actionUrl });
      return;
    } catch (_error) {
      // Fall through to other strategies
    }
    if (currentTabId) {
      try {
        await chrome.tabs.update(currentTabId, { url: task.actionUrl });
        return;
      } catch (_error) {
        // Fall through to window.open
      }
    }
    window.open(task.actionUrl, '_blank', 'noopener');
  }
}

async function markRecurringDone(taskId) {
  const today = getTodayKey();
  recurringTasks = recurringTasks.map((task) =>
    task.id === taskId ? { ...task, lastCompletedOn: today, errorMessage: '' } : task
  );
  await saveRecurringTasks();
  renderRecurringTasks();
}

function bindBookmarks() {
  if (!bookmarkListEl || !bookmarkEmptyEl) return;
  loadBookmarks();
  document.addEventListener('keydown', handleBookmarkHotkey, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      loadBookmarks();
    }
  });
}

async function loadBookmarks() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'BOOKMARKS UNAVAILABLE.');
    }
    const items = Array.isArray(response.settings?.bookmarks) ? response.settings.bookmarks : [];
    bookmarks = items.sort((a, b) => a.key.localeCompare(b.key));
    renderBookmarks();
  } catch (error) {
    bookmarks = [];
    renderBookmarks(error);
  }
}

function renderBookmarks(error) {
  if (!bookmarkListEl || !bookmarkEmptyEl) return;
  bookmarkListEl.innerHTML = '';
  if (error || !bookmarks.length) {
    bookmarkEmptyEl.hidden = false;
    bookmarkEmptyEl.textContent = `> ${error?.message || 'NO BOOKMARKS YET.'}`;
    return;
  }
  bookmarkEmptyEl.hidden = true;
  bookmarks.forEach((bm) => {
    const row = document.createElement('div');
    row.className = 'bookmark-item';

    const meta = document.createElement('div');
    meta.className = 'bookmark-meta';
    const title = document.createElement('div');
    title.className = 'bookmark-title';
    title.textContent = bm.title || readableHost(bm.url);
    const host = document.createElement('div');
    host.className = 'bookmark-host';
    host.textContent = readableHost(bm.url);
    meta.append(title, host);

    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';

    const key = document.createElement('span');
    key.className = 'bookmark-key';
    key.textContent = bm.key.toUpperCase();

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'bookmark-open';
    openBtn.textContent = '[ OPEN ]';
    openBtn.addEventListener('click', () => openBookmark(bm, { newTab: false }));

    actions.append(openBtn, key);
    row.append(meta, actions);
    bookmarkListEl.appendChild(row);
  });
}

function handleBookmarkHotkey(event) {
  if (!bookmarks.length) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
  }
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (!key || key.length !== 1) return;
  const bookmark = bookmarks.find((bm) => bm.key === key);
  if (!bookmark) return;
  event.preventDefault();
  openBookmark(bookmark, { newTab: event.shiftKey });
}

function openBookmark(bookmark, options = {}) {
  const newTab = Boolean(options.newTab);
  const url = bookmark.url;
  if (newTab) {
    chrome.tabs.create({ url }).catch((_error) => {
      window.open(url, '_blank', 'noopener');
    });
    return;
  }
  if (currentTabId) {
    chrome.tabs
      .update(currentTabId, { url })
      .catch((_error) => window.open(url, '_blank', 'noopener'));
    return;
  }
  window.open(url, '_blank', 'noopener');
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
    const { dashboardTodos = [] } = await chrome.storage.sync.get('dashboardTodos');
    todos = Array.isArray(dashboardTodos) ? dashboardTodos : [];
  } catch (_error) {
    todos = [];
  }
  renderTodos();
}

async function saveTodos() {
  await syncWriter.queueSet({ dashboardTodos: todos });
}

function renderTodos() {
  todoListEl.innerHTML = '';
  const filtered = showDone ? todos : todos.filter((t) => !t.done);
  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.style.padding = '8px';
    empty.textContent = showDone ? '> NO LOGS FOUND.' : '> NO ACTIVE DIRECTIVES.';
    todoListEl.appendChild(empty);
    return;
  }
  filtered.forEach((todo) => {
    const item = document.createElement('li');
    item.className = 'todo-item';
    item.dataset.id = todo.id;
    // Drag and drop logic removed for simplicity in this view, or can be re-added if needed.
    // Keeping it simple for now to match the "log" aesthetic.

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(todo.done);
    checkbox.addEventListener('change', () => toggleTodo(todo.id, checkbox.checked));

    const text = document.createElement('div');
    text.textContent = todo.text;
    text.className = todo.done ? 'todo-text_done' : '';
    text.style.flex = '1';

    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = '[ DEL ]';
    deleteBtn.addEventListener('click', () => deleteTodo(todo.id));

    item.append(checkbox, text, deleteBtn);
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

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(ms, options = {}) {
  const short = options.short || false;
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) {
    return short ? `${hours}h ${minutes}m` : `${hours} hours ${minutes} min`;
  }
  return short ? `${totalMinutes}m` : `${totalMinutes} min`;
}

function formatShortDay(dayKey) {
  const date = parseDayKey(dayKey);
  if (!date) return dayKey;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDayLabel(dayKey) {
  const date = parseDayKey(dayKey);
  if (!date) return dayKey;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function parseDayKey(dayKey) {
  if (!dayKey || typeof dayKey !== 'string') return null;
  const parts = dayKey.split('-').map((part) => Number(part));
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function plural(value) {
  return value === 1 ? '' : 's';
}

function formatMinutes(minutes) {
  if (minutes === 1) return '1 MINUTE';
  return `${minutes} MINUTES`;
}

function startAsciiClock() {
  if (!asciiClockEl) return;

  const size = 13;
  const center = Math.floor(size / 2);
  const radius = center;

  const updateClock = () => {
    const grid = Array.from({ length: size }, () => Array(size).fill(' '));
    const now = new Date();

    // Draw clean circle
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt(Math.pow(x - center, 2) + Math.pow(y - center, 2));
        if (dist >= radius - 0.5 && dist <= radius + 0.5) {
          grid[y][x] = 'o';
        }
      }
    }

    // Hour markers at cardinal positions
    grid[0][center] = '12'.charAt(1); // Just show "2" at top for cleaner look
    grid[center][size - 1] = '3';
    grid[size - 1][center] = '6';
    grid[center][0] = '9';

    // Calculate angles
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours() % 12;

    const secAngle = (seconds / 60) * 2 * Math.PI - Math.PI / 2;
    const minAngle = ((minutes + seconds / 60) / 60) * 2 * Math.PI - Math.PI / 2;
    const hourAngle = ((hours + minutes / 60) / 12) * 2 * Math.PI - Math.PI / 2;

    // Draw hands
    const drawLine = (angle, length, char) => {
      for (let r = 1; r <= length; r += 0.5) {
        const x = Math.round(center + Math.cos(angle) * r);
        const y = Math.round(center + Math.sin(angle) * r);
        if (x >= 0 && x < size && y >= 0 && y < size) {
          grid[y][x] = char;
        }
      }
    };

    drawLine(hourAngle, radius - 3, '#'); // Hour hand
    drawLine(minAngle, radius - 2, '+');  // Minute hand  
    drawLine(secAngle, radius - 1, '.');  // Second hand

    // Center
    grid[center][center] = '*';

    // Build display
    const clockFace = grid.map(row => row.join(' ')).join('\n');

    // Digital time
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).toUpperCase();

    asciiClockEl.innerHTML = `<span class="clock-face">${clockFace}</span>\n<span class="clock-digital">${timeStr}</span>\n<span class="clock-date">${dateStr}</span>`;
  };

  updateClock();
  setInterval(updateClock, 1000);
}
