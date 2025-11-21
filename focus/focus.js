import { attachHoldToOverride } from '../shared/hold-to-override.js';
import { getAsciiLabel } from '../shared/ascii-progress.js';

const params = new URLSearchParams(window.location.search);
const blockedHost = params.get('blocked') || 'this site';
const originalUrl = params.get('original') || '';
const cooldownMinutes = Number(params.get('cooldown')) || 15;
const holdDurationMs = Number(params.get('holdMs')) || 5000;

const titleEl = document.getElementById('focus-title');
const leadEl = document.getElementById('focus-lead');
const holdLabel = document.querySelector('#focus-override [data-role="hold-label"]');
const holdHint = document.getElementById('focus-hint');
const holdButton = document.getElementById('focus-override');
const holdStatus = document.getElementById('focus-status');
const checkButton = document.getElementById('focus-check');
const holdLabelText = originalUrl
  ? `Hold for ${Math.round(holdDurationMs / 1000)}s to visit ${blockedHost}`
  : 'Original site unavailable';

let currentTabId = null;

initialize();

async function initialize() {
  titleEl.textContent = 'Nothing to swap in (yet)';
  leadEl.textContent = `We paused ${blockedHost}, but your Chrome Reading List is empty. Save one or two intentional reads, then come back next time the urge hits.`;
  if (holdLabel) {
    holdLabel.textContent = holdLabelText;
  }
  if (holdHint) {
    holdHint.textContent = `Override pauses the blocker for ${formatMinutes(cooldownMinutes)}.`;
  }

  try {
    const tab = await chrome.tabs.getCurrent();
    currentTabId = tab?.id ?? null;
  } catch (error) {
    currentTabId = null;
  }

  if (!originalUrl) {
    holdButton.disabled = true;
    if (holdHint) {
      holdHint.textContent = 'Reload the original site to try again.';
    }
  } else {
    attachHoldToOverride(holdButton, {
      durationMs: holdDurationMs,
      progressVar: '--focus-hold-progress',
      completedLabel: 'Redirecting…',
      formatLabel: getAsciiLabel,
      onComplete: () => requestOverride(),
      onError: (error) => setStatus(error.message || 'Unable to override right now.', true)
    });
  }

  checkButton?.addEventListener('click', () => tryLoadArticle());
}

async function requestOverride() {
  setStatus('Unlocking…');
  const response = await chrome.runtime.sendMessage({
    type: 'focus:override',
    payload: {
      blockedHost,
      originalUrl,
      tabId: currentTabId
    }
  });
  if (response?.status === 'ok') {
    return;
  }
  throw new Error(response?.message || 'Unable to override right now.');
}

async function tryLoadArticle() {
  setStatus('Checking your Reading List…');
  const response = await chrome.runtime.sendMessage({
    type: 'focus:load-article',
    payload: {
      blockedHost,
      originalUrl,
      tabId: currentTabId
    }
  });
  if (response?.status === 'ok') {
    return;
  }
  setStatus(response?.message || 'Still empty. Try saving something first.', true);
}

function setStatus(message, isError = false) {
  if (!holdStatus) return;
  holdStatus.textContent = message || '';
  holdStatus.hidden = !message;
  holdStatus.classList.toggle('error', Boolean(message && isError));
}

function formatMinutes(minutes) {
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}
