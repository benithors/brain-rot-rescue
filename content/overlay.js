(() => {
  if (window.__brainRotOverlayMounted) return;
  window.__brainRotOverlayMounted = true;

  const HOLD_SUCCESS_CLASS = 'brr-hold-success';
  const DEFAULT_COOLDOWN_MINUTES = 15;
  const STATUS_CLASS_SUCCESS = 'brr-status--success';
  const STATUS_CLASS_ERROR = 'brr-status--error';
  const holdHelperPromise = import(chrome.runtime.getURL('shared/hold-to-override.js'));

  initOverlay().catch((error) => {
    console.warn('Brain-Rot overlay failed to initialize', error);
  });

  async function initOverlay() {
    if (!chrome?.runtime?.sendMessage) return;
    const response = await chrome.runtime.sendMessage({ type: 'overlay:init' });
    if (!response || response.status !== 'ok' || !response.session?.article) {
      return;
    }

    const session = response.session;
    await whenBodyReady();
    mount(session);
  }

  function whenBodyReady() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  function mount(session) {
    const root = document.createElement('div');
    root.className = 'brr-overlay';
    root.innerHTML = `
      <section class="brr-card" role="region" aria-label="Brain-Rot Rescue">
        <div class="brr-heading">
          <span class="brr-pill">Focus Mode</span>
          <p class="brr-subtitle">
            Redirected from <strong data-field="blocked-host"></strong>
          </p>
        </div>
        <div class="brr-article">
          <p class="brr-article-label">Now reading</p>
          <p class="brr-article-title" data-field="article-title"></p>
          <p class="brr-article-source" data-field="article-host"></p>
        </div>
        <div class="brr-actions">
          <button type="button" class="brr-btn brr-btn--primary" data-action="mark">I finished reading this</button>
          <button type="button" class="brr-btn" data-action="another">Load another</button>
        </div>
        <div class="brr-divider"></div>
        <div class="brr-hold">
          <div class="brr-hold-copy">
            <p class="brr-hold-title">Need access?</p>
            <p class="brr-hold-meta">
              Hold to visit <span data-field="blocked-short"></span>. Blocker snoozes for <span data-field="cooldown"></span>.
            </p>
          </div>
          <button type="button" class="brr-hold-btn" data-action="override">
            <span class="brr-hold-text" data-role="hold-label"></span>
          </button>
        </div>
        <p class="brr-tip">Pro tip: Add more intentional reads via the extension popup.</p>
        <p class="brr-status" role="status" aria-live="polite" hidden></p>
      </section>
    `;

    const blockedHost = session.blockedHost || 'this site';
    const articleTitle = session.article.title?.trim() || readableHost(session.article.url) || 'Saved article';
    const articleHost = readableHost(session.article.url);
    const holdSeconds = Math.round((session.holdDurationMs || 5000) / 1000);
    const cooldownLabel = formatMinutes(session.cooldownMinutes);

    root.querySelector('[data-field="blocked-host"]').textContent = blockedHost;
    root.querySelector('[data-field="blocked-short"]').textContent = blockedHost;
    root.querySelector('[data-field="article-title"]').textContent = articleTitle;
    root.querySelector('[data-field="article-host"]').textContent = articleHost;
    root.querySelector('[data-field="cooldown"]').textContent = cooldownLabel;
    root.querySelector('[data-role="hold-label"]').textContent = `Hold for ${holdSeconds}s`;

    document.body.appendChild(root);

    const statusEl = root.querySelector('.brr-status');
    const markBtn = root.querySelector('[data-action="mark"]');
    const anotherBtn = root.querySelector('[data-action="another"]');
    const overrideBtn = root.querySelector('[data-action="override"]');

    markBtn?.addEventListener('click', () => handleMarkAsRead(markBtn, statusEl));
    anotherBtn?.addEventListener('click', () => handleLoadAnother(anotherBtn, statusEl));
    setupHoldButton(overrideBtn, session, statusEl).catch((error) => {
      console.warn('Failed to bind hold-to-override', error);
    });
  }

  function formatMinutes(value) {
    const minutes = Number.isFinite(value) ? value : DEFAULT_COOLDOWN_MINUTES;
    if (minutes === 1) return '1 minute';
    return `${minutes} minutes`;
  }

  function readableHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (error) {
      return url;
    }
  }

  async function handleMarkAsRead(button, statusEl) {
    if (!button || button.disabled) return;
    setButtonBusy(button, true, 'Removing…');
    setStatus(statusEl, '');
    const response = await chrome.runtime.sendMessage({ type: 'overlay:mark-read' });
    if (response?.status === 'ok') {
      button.textContent = 'Marked as read';
      button.disabled = true;
      setStatus(statusEl, 'Removed from your Chrome Reading List.', STATUS_CLASS_SUCCESS);
    } else {
      setStatus(statusEl, response?.message || 'Unable to update the reading list.', STATUS_CLASS_ERROR);
      setButtonBusy(button, false);
    }
  }

  async function handleLoadAnother(button, statusEl) {
    if (!button || button.disabled) return;
    setButtonBusy(button, true, 'Fetching…');
    setStatus(statusEl, '');
    const response = await chrome.runtime.sendMessage({ type: 'overlay:load-next' });
    if (response?.status === 'ok') {
      setStatus(statusEl, 'Loading the next saved article…', STATUS_CLASS_SUCCESS);
    } else {
      const reason = response?.message || 'No other unread items available.';
      setStatus(statusEl, reason, STATUS_CLASS_ERROR);
      setButtonBusy(button, false);
    }
  }

  async function setupHoldButton(button, session, statusEl) {
    if (!button) return;
    const { attachHoldToOverride } = await holdHelperPromise;
    const duration = session.holdDurationMs || 5000;
    const formatLabel = ({ remainingMs }) => `Keep holding… ${Math.ceil(remainingMs / 1000)}s`;
    const onComplete = async () => {
      const response = await chrome.runtime.sendMessage({ type: 'overlay:override' });
      if (response?.status !== 'ok') {
        throw new Error(response?.message || 'Override blocked');
      }
    };
    attachHoldToOverride(button, {
      durationMs: duration,
      progressVar: '--brr-hold-progress',
      completedLabel: 'Releasing…',
      formatLabel,
      onFinalize: () => {
        setStatus(statusEl, 'Override granted. Redirecting…', STATUS_CLASS_SUCCESS);
        button.classList.add(HOLD_SUCCESS_CLASS);
      },
      onComplete,
      onCancel: () => {
        button.classList.remove(HOLD_SUCCESS_CLASS);
        setStatus(statusEl, '');
      },
      onError: (error) => {
        button.classList.remove(HOLD_SUCCESS_CLASS);
        setStatus(statusEl, error.message || 'Unable to override right now.', STATUS_CLASS_ERROR);
      }
    });
  }

  function setButtonBusy(button, busy, label) {
    if (!button) return;
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent;
    }
    if (busy) {
      button.dataset.loading = 'true';
      if (label) button.textContent = label;
      button.disabled = true;
    } else {
      delete button.dataset.loading;
      button.disabled = false;
      if (button.dataset.defaultLabel) {
        button.textContent = button.dataset.defaultLabel;
      }
    }
  }

  function setStatus(el, message, toneClass) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove(STATUS_CLASS_SUCCESS, STATUS_CLASS_ERROR);
    if (toneClass && message) {
      el.classList.add(toneClass);
    }
    el.hidden = !message;
  }
})();
