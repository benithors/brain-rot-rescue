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

const SAVED_TIME_PER_BLOCK_MS = 5 * 60 * 1000; // Estimated focused time saved per block
const BLOCK_EVENT_LIMIT = 500;
const BLOCK_RETENTION_DAYS = 120;

const clone = (value) => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

let settings = clone(DEFAULT_SETTINGS);
let cooldowns = {};
let blockEvents = [];
let blockDailyTotals = {};
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
    const storedLocal = await chrome.storage.local.get(['cooldowns', 'blockEvents', 'blockDailyTotals']);
    cooldowns = cleanupCooldownMap(storedLocal.cooldowns || {});
    blockEvents = sanitizeBlockEvents(storedLocal.blockEvents || []);
    blockDailyTotals = sanitizeDailyTotals(storedLocal.blockDailyTotals || {});
    await chrome.storage.local.set({ cooldowns, blockEvents, blockDailyTotals });
  } catch (error) {
    console.error('Failed to load local state', error);
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
  if (areaName === 'local' && changes.blockEvents) {
    blockEvents = sanitizeBlockEvents(changes.blockEvents.newValue || []);
  }
  if (areaName === 'local' && changes.blockDailyTotals) {
    blockDailyTotals = sanitizeDailyTotals(changes.blockDailyTotals.newValue || {});
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

    recordBlockAttempt({ blockedHost, originalUrl: details.url }).catch((error) => {
      console.error('Failed to record block attempt', error);
    });

    const nextEntry = await pickNextReadingListEntry();
    if (nextEntry) {
      try {
        await redirectTabToEntry(tabId, blockedHost, details.url, nextEntry);
      } catch (error) {
        console.error('Failed to redirect to reading list entry', error);
        await sendTabToFallback(tabId, blockedHost, details.url);
      }
      return;
    }

    interceptSessions.delete(tabId);
    allowedNavigations.delete(tabId);
    await sendTabToFallback(tabId, blockedHost, details.url);
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
      case 'stats:get-block-activity': {
        const days = typeof message.days === 'number' ? message.days : undefined;
        const stats = getBlockStats(days);
        sendResponse({ status: 'ok', stats });
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

async function recordBlockAttempt({ blockedHost, originalUrl }) {
  await initPromise;
  const now = Date.now();
  const event = {
    ts: now,
    host: blockedHost,
    url: originalUrl,
    savedMs: SAVED_TIME_PER_BLOCK_MS
  };
  blockEvents.push(event);

  const dayKey = formatDayKey(now);
  const totals = blockDailyTotals[dayKey] || { count: 0, savedMs: 0 };
  blockDailyTotals = {
    ...blockDailyTotals,
    [dayKey]: {
      count: (totals.count || 0) + 1,
      savedMs: (totals.savedMs || 0) + event.savedMs
    }
  };

  pruneBlockData();

  await chrome.storage.local
    .set({ blockEvents, blockDailyTotals })
    .catch(() => {});

  return event;
}

function getBlockStats(days = 14) {
  pruneBlockData();
  const windowDays = clampDays(days);
  const recentKeys = getRecentDayKeys(windowDays);
  const dayRows = recentKeys.map((dayKey) => {
    const totals = blockDailyTotals[dayKey] || {};
    return {
      day: dayKey,
      count: typeof totals.count === 'number' ? totals.count : 0,
      savedMs: typeof totals.savedMs === 'number' ? totals.savedMs : 0
    };
  });

  const windowSavedMs = dayRows.reduce((sum, row) => sum + row.savedMs, 0);
  const windowCount = dayRows.reduce((sum, row) => sum + row.count, 0);
  const lifetimeSavedMs = Object.values(blockDailyTotals).reduce(
    (sum, totals) => sum + (totals?.savedMs || 0),
    0
  );
  const lifetimeCount = Object.values(blockDailyTotals).reduce(
    (sum, totals) => sum + (totals?.count || 0),
    0
  );

  return {
    days: dayRows,
    window: { days: windowDays, savedMs: windowSavedMs, count: windowCount },
    lifetime: { savedMs: lifetimeSavedMs, count: lifetimeCount },
    savedMsPerBlock: SAVED_TIME_PER_BLOCK_MS,
    retentionDays: BLOCK_RETENTION_DAYS
  };
}

function pruneBlockData() {
  const cutoffTs = Date.now() - BLOCK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  blockEvents = sanitizeBlockEvents(blockEvents, cutoffTs);
  blockDailyTotals = sanitizeDailyTotals(blockDailyTotals, cutoffTs);
}

function clampDays(days) {
  const value = Number.isFinite(days) ? days : Number(days);
  if (!Number.isFinite(value)) return 14;
  return Math.min(90, Math.max(1, Math.round(value)));
}

function getRecentDayKeys(count) {
  const keys = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    keys.push(formatDayKey(d.getTime()));
  }
  return keys;
}

function formatDayKey(timestamp) {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeBlockEvents(list, cutoffTs) {
  if (!Array.isArray(list)) return [];
  const cutoff = cutoffTs ?? Date.now() - BLOCK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cleaned = list
    .filter((item) => item && typeof item.ts === 'number' && item.ts >= cutoff)
    .map((item) => ({
      ts: item.ts,
      host: typeof item.host === 'string' ? item.host : '',
      url: typeof item.url === 'string' ? item.url : '',
      savedMs:
        typeof item.savedMs === 'number' && item.savedMs > 0
          ? Math.round(item.savedMs)
          : SAVED_TIME_PER_BLOCK_MS
    }));
  cleaned.sort((a, b) => a.ts - b.ts);
  return cleaned.slice(-BLOCK_EVENT_LIMIT);
}

function sanitizeDailyTotals(map, cutoffTs) {
  const cutoff = cutoffTs ?? Date.now() - BLOCK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (!map || typeof map !== 'object') return {};
  const cutoffDayKey = formatDayKey(cutoff);
  const next = {};
  for (const [dayKey, totals] of Object.entries(map)) {
    if (!dayKey || dayKey < cutoffDayKey) continue;
    const count = typeof totals?.count === 'number' ? Math.max(0, Math.round(totals.count)) : 0;
    const savedMs =
      typeof totals?.savedMs === 'number' && totals.savedMs > 0
        ? Math.round(totals.savedMs)
        : count * SAVED_TIME_PER_BLOCK_MS;
    if (count === 0 && savedMs === 0) continue;
    next[dayKey] = { count, savedMs };
  }
  return next;
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
