import { attachHoldToOverride } from '../shared/hold-to-override.js';

const params = new URLSearchParams(window.location.search);
const blockedHost = params.get('blocked') || '';
const originalUrl = params.get('original') || '';
const cooldownMinutes = Number(params.get('cooldown')) || 15;
const holdDurationMs = Number(params.get('holdMs')) || 5000;

// Elements that might exist in the new layout
const overrideCard = document.getElementById('override-card');
const overrideTitle = document.getElementById('override-title');
const overrideHint = document.getElementById('override-hint');
const overrideButton = document.getElementById('override-button');

const readingListEl = document.getElementById('reading-list');
const readingEmptyEl = document.getElementById('reading-empty');
const refreshReadingBtn = document.getElementById('refresh-reading');

const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoListEl = document.getElementById('todo-list');
const toggleDoneEl = document.getElementById('toggle-done');

const clockLabel = document.getElementById('clock-label');
const asciiClockEl = document.getElementById('ascii-clock');

let currentTabId = null;
let todos = [];
let showDone = false;

init();

async function init() {
  // No hero lede in new design
  await resolveTab();
  setupOverride();
  attachClock();
  startAsciiClock();
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
    formatLabel: ({ remainingMs }) => `HOLD TO BYPASS... ${Math.ceil(remainingMs / 1000)}s`,
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
    readingEmptyEl.textContent = '> ERROR: READING LIST UNAVAILABLE.';
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
    const card = document.createElement('div');
    card.className = 'reading-card';

    const title = document.createElement('div');
    title.className = 'reading-title';
    title.textContent = entry.title || readableHost(entry.url) || 'UNKNOWN DATA';
    title.title = entry.title; // Tooltip for full title

    const actions = document.createElement('div');
    actions.className = 'reading-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-inline';
    openBtn.textContent = '[ OPEN ]';
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

function formatMinutes(minutes) {
  if (minutes === 1) return '1 MINUTE';
  return `${minutes} MINUTES`;
}

function startAsciiClock() {
  if (!asciiClockEl) return;

  const size = 13; // Diameter (odd number for center)
  const center = Math.floor(size / 2);
  const radius = center;

  const updateClock = () => {
    const grid = Array.from({ length: size }, () => Array(size).fill(' '));
    const now = new Date();

    // Draw Face
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt(Math.pow(x - center, 2) + Math.pow(y - center, 2));
        // Circle border
        if (dist >= radius - 0.5 && dist <= radius + 0.5) {
          grid[y][x] = '.';
        }
      }
    }

    // Center
    grid[center][center] = '+';

    // Calculate angles
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours() % 12;

    const secAngle = (seconds / 60) * 2 * Math.PI - Math.PI / 2;
    const minAngle = (minutes / 60) * 2 * Math.PI - Math.PI / 2;
    const hourAngle = ((hours + minutes / 60) / 12) * 2 * Math.PI - Math.PI / 2;

    // Draw Hands
    const drawLine = (angle, length, char) => {
      for (let r = 1; r <= length; r += 0.5) {
        const x = Math.round(center + Math.cos(angle) * r);
        const y = Math.round(center + Math.sin(angle) * r);
        if (x >= 0 && x < size && y >= 0 && y < size) {
          grid[y][x] = char;
        }
      }
    };

    drawLine(secAngle, radius - 1, '.'); // Second hand
    drawLine(minAngle, radius - 2, 'o'); // Minute hand
    drawLine(hourAngle, radius - 3, 'O'); // Hour hand

    // Re-draw center to ensure it's on top if needed, or just keep it
    grid[center][center] = '+';

    asciiClockEl.textContent = grid.map(row => row.join(' ')).join('\n');
  };

  updateClock();
  setInterval(updateClock, 1000);
}
