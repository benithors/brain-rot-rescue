const toggleEl = document.getElementById('toggle-enabled');
const blocklistEl = document.getElementById('blocklist');
const blockForm = document.getElementById('blocklist-form');
const blockInput = document.getElementById('block-input');
const cooldownsEl = document.getElementById('cooldowns');
const cooldownsEmptyEl = document.getElementById('cooldowns-empty');
const statusEl = document.getElementById('popup-status');
const quickAddBtn = document.getElementById('quick-add');
const bookmarksEl = document.getElementById('bookmarks');
const bookmarkForm = document.getElementById('bookmark-form');
const bookmarkTitleInput = document.getElementById('bookmark-title');
const bookmarkUrlInput = document.getElementById('bookmark-url');
const bookmarkKeyInput = document.getElementById('bookmark-key');
const bookmarkCancelBtn = document.getElementById('bookmark-cancel');
const bookmarkSubmitBtn = document.getElementById('bookmark-submit');
const bookmarkHelpEl = document.getElementById('bookmark-help');
const bookmarkUseTabBtn = document.getElementById('bookmark-use-tab');
const bookmarkKeySuggestionsEl = document.getElementById('bookmark-key-suggestions');
const bookmarkKeyStatusEl = document.getElementById('bookmark-key-status');

let cachedState;
let editingBookmarkId = null;
let activeTabCache = null;

const KEY_POOL = [
  'a',
  's',
  'd',
  'f',
  'j',
  'k',
  'l',
  'g',
  'h',
  'r',
  't',
  '1',
  '2',
  '3',
  '4',
  '5',
  'q',
  'w',
  'e',
  'z',
  'x',
  'c',
  'v',
  'b',
  'n',
  'm',
  'p',
  'o',
  'y',
  'u',
  '6',
  '7',
  '8',
  '9',
  '0'
];

init();

function init() {
  toggleEl?.addEventListener('change', onToggleChange);
  blockForm?.addEventListener('submit', onBlockSubmit);
  quickAddBtn?.addEventListener('click', onQuickAdd);
  blocklistEl?.addEventListener('click', onBlockListClick);
  cooldownsEl?.addEventListener('click', onCooldownClick);
  bookmarkForm?.addEventListener('submit', onBookmarkSubmit);
  bookmarksEl?.addEventListener('click', onBookmarkListClick);
  bookmarkCancelBtn?.addEventListener('click', resetBookmarkForm);
  bookmarkUseTabBtn?.addEventListener('click', onBookmarkUseTab);
  bookmarkTitleInput?.addEventListener('input', updateKeyAssist);
  bookmarkUrlInput?.addEventListener('input', updateKeyAssist);
  bookmarkKeyInput?.addEventListener('input', updateKeyAssist);
  refresh();
}

async function refresh() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to load state');
    }
    cachedState = response;
    render(response);
  } catch (error) {
    setStatus(error.message || 'Unable to load extension state', true);
  }
}

function render(state) {
  const { settings, cooldowns } = state;
  if (toggleEl) {
    toggleEl.checked = Boolean(settings?.enabled);
  }
  renderBlocklist(settings?.blocklist || []);
  renderCooldowns(cooldowns || []);
  renderBookmarks(settings?.bookmarks || []);
  updateKeyAssist();
}

function renderBlocklist(blocklist) {
  if (!blocklistEl) return;
  blocklistEl.innerHTML = '';
  if (!blocklist.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = 'No sites are being intercepted.';
    blocklistEl.appendChild(li);
    return;
  }
  blocklist.forEach((host) => {
    const li = document.createElement('li');
    li.className = 'list-item';
    const span = document.createElement('span');
    span.className = 'host';
    span.textContent = host;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.dataset.host = host;
    btn.textContent = 'Remove';
    li.append(span, btn);
    blocklistEl.appendChild(li);
  });
}

function renderCooldowns(cooldowns) {
  if (!cooldownsEl || !cooldownsEmptyEl) return;
  cooldownsEl.innerHTML = '';
  if (!cooldowns.length) {
    cooldownsEmptyEl.hidden = false;
    return;
  }
  cooldownsEmptyEl.hidden = true;
  const sorted = [...cooldowns].sort((a, b) => a.expiresAt - b.expiresAt);
  sorted.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'cooldown-pill';
    const label = document.createElement('span');
    label.textContent = `${entry.host} · ${formatTimeRemaining(entry.expiresAt)}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cooldownHost = entry.host;
    button.textContent = 'Clear';
    li.append(label, button);
    cooldownsEl.appendChild(li);
  });
}

function renderBookmarks(bookmarks) {
  if (!bookmarksEl) return;
  bookmarksEl.innerHTML = '';
  if (!bookmarks.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = 'No bookmarks yet.';
    bookmarksEl.appendChild(li);
    if (!editingBookmarkId) resetBookmarkForm();
    return;
  }

  const sorted = [...bookmarks].sort((a, b) => a.key.localeCompare(b.key));
  sorted.forEach((bm) => {
    const li = document.createElement('li');
    li.className = 'list-item';

    const main = document.createElement('div');
    main.className = 'bookmark-main';
    const title = document.createElement('div');
    title.className = 'bookmark-title';
    title.textContent = bm.title || readableHost(bm.url);
    const url = document.createElement('div');
    url.className = 'bookmark-url';
    url.textContent = readableHost(bm.url);
    main.append(title, url);

    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';

    const keyChip = document.createElement('span');
    keyChip.className = 'key-chip';
    keyChip.textContent = bm.key.toUpperCase();

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.dataset.editBookmarkId = bm.id;
    editBtn.textContent = 'Edit';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn';
    removeBtn.dataset.removeBookmarkId = bm.id;
    removeBtn.textContent = 'Remove';

    actions.append(keyChip, editBtn, removeBtn);
    li.append(main, actions);
    bookmarksEl.appendChild(li);
  });

  const active = sorted.find((bm) => bm.id === editingBookmarkId);
  if (!active) {
    resetBookmarkForm();
  }
}

async function onToggleChange(event) {
  const enabled = event.target.checked;
  try {
    await chrome.runtime.sendMessage({ type: 'popup:set-enabled', enabled });
    await refresh();
    setStatus(enabled ? 'Focus guard is active.' : 'Focus guard paused.');
  } catch (error) {
    if (cachedState?.settings) {
      toggleEl.checked = cachedState.settings.enabled;
    }
    setStatus(error.message || 'Unable to update toggle.', true);
  }
}

async function onBlockSubmit(event) {
  event.preventDefault();
  const value = blockInput.value.trim();
  if (!value) {
    setStatus('Enter a domain to block.', true);
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:add-block-entry', host: value });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to add domain');
    }
    blockInput.value = '';
    setStatus(`${value} added to the blocklist.`);
    await refresh();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onBlockListClick(event) {
  const button = event.target.closest('button[data-host]');
  if (!button) return;
  const host = button.dataset.host;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:remove-block-entry', host });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to remove domain');
    }
    setStatus(`${host} removed.`);
    await refresh();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onCooldownClick(event) {
  const button = event.target.closest('button[data-cooldown-host]');
  if (!button) return;
  const host = button.dataset.cooldownHost;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:clear-cooldown', host });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to clear override');
    }
    await refresh();
    setStatus(`Override for ${host} cleared.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function onQuickAdd() {
  if (!quickAddBtn) return;
  quickAddBtn.disabled = true;
  quickAddBtn.textContent = 'Saving…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:quick-add-reading-entry' });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to add reading list entry');
    }
    setStatus('Saved! It will appear next time you need it.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    quickAddBtn.disabled = false;
    quickAddBtn.textContent = 'Add current tab';
  }
}

async function onBookmarkSubmit(event) {
  event.preventDefault();
  const payload = getBookmarkPayload();
  if (!payload.url) {
    setStatus('Enter a valid URL for the bookmark.', true);
    return;
  }
  if (!payload.key) {
    setStatus('Choose a single letter/number key.', true);
    return;
  }
  try {
    const message = editingBookmarkId
      ? { type: 'popup:update-bookmark', id: editingBookmarkId, ...payload }
      : { type: 'popup:add-bookmark', ...payload };
    const response = await chrome.runtime.sendMessage(message);
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to save bookmark');
    }
    setStatus(editingBookmarkId ? 'Bookmark updated.' : 'Bookmark saved.');
    resetBookmarkForm();
    await refresh();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function onBookmarkListClick(event) {
  const removeBtn = event.target.closest('button[data-remove-bookmark-id]');
  if (removeBtn) {
    const id = removeBtn.dataset.removeBookmarkId;
    removeBookmark(id);
    return;
  }
  const editBtn = event.target.closest('button[data-edit-bookmark-id]');
  if (editBtn) {
    const id = editBtn.dataset.editBookmarkId;
    startBookmarkEdit(id);
  }
}

async function removeBookmark(id) {
  if (!id) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:remove-bookmark', id });
    if (response?.status !== 'ok') {
      throw new Error(response?.message || 'Unable to remove bookmark');
    }
    if (editingBookmarkId === id) {
      resetBookmarkForm();
    }
    await refresh();
    setStatus('Bookmark removed.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

function startBookmarkEdit(id) {
  if (!cachedState?.settings?.bookmarks) return;
  const bookmark = cachedState.settings.bookmarks.find((bm) => bm.id === id);
  if (!bookmark) return;
  editingBookmarkId = id;
  if (bookmarkTitleInput) bookmarkTitleInput.value = bookmark.title || '';
  if (bookmarkUrlInput) bookmarkUrlInput.value = bookmark.url || '';
  if (bookmarkKeyInput) bookmarkKeyInput.value = bookmark.key || '';
  if (bookmarkSubmitBtn) bookmarkSubmitBtn.textContent = 'Update';
  if (bookmarkCancelBtn) bookmarkCancelBtn.hidden = false;
  if (bookmarkHelpEl) bookmarkHelpEl.textContent = 'Editing—keys must be unique.';
  updateKeyAssist();
}

function resetBookmarkForm() {
  editingBookmarkId = null;
  bookmarkTitleInput && (bookmarkTitleInput.value = '');
  bookmarkUrlInput && (bookmarkUrlInput.value = '');
  bookmarkKeyInput && (bookmarkKeyInput.value = '');
  if (bookmarkSubmitBtn) bookmarkSubmitBtn.textContent = 'Save';
  if (bookmarkCancelBtn) bookmarkCancelBtn.hidden = true;
  if (bookmarkHelpEl) {
    bookmarkHelpEl.textContent =
      'Pick a free key (click a suggestion). Keys fire on the dashboard; hold Shift to open in a new tab.';
  }
  updateKeyAssist();
}

function getBookmarkPayload() {
  return {
    title: bookmarkTitleInput?.value?.trim() || '',
    url: bookmarkUrlInput?.value?.trim() || '',
    key: bookmarkKeyInput?.value?.trim().toLowerCase() || ''
  };
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.hidden = !message;
  statusEl.classList.toggle('error', Boolean(message && isError));
}

function readableHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_error) {
    return url;
  }
}

function firstAlphanumeric(value) {
  if (!value) return '';
  const match = String(value).match(/[a-z0-9]/i);
  return match ? match[0].toLowerCase() : '';
}

async function onBookmarkUseTab() {
  try {
    const tab = await getActiveHttpTab();
    if (!tab) {
      setStatus('Active tab is not a regular page.', true);
      return;
    }
    const safeUrl = tab.url.split('#')[0];
    if (bookmarkTitleInput) bookmarkTitleInput.value = tab.title || readableHost(safeUrl);
    if (bookmarkUrlInput) bookmarkUrlInput.value = safeUrl;
    autoAssignKey();
    updateKeyAssist();
    setStatus('Filled from current tab.');
  } catch (error) {
    setStatus(error.message || 'Unable to use current tab', true);
  }
}

async function getActiveHttpTab() {
  if (activeTabCache?.url && isHttpUrl(activeTabCache.url)) return activeTabCache;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && isHttpUrl(tab.url)) {
    activeTabCache = tab;
    return tab;
  }
  return null;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function autoAssignKey() {
  if (editingBookmarkId && bookmarkKeyInput?.value) return;
  const payload = getBookmarkPayload();
  const suggestion = buildKeySuggestions(payload).find((item) => item.state === 'available');
  if (suggestion && bookmarkKeyInput) {
    bookmarkKeyInput.value = suggestion.key;
  }
}

function buildKeySuggestions(formState = {}) {
  const usedKeys = getUsedKeys();
  const editingKey = getEditingBookmark()?.key;
  if (editingKey) usedKeys.delete(editingKey);

  const suggestions = [];
  const seen = new Set();
  const add = (key, reason = '') => {
    if (!key) return;
    const lower = key.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    const state = usedKeys.has(lower) ? 'used' : 'available';
    return suggestions.push({ key: lower, reason, state });
  };

  add(firstAlphanumeric(formState.title), 'from title');
  add(firstAlphanumeric(readableHost(formState.url)), 'from url');
  KEY_POOL.forEach((key) => add(key, 'home row'));

  return suggestions.slice(0, 12);
}

function getUsedKeys() {
  const used = new Set();
  const bookmarks = cachedState?.settings?.bookmarks || [];
  bookmarks.forEach((bm) => used.add(bm.key));
  return used;
}

function getEditingBookmark() {
  if (!editingBookmarkId || !cachedState?.settings?.bookmarks) return null;
  return cachedState.settings.bookmarks.find((bm) => bm.id === editingBookmarkId) || null;
}

function getKeyUsage(key) {
  if (!key) return { state: 'empty', message: 'Pick a key' };
  const normalized = key.toLowerCase();
  const bookmarks = cachedState?.settings?.bookmarks || [];
  const match = bookmarks.find((bm) => bm.key === normalized);
  if (!match) return { state: 'available', message: 'Available' };
  if (editingBookmarkId && match.id === editingBookmarkId) {
    return { state: 'owned', message: 'Keeping current key' };
  }
  const label = match.title || readableHost(match.url);
  return { state: 'taken', message: `In use by "${label}"` };
}

function updateKeyAssist() {
  renderKeyStatus();
  renderKeySuggestions();
}

function renderKeyStatus() {
  if (!bookmarkKeyStatusEl) return;
  const usage = getKeyUsage(bookmarkKeyInput?.value || '');
  bookmarkKeyStatusEl.textContent = usage.message;
  bookmarkKeyStatusEl.classList.remove('pill--muted', 'pill--ok', 'pill--warn', 'pill--error');

  if (usage.state === 'available') bookmarkKeyStatusEl.classList.add('pill--ok');
  else if (usage.state === 'taken') bookmarkKeyStatusEl.classList.add('pill--error');
  else if (usage.state === 'owned') bookmarkKeyStatusEl.classList.add('pill--warn');
  else bookmarkKeyStatusEl.classList.add('pill--muted');
}

function renderKeySuggestions() {
  if (!bookmarkKeySuggestionsEl) return;
  const formState = getBookmarkPayload();
  const currentKey = (bookmarkKeyInput?.value || '').toLowerCase();
  const suggestions = buildKeySuggestions(formState);
  const editingKey = getEditingBookmark()?.key;

  bookmarkKeySuggestionsEl.innerHTML = '';

  suggestions.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key-suggestion';
    button.textContent = item.key.toUpperCase();
    if (item.state === 'used' && item.key !== editingKey) {
      button.classList.add('is-used');
      button.disabled = true;
      button.title = 'Already assigned';
    }
    if (item.key === currentKey) {
      button.classList.add('is-active');
    }
    button.addEventListener('click', () => {
      if (bookmarkKeyInput) {
        bookmarkKeyInput.value = item.key;
        bookmarkKeyInput.focus();
        updateKeyAssist();
      }
    });
    bookmarkKeySuggestionsEl.appendChild(button);
  });
}

function formatTimeRemaining(timestamp) {
  const diffMs = Math.max(0, timestamp - Date.now());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes >= 1) {
    const seconds = Math.round((diffMs % 60000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${Math.ceil(diffMs / 1000)}s`;
}
