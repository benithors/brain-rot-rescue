const DEFAULT_WRITE_QUOTA_BACKOFF_MS = 65_000;
const DEFAULT_BACKLOG_KEY = '__syncWriterBacklog';

const isWriteQuotaError = (error) => {
  const message = String(error?.message || '');
  return /MAX_WRITE_OPERATIONS/i.test(message);
};

const isBytesQuotaError = (error) => {
  const message = String(error?.message || '');
  return /QUOTA_BYTES/i.test(message) || /MAX_ITEMS/i.test(message);
};

const mergePending = (pending, patch) => ({ ...pending, ...patch });

export function createSyncWriter(options = {}) {
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 1000;
  const writeQuotaBackoffMs = Number.isFinite(options.writeQuotaBackoffMs)
    ? Math.max(1000, options.writeQuotaBackoffMs)
    : DEFAULT_WRITE_QUOTA_BACKOFF_MS;
  const backlogKey = typeof options.backlogKey === 'string' ? options.backlogKey : DEFAULT_BACKLOG_KEY;
  const onBytesQuotaExceeded =
    typeof options.onBytesQuotaExceeded === 'function' ? options.onBytesQuotaExceeded : null;
  const onWriteError = typeof options.onWriteError === 'function' ? options.onWriteError : null;

  let pending = {};
  let flushPromise = null;
  let flushTimer = null;
  let backoffUntil = 0;
  let hydrated = false;

  const hydratePromise = chrome.storage.local
    .get(backlogKey)
    .then((result) => {
      const backlog = result?.[backlogKey];
      if (backlog && typeof backlog === 'object' && Object.keys(backlog).length) {
        pending = mergePending(pending, backlog);
      }
      hydrated = true;
    })
    .catch(() => {
      hydrated = true;
    });

  const persistBacklog = async () => {
    try {
      await chrome.storage.local.set({ [backlogKey]: pending });
    } catch (_error) {
      // ignore
    }
  };

  const clearBacklog = async () => {
    try {
      await chrome.storage.local.remove(backlogKey);
    } catch (_error) {
      // ignore
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    const now = Date.now();
    const waitMs = Math.max(delayMs, backoffUntil - now);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, waitMs);
  };

  const setBackoff = () => {
    backoffUntil = Math.max(backoffUntil, Date.now() + writeQuotaBackoffMs);
  };

  const flush = async () => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      if (!hydrated) {
        await hydratePromise;
      }
      if (!Object.keys(pending).length) return;

      const now = Date.now();
      if (now < backoffUntil) {
        await persistBacklog();
        scheduleFlush();
        return;
      }

      const payload = pending;
      pending = {};

      try {
        await chrome.storage.sync.set(payload);
        await clearBacklog();
      } catch (error) {
        const mergedBack = mergePending(payload, pending);
        pending = mergedBack;
        await persistBacklog();

        if (isWriteQuotaError(error)) {
          setBackoff();
          scheduleFlush();
          return;
        }

        if (isBytesQuotaError(error) && onBytesQuotaExceeded) {
          const reduced = onBytesQuotaExceeded(pending);
          if (reduced && typeof reduced === 'object') {
            pending = reduced;
          }
          try {
            await chrome.storage.sync.set(pending);
            pending = {};
            await clearBacklog();
            return;
          } catch (retryError) {
            await persistBacklog();
            onWriteError?.(retryError);
            return;
          }
        }

        onWriteError?.(error);
      }
    })().finally(() => {
      flushPromise = null;
      if (Object.keys(pending).length) {
        scheduleFlush();
      }
    });

    return flushPromise;
  };

  const queueSet = (patch, queueOptions = {}) => {
    if (!patch || typeof patch !== 'object') return Promise.resolve();
    pending = mergePending(pending, patch);
    if (queueOptions.flushNow) {
      return flush();
    }
    scheduleFlush();
    return Promise.resolve();
  };

  return {
    queueSet,
    flush
  };
}
