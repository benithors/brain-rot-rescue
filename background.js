const DEFAULT_BLOCKLIST = [
  'twitter.com',
  'x.com',
  'reddit.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'news.ycombinator.com'
];

const DEFAULT_COOLDOWN_MINUTES = 15;
const HOLD_TO_OVERRIDE_MS = 5000;

const DEFAULT_SETTINGS = {
  enabled: true,
  blocklist: DEFAULT_BLOCKLIST,
  cooldownMinutes: DEFAULT_COOLDOWN_MINUTES
};

const clone = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

let settings = clone(DEFAULT_SETTINGS);
let cooldowns = {};
const interceptSessions = new Map(); // tabId -> session metadata
const allowedNavigations = new Map(); // tabId -> comparableUrl currently allowed

const initPromise = initializeState();

async function initializeState() {
  try {
    const stored = await chrome.storage.sync.get('settings');
    if (stored.settings) {
      settings = mergeSettings(stored.settings);
    } else {
      await chrome.storage.sync.set({ settings });
    }
  } catch (error) {
    console.error('Failed to load settings', error);
  }

  try {
    const storedLocal = await chrome.storage.local.get('cooldowns');
    cooldowns = cleanupCooldownMap(storedLocal.cooldowns || {});
    await chrome.storage.local.set({ cooldowns });
  } catch (error) {
    console.error('Failed to load cooldowns', error);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    await chrome.storage.sync.set({ settings: clone(DEFAULT_SETTINGS) });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.settings) {
    settings = mergeSettings(changes.settings.newValue || DEFAULT_SETTINGS);
  }
  if (areaName === 'local' && changes.cooldowns) {
    cooldowns = cleanupCooldownMap(changes.cooldowns.newValue || {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  interceptSessions.delete(tabId);
  allowedNavigations.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const session = interceptSessions.get(details.tabId);
  if (!session) return;

  const currentUrl = comparableUrl(details.url);
  if (session.articleComparableUrl && currentUrl === session.articleComparableUrl) {
    return;
  }

  // Navigated away from the assigned article – clear the session.
  interceptSessions.delete(details.tabId);
  allowedNavigations.delete(details.tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    if (!details.url || details.tabId < 0) return;
    if (!/^https?:/i.test(details.url)) return;

    await initPromise;

    if (!settings.enabled) return;
    if (isExtensionOrChromeUrl(details.url)) return;

    const tabId = details.tabId;
    const normalizedUrl = comparableUrl(details.url);
    const allowedUrl = allowedNavigations.get(tabId);

    if (allowedUrl && normalizedUrl === allowedUrl) {
      return; // Expected navigation (e.g., loading assigned article).
    }
    if (allowedUrl && normalizedUrl !== allowedUrl) {
      allowedNavigations.delete(tabId);
    }

  const blockedHost = getBlockedEntryForUrl(details.url);
  if (!blockedHost) return;

  if (isCooldownActive(blockedHost)) {
    return;
  }
  await sendTabToDashboard(tabId, blockedHost, details.url);
  },
  { url: [{ schemes: ['http', 'https'] }] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'overlay:init': {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ status: 'noop' });
          return;
        }
        await initPromise;
        const session = interceptSessions.get(tabId);
        if (!session) {
          sendResponse({ status: 'noop' });
          return;
        }
        sendResponse({
          status: 'ok',
          session: {
            blockedHost: session.blockedHost,
            originalUrl: session.originalUrl,
            article: session.article,
            startedAt: session.startedAt,
            cooldownMinutes: settings.cooldownMinutes,
            holdDurationMs: HOLD_TO_OVERRIDE_MS
          }
        });
        return;
      }
      case 'overlay:mark-read': {
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ status: 'error', message: 'Missing tab context' });
          return;
        }
        const session = interceptSessions.get(tabId);
        if (!session?.article) {
          sendResponse({ status: 'error', message: 'No assigned article' });
          return;
        }
        try {
          await chrome.readingList.removeEntry({ url: session.article.url });
          interceptSessions.delete(tabId);
          allowedNavigations.delete(tabId);
          sendResponse({ status: 'ok' });
        } catch (error) {
          console.error('Failed to remove reading list entry', error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'overlay:load-next': {
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ status: 'error', message: 'Missing tab context' });
          return;
        }
        const session = interceptSessions.get(tabId);
        if (!session) {
          sendResponse({ status: 'error', message: 'No active session' });
          return;
        }
        const currentArticleUrl = session.article?.url;
        const nextEntry = await pickNextReadingListEntry({
          excludeUrls: currentArticleUrl ? [currentArticleUrl] : []
        });
        if (!nextEntry) {
          sendResponse({ status: 'error', message: 'No other unread items available' });
          return;
        }
        try {
          await redirectTabToEntry(tabId, session.blockedHost, session.originalUrl, nextEntry);
          sendResponse({ status: 'ok' });
        } catch (error) {
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'overlay:override': {
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ status: 'error', message: 'Missing tab context' });
          return;
        }
        const session = interceptSessions.get(tabId);
        if (!session) {
          sendResponse({ status: 'error', message: 'Nothing to override' });
          return;
        }
        try {
          await grantOverride(tabId, session);
          sendResponse({ status: 'ok' });
        } catch (error) {
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'focus:override': {
        const { blockedHost, originalUrl, tabId } = message.payload || {};
        const resolvedTabId = tabId ?? sender.tab?.id;
        if (!blockedHost || !originalUrl || resolvedTabId == null) {
          sendResponse({ status: 'error', message: 'Missing override details' });
          return;
        }
        await startCooldown(blockedHost);
        try {
          await chrome.tabs.update(resolvedTabId, { url: originalUrl });
          sendResponse({ status: 'ok' });
        } catch (error) {
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'focus:load-article': {
        const { blockedHost, originalUrl, tabId } = message.payload || {};
        const resolvedTabId = tabId ?? sender.tab?.id;
        if (resolvedTabId == null) {
          sendResponse({ status: 'error', message: 'Missing tab context' });
          return;
        }
        await initPromise;
        const hostLabel =
          blockedHost ||
          (originalUrl ? getBlockedEntryForUrl(originalUrl) : null) ||
          'this site';
        const entry = await pickNextReadingListEntry();
        if (!entry) {
          sendResponse({ status: 'error', message: 'Still no unread items in the Reading List.' });
          return;
        }
        try {
          await redirectTabToEntry(resolvedTabId, hostLabel, originalUrl || '', entry);
          sendResponse({ status: 'ok' });
        } catch (error) {
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'popup:get-state': {
        await initPromise;
        cleanupExpiredCooldowns();
        const cooldownEntries = Object.entries(cooldowns)
          .filter(([, expiresAt]) => typeof expiresAt === 'number' && expiresAt > Date.now())
          .map(([host, expiresAt]) => ({ host, expiresAt }));
        sendResponse({
          status: 'ok',
          settings,
          cooldowns: cooldownEntries,
          defaults: DEFAULT_SETTINGS
        });
        return;
      }
      case 'popup:set-enabled': {
        await updateSettings({ enabled: Boolean(message.enabled) });
        sendResponse({ status: 'ok' });
        return;
      }
      case 'popup:add-block-entry': {
        const normalized = normalizeDomain(message.host || '');
        if (!normalized) {
          sendResponse({ status: 'error', message: 'Enter a valid domain' });
          return;
        }
        if (settings.blocklist.includes(normalized)) {
          sendResponse({ status: 'error', message: 'Domain already blocked' });
          return;
        }
        const nextBlocklist = [...settings.blocklist, normalized];
        await updateSettings({ blocklist: nextBlocklist });
        sendResponse({ status: 'ok' });
        return;
      }
      case 'popup:remove-block-entry': {
        const normalized = normalizeDomain(message.host || '');
        const filtered = settings.blocklist.filter((item) => item !== normalized);
        await updateSettings({ blocklist: filtered });
        sendResponse({ status: 'ok' });
        return;
      }
      case 'popup:quick-add-reading-entry': {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.url) {
            sendResponse({ status: 'error', message: 'Active tab has no URL' });
            return;
          }
          await chrome.readingList.addEntry({
            url: tab.url,
            title: tab.title || tab.url,
            hasBeenRead: false
          });
          sendResponse({ status: 'ok' });
        } catch (error) {
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      case 'popup:clear-cooldown': {
        const normalized = normalizeDomain(message.host || '');
        if (!normalized) {
          sendResponse({ status: 'error', message: 'Invalid domain' });
          return;
        }
        delete cooldowns[normalized];
        await chrome.storage.local.set({ cooldowns });
        sendResponse({ status: 'ok' });
        return;
      }
      default:
        sendResponse({ status: 'noop' });
    }
  })();
  return true;
});

async function redirectTabToEntry(tabId, blockedHost, originalUrl, entry) {
  const comparableArticleUrl = comparableUrl(entry.url);
  allowedNavigations.set(tabId, comparableArticleUrl);
  interceptSessions.set(tabId, {
    blockedHost,
    originalUrl,
    article: {
      title: entry.title,
      url: entry.url,
      creationTime: entry.creationTime
    },
    articleComparableUrl: comparableArticleUrl,
    startedAt: Date.now()
  });
  try {
    await chrome.tabs.update(tabId, { url: entry.url });
  } catch (error) {
    console.error('Failed to redirect to reading list entry', error);
    interceptSessions.delete(tabId);
    allowedNavigations.delete(tabId);
    throw error;
  }
}

async function sendTabToFallback(tabId, blockedHost, originalUrl) {
  const focusUrl = new URL(chrome.runtime.getURL('focus/focus.html'));
  focusUrl.searchParams.set('blocked', blockedHost);
  focusUrl.searchParams.set('original', originalUrl);
  focusUrl.searchParams.set('cooldown', String(settings.cooldownMinutes));
  focusUrl.searchParams.set('holdMs', String(HOLD_TO_OVERRIDE_MS));
  try {
    await chrome.tabs.update(tabId, { url: focusUrl.toString() });
  } catch (error) {
    console.error('Failed to open fallback page', error);
  }
}

async function sendTabToDashboard(tabId, blockedHost, originalUrl) {
  const dashUrl = new URL(chrome.runtime.getURL('dashboard/dashboard.html'));
  dashUrl.searchParams.set('blocked', blockedHost);
  dashUrl.searchParams.set('original', originalUrl);
  dashUrl.searchParams.set('cooldown', String(settings.cooldownMinutes));
  dashUrl.searchParams.set('holdMs', String(HOLD_TO_OVERRIDE_MS));
  try {
    await chrome.tabs.update(tabId, { url: dashUrl.toString() });
  } catch (error) {
    console.error('Failed to open dashboard page', error);
  }
}

async function grantOverride(tabId, session) {
  await startCooldown(session.blockedHost);
  interceptSessions.delete(tabId);
  allowedNavigations.delete(tabId);
  try {
    await chrome.tabs.update(tabId, { url: session.originalUrl });
  } catch (error) {
    console.error('Failed to restore original tab after override', error);
    throw error;
  }
}

async function startCooldown(blockedHost) {
  await initPromise;
  cleanupExpiredCooldowns();
  const expiresAt = Date.now() + settings.cooldownMinutes * 60 * 1000;
  cooldowns = { ...cooldowns, [blockedHost]: expiresAt };
  await chrome.storage.local.set({ cooldowns });
}

function isCooldownActive(blockedHost) {
  cleanupExpiredCooldowns();
  const expiresAt = cooldowns[blockedHost];
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

function cleanupCooldownMap(map) {
  const cleaned = { ...map };
  const now = Date.now();
  for (const [host, expiresAt] of Object.entries(cleaned)) {
    if (typeof expiresAt !== 'number' || expiresAt <= now) {
      delete cleaned[host];
    }
  }
  return cleaned;
}

function cleanupExpiredCooldowns() {
  const cleaned = cleanupCooldownMap(cooldowns);
  const changed = Object.keys(cleaned).length !== Object.keys(cooldowns).length;
  cooldowns = cleaned;
  if (changed) {
    chrome.storage.local.set({ cooldowns }).catch(() => {});
  }
}

async function pickNextReadingListEntry(options = {}) {
  const { excludeUrls = [] } = options;
  let entries = [];
  try {
    entries = await chrome.readingList.query({ hasBeenRead: false });
  } catch (error) {
    console.error('Failed to query reading list', error);
    return null;
  }
  entries.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
  const excludeSet = new Set();
  excludeUrls.forEach((url) => {
    const normalized = comparableUrl(url);
    if (normalized) excludeSet.add(normalized);
  });
  interceptSessions.forEach((session) => {
    if (session.articleComparableUrl) {
      excludeSet.add(session.articleComparableUrl);
    }
  });
  for (const entry of entries) {
    if (!entry.url) continue;
    const comparable = comparableUrl(entry.url);
    if (!comparable || excludeSet.has(comparable)) {
      continue;
    }
    return entry;
  }
  return null;
}

async function updateSettings(partial) {
  await initPromise;
  const merged = mergeSettings({ ...settings, ...partial });
  settings = merged;
  await chrome.storage.sync.set({ settings: merged });
}

function mergeSettings(partial = {}) {
  const base = settings ?? DEFAULT_SETTINGS;
  const blocklistSource = Array.isArray(partial.blocklist)
    ? partial.blocklist
    : Array.isArray(base.blocklist)
    ? base.blocklist
    : DEFAULT_BLOCKLIST;
  const normalizedBlocklist = sanitizeBlocklist(blocklistSource);
  return {
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : base.enabled,
    blocklist: normalizedBlocklist,
    cooldownMinutes:
      typeof partial.cooldownMinutes === 'number' && partial.cooldownMinutes > 0
        ? Math.min(120, Math.max(1, Math.round(partial.cooldownMinutes)))
        : (base.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES)
  };
}

function sanitizeBlocklist(list) {
  const seen = new Set();
  const sanitized = [];
  for (const entry of list || []) {
    const normalized = normalizeDomain(entry || '');
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      sanitized.push(normalized);
    }
  }
  sanitized.sort();
  return sanitized;
}

function normalizeDomain(value) {
  if (!value) return '';
  let input = value.trim().toLowerCase();
  if (!input) return '';
  input = input.replace(/^https?:\/\//, '');
  input = input.replace(/^www\./, '');
  input = input.replace(/^\*\.?/, '');
  input = input.split('/')[0];
  input = input.split(':')[0];
  return input;
}

function extractHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function getBlockedEntryForUrl(url) {
  const host = extractHost(url);
  if (!host) return null;
  return settings.blocklist.find((blocked) => host === blocked || host.endsWith(`.${blocked}`)) || null;
}

function isExtensionOrChromeUrl(url) {
  return /^(chrome|edge|about|brave|vivaldi|opera):/i.test(url) || url.startsWith(chrome.runtime.getURL(''));
}

function comparableUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    const origin = u.origin;
    let path = u.pathname;
    if (path === '/') path = '';
    return `${origin}${path}${u.search}`;
  } catch (error) {
    return url;
  }
}
