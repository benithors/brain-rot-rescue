const toggleEl = document.getElementById('toggle-enabled');
const blocklistEl = document.getElementById('blocklist');
const blockForm = document.getElementById('blocklist-form');
const blockInput = document.getElementById('block-input');
const cooldownsEl = document.getElementById('cooldowns');
const cooldownsEmptyEl = document.getElementById('cooldowns-empty');
const statusEl = document.getElementById('popup-status');
const quickAddBtn = document.getElementById('quick-add');

let cachedState;

init();

function init() {
  toggleEl?.addEventListener('change', onToggleChange);
  blockForm?.addEventListener('submit', onBlockSubmit);
  quickAddBtn?.addEventListener('click', onQuickAdd);
  blocklistEl?.addEventListener('click', onBlockListClick);
  cooldownsEl?.addEventListener('click', onCooldownClick);
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

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.hidden = !message;
  statusEl.classList.toggle('error', Boolean(message && isError));
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
