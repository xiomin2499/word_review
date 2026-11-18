import {
  DEFAULT_CAPTURE_OPTIONS,
  applyOpsToStore,
  computeStats,
  createEmptyStore,
  createOpId,
  extractStudyEntry,
  isLikelyTypingCorrection,
  normalizeStore,
  shouldCaptureLookup,
} from '../lib/sync-core.js';
import {
  findOrCreateVocabGist,
  syncVocabGist,
  validateToken,
} from '../lib/gist-client.js';

const STORAGE_KEYS = {
  SETTINGS: 'settings',
  STORE: 'vocabStore',
  PENDING_OPS: 'pendingOps',
  SYNC_STATE: 'syncState',
  RECENT_AUTO: 'recentAutoMeta',
};

const DEFAULT_SETTINGS = {
  ...DEFAULT_CAPTURE_OPTIONS,
  enablePrefixReplace: true,
  token: '',
  gistId: '',
  githubUser: '',
  pwaUrl: '',
};

const DEFAULT_SYNC_STATE = {
  etag: '',
  lastSyncAt: '',
  status: 'idle', // idle | syncing | ok | error | unconfigured
  error: '',
};

let stateQueue = Promise.resolve();
let syncTimer = null;
let syncPromise = null;

function withStateLock(fn) {
  const next = stateQueue.then(fn, fn);
  stateQueue = next.catch(() => {});
  return next;
}

async function loadState() {
  const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const settings = { ...DEFAULT_SETTINGS, ...(raw[STORAGE_KEYS.SETTINGS] || {}) };
  const vocabStore = normalizeStore(raw[STORAGE_KEYS.STORE] || createEmptyStore());
  const pendingOps = Array.isArray(raw[STORAGE_KEYS.PENDING_OPS]) ? raw[STORAGE_KEYS.PENDING_OPS] : [];
  const syncState = { ...DEFAULT_SYNC_STATE, ...(raw[STORAGE_KEYS.SYNC_STATE] || {}) };
  const recentAutoMeta = raw[STORAGE_KEYS.RECENT_AUTO] || null;
  return { settings, vocabStore, pendingOps, syncState, recentAutoMeta };
}

async function saveState(partial) {
  await chrome.storage.local.set(partial);
}

async function updateBadge(vocabStore) {
  try {
    const stats = computeStats(vocabStore);
    const count = stats.due > 0 ? String(Math.min(999, stats.due)) : '';
    await chrome.action.setBadgeText({ text: count });
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  } catch {
    // Ignore badge errors in restricted states
  }
}

async function fetchGoogleTranslateEnrichment(text, sourceLang = 'auto', targetLang = 'zh-CN') {
  try {
    const sl = sourceLang || 'auto';
    const tl = targetLang || 'zh-CN';
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx` +
      `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}` +
      `&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(text)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();

    let translatedText = '';
    if (Array.isArray(data?.[0])) {
      translatedText = data[0]
        .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
        .join('')
        .trim();
    }

    let phonetic = '';
    if (Array.isArray(data?.[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[3] === 'string' && seg[3].trim()) {
          phonetic = seg[3].trim();
          break;
        }
      }
    }

    const alternatives = [];
    if (Array.isArray(data?.[1])) {
      for (const group of data[1]) {
        const pos = typeof group?.[0] === 'string' ? group[0] : '';
        const terms = Array.isArray(group?.[1]) ? group[1].slice(0, 3).join('、') : '';
        if (terms) {
          alternatives.push(pos ? `${pos}: ${terms}` : terms);
        }
        if (alternatives.length >= 4) break;
      }
    }

    const detectedLang = typeof data?.[2] === 'string' ? data[2] : sl;
    return { translatedText, phonetic, alternatives, detectedLang };
  } catch {
    return null;
  }
}

async function runSyncNow() {
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const initial = await loadState();
    const { token, gistId } = initial.settings;

    if (!token || !gistId) {
      const syncState = {
        ...initial.syncState,
        status: 'unconfigured',
        error: '尚未配置 GitHub Token 或 Gist',
      };
      await saveState({ [STORAGE_KEYS.SYNC_STATE]: syncState });
      return { ok: false, syncState };
    }

    await saveState({
      [STORAGE_KEYS.SYNC_STATE]: { ...initial.syncState, status: 'syncing', error: '' },
    });

    try {
      const opsSnapshot = [...initial.pendingOps];
      const result = await syncVocabGist({
        token,
        gistId,
        pendingOps: opsSnapshot,
        etag: initial.syncState.etag,
      });

      return await withStateLock(async () => {
        const latest = await loadState();
        const syncedIds = new Set(opsSnapshot.map((o) => o.opId));
        const remainingOps = latest.pendingOps.filter((o) => !syncedIds.has(o.opId));

        let nextStore = latest.vocabStore;
        if (result.changed && result.store) {
          nextStore = remainingOps.length > 0 ? applyOpsToStore(result.store, remainingOps) : result.store;
        }

        const nextSyncState = {
          etag: result.etag || latest.syncState.etag,
          lastSyncAt: new Date().toISOString(),
          status: 'ok',
          error: '',
        };

        await saveState({
          [STORAGE_KEYS.STORE]: nextStore,
          [STORAGE_KEYS.PENDING_OPS]: remainingOps,
          [STORAGE_KEYS.SYNC_STATE]: nextSyncState,
        });
        await updateBadge(nextStore);

        if (remainingOps.length > 0) {
          scheduleSync(1200);
        }

        return { ok: true, syncState: nextSyncState, store: nextStore };
      });
    } catch (err) {
      const nextSyncState = {
        ...initial.syncState,
        status: 'error',
        error: err.message || '同步失败',
      };
      await saveState({ [STORAGE_KEYS.SYNC_STATE]: nextSyncState });
      return { ok: false, syncState: nextSyncState, error: nextSyncState.error };
    }
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
}

function scheduleSync(delayMs = 1500) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    runSyncNow();
  }, delayMs);
}

async function handleLookupCandidate(rawPayload) {
  const preState = await loadState();
  const force = Boolean(rawPayload?.force);
  if (!force && !preState.settings.enabled) {
    return { recorded: false, skippedReason: 'disabled' };
  }

  let payload = { ...rawPayload };
  // Enrich with phonetic & alternatives, or recover translation if DOM selectors missed
  if (!payload.translatedText || !payload.alternatives?.length || !payload.phonetic) {
    const enriched = await fetchGoogleTranslateEnrichment(
      payload.sourceText,
      payload.sourceLang,
      payload.targetLang
    );
    if (enriched) {
      if (!payload.translatedText && enriched.translatedText) {
        payload.translatedText = enriched.translatedText;
      }
      if (!payload.phonetic && enriched.phonetic) {
        payload.phonetic = enriched.phonetic;
      }
      if ((!payload.alternatives || payload.alternatives.length === 0) && enriched.alternatives?.length) {
        payload.alternatives = enriched.alternatives;
      }
      if ((!payload.sourceLang || payload.sourceLang === 'auto') && enriched.detectedLang) {
        payload.sourceLang = enriched.detectedLang;
      }
    }
  }

  const check = shouldCaptureLookup(payload, preState.settings);
  if (!check.ok) {
    return { recorded: false, skippedReason: check.reason };
  }

  const entry = extractStudyEntry(payload);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  return withStateLock(async () => {
    const state = await loadState();
    const { settings, vocabStore, pendingOps, recentAutoMeta } = state;

    // Check cooldown against existing entry unless forced
    const existing = vocabStore.items[entry.id];
    if (!force && existing && !existing.deletedAt) {
      const lastMs = Date.parse(existing.lastLookupAt || '') || 0;
      if (nowMs >= lastMs && nowMs - lastMs < settings.cooldownMs) {
        return { recorded: false, skippedReason: 'cooldown', entry: existing };
      }
    }

    // Check if previous auto-captured word was a prefix/typo of this one
    let replaced = false;
    let op;
    const prevAutoId = recentAutoMeta?.lastId;
    const prevItem = prevAutoId ? vocabStore.items[prevAutoId] : null;
    if (
      !force &&
      settings.enablePrefixReplace !== false &&
      prevItem &&
      isLikelyTypingCorrection(prevItem, entry.word, nowMs, settings.correctionWindowMs)
    ) {
      replaced = true;
      op = {
        type: 'replace_lookup',
        opId: createOpId('rep'),
        timestamp: nowIso,
        replaceId: prevItem.id,
        entry,
        cooldownMs: 0,
      };
    } else {
      op = {
        type: 'upsert_lookup',
        opId: createOpId('up'),
        timestamp: nowIso,
        entry,
        cooldownMs: force ? 0 : settings.cooldownMs,
        starred: force ? Boolean(existing?.starred) : false,
      };
    }

    const undoSnapshot = existing && !existing.deletedAt ? { ...existing } : null;
    const nextStore = applyOpsToStore(vocabStore, [op]);
    const nextPending = [...pendingOps, op];
    const nextRecentMeta = {
      lastId: entry.id,
      lastAt: nowMs,
      undoTargetId: entry.id,
      undoSnapshot,
    };

    await saveState({
      [STORAGE_KEYS.STORE]: nextStore,
      [STORAGE_KEYS.PENDING_OPS]: nextPending,
      [STORAGE_KEYS.RECENT_AUTO]: nextRecentMeta,
    });
    await updateBadge(nextStore);
    scheduleSync(3000);

    return {
      recorded: true,
      replaced,
      entry: nextStore.items[entry.id],
    };
  });
}

async function handleUndoWord(id) {
  return withStateLock(async () => {
    const { vocabStore, pendingOps, recentAutoMeta } = await loadState();
    const target = vocabStore.items[id];
    if (!target) return { ok: false };

    const nowIso = new Date().toISOString();
    let op;
    let nextStore;

    // If this word existed previously before the latest lookup increment, restore its count cleanly via patch/state;
    // if it was newly created (lookupCount <= 1), delete it cleanly.
    if (
      recentAutoMeta?.undoTargetId === id &&
      recentAutoMeta.undoSnapshot &&
      recentAutoMeta.undoSnapshot.lookupCount >= 1 &&
      target.lookupCount > recentAutoMeta.undoSnapshot.lookupCount
    ) {
      nextStore = {
        ...vocabStore,
        updatedAt: nowIso,
        items: {
          ...vocabStore.items,
          [id]: { ...recentAutoMeta.undoSnapshot, updatedAt: nowIso },
        },
      };
      // Also remove the unsynced op from pendingOps if it hasn't synced yet
      const lastOp = pendingOps[pendingOps.length - 1];
      const nextPending =
        lastOp && lastOp.entry?.id === id ? pendingOps.slice(0, -1) : pendingOps;
      await saveState({
        [STORAGE_KEYS.STORE]: nextStore,
        [STORAGE_KEYS.PENDING_OPS]: nextPending,
        [STORAGE_KEYS.RECENT_AUTO]: null,
      });
      await updateBadge(nextStore);
      return { ok: true };
    }

    op = { type: 'delete', opId: createOpId('del'), timestamp: nowIso, id };
    nextStore = applyOpsToStore(vocabStore, [op]);
    await saveState({
      [STORAGE_KEYS.STORE]: nextStore,
      [STORAGE_KEYS.PENDING_OPS]: [...pendingOps, op],
      [STORAGE_KEYS.RECENT_AUTO]: null,
    });
    await updateBadge(nextStore);
    scheduleSync(800);
    return { ok: true };
  });
}

async function handleMutateOp(op) {
  return withStateLock(async () => {
    const { vocabStore, pendingOps } = await loadState();
    const nextStore = applyOpsToStore(vocabStore, [op]);
    await saveState({
      [STORAGE_KEYS.STORE]: nextStore,
      [STORAGE_KEYS.PENDING_OPS]: [...pendingOps, op],
    });
    await updateBadge(nextStore);
    scheduleSync(800);
    return { ok: true, store: nextStore };
  });
}

async function injectIntoOpenTranslateTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://translate.google.com/*', 'https://translate.google.com.hk/*'],
    });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting
        .insertCSS({ target: { tabId: tab.id }, files: ['content/translate-capture.css'] })
        .catch(() => {});
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content/translate-capture.js'] })
        .catch(() => {});
    }
  } catch {
    // Ignore tab injection failures
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { vocabStore } = await loadState();
  await updateBadge(vocabStore);
  chrome.alarms.create('periodic-sync', { periodInMinutes: 5 });
  await injectIntoOpenTranslateTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  const { vocabStore } = await loadState();
  await updateBadge(vocabStore);
  chrome.alarms.create('periodic-sync', { periodInMinutes: 5 });
  runSyncNow();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodic-sync') {
    runSyncNow();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'GET_STATE': {
        const state = await loadState();
        return {
          ...state,
          stats: computeStats(state.vocabStore),
        };
      }
      case 'GET_SETTINGS': {
        const { settings, syncState } = await loadState();
        return { settings, syncState };
      }
      case 'SAVE_SETTINGS': {
        return withStateLock(async () => {
          const { settings } = await loadState();
          const nextSettings = { ...settings, ...(msg.settings || {}) };
          await saveState({ [STORAGE_KEYS.SETTINGS]: nextSettings });
          return { ok: true, settings: nextSettings };
        });
      }
      case 'INIT_GIST': {
        const token = (msg.token || '').trim();
        const user = await validateToken(token);
        const gistInfo = await findOrCreateVocabGist(token);
        await withStateLock(async () => {
          const { settings } = await loadState();
          await saveState({
            [STORAGE_KEYS.SETTINGS]: {
              ...settings,
              token,
              gistId: gistInfo.gistId,
              githubUser: user.login,
              ...(msg.pwaUrl !== undefined ? { pwaUrl: msg.pwaUrl.trim() } : {}),
            },
          });
        });
        const syncRes = await runSyncNow();
        return {
          ok: true,
          user,
          gistInfo,
          syncRes,
        };
      }
      case 'LOOKUP_CANDIDATE':
        return handleLookupCandidate(msg.payload);
      case 'UNDO_WORD':
        return handleUndoWord(msg.id);
      case 'PATCH_WORD':
        return handleMutateOp({
          type: 'patch',
          opId: createOpId('pat'),
          timestamp: new Date().toISOString(),
          id: msg.id,
          patch: msg.patch,
        });
      case 'DELETE_WORD':
        return handleMutateOp({
          type: 'delete',
          opId: createOpId('del'),
          timestamp: new Date().toISOString(),
          id: msg.id,
        });
      case 'ADD_MANUAL_WORD': {
        const entry = extractStudyEntry({
          sourceText: msg.word,
          translatedText: msg.meaning,
          sourceLang: 'en',
          targetLang: 'zh-CN',
        });
        if (!entry.word || !entry.meaning) {
          return { ok: false, error: '请输入单词和释义' };
        }
        return handleMutateOp({
          type: 'upsert_lookup',
          opId: createOpId('man'),
          timestamp: new Date().toISOString(),
          entry,
          cooldownMs: 0,
          starred: Boolean(msg.starred),
        });
      }
      case 'IMPORT_STORE': {
        return withStateLock(async () => {
          const imported = normalizeStore(msg.store);
          const { vocabStore, pendingOps } = await loadState();
          const ops = Object.values(imported.items)
            .filter((item) => !item.deletedAt)
            .map((item) => ({
              type: 'upsert_lookup',
              opId: createOpId('imp'),
              timestamp: item.lastLookupAt || new Date().toISOString(),
              entry: item,
              cooldownMs: 0,
              starred: item.starred,
            }));
          const nextStore = applyOpsToStore(vocabStore, ops);
          await saveState({
            [STORAGE_KEYS.STORE]: nextStore,
            [STORAGE_KEYS.PENDING_OPS]: [...pendingOps, ...ops],
          });
          await updateBadge(nextStore);
          scheduleSync(500);
          return { ok: true, count: ops.length };
        });
      }
      case 'SYNC_NOW':
        return runSyncNow();
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })()
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));

  return true;
});
