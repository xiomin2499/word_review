/**
 * Shared pure-JS core logic for WordReview (Chrome Extension + Mobile PWA + Node tests).
 * Canonical source: shared/sync-core.js
 */

export const STORE_VERSION = 1;
export const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
  enabled: true,
  debounceMs: 2200,
  maxLength: 60,
  maxWords: 5,
  ignoreIdentical: true,
  cooldownMs: 5 * 60 * 1000,
  correctionWindowMs: 15 * 1000,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_OP_IDS = 120;

export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeWordId(word) {
  return normalizeText(word).toLowerCase();
}

export function countCJK(text) {
  const matches = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

export function countLatin(text) {
  const matches = text.match(/[a-zA-Z]/g);
  return matches ? matches.length : 0;
}

export function isMostlyCJK(text) {
  const cjk = countCJK(text);
  const latin = countLatin(text);
  return cjk > 0 && cjk >= latin;
}

export function hasLatinWords(text) {
  return /[a-zA-Z]{2,}/.test(text);
}

export function countWords(text) {
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  return normalized.split(/\s+/).length;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Validates whether a translation lookup should be captured into the vocabulary book.
 */
export function shouldCaptureLookup(candidate, options = {}) {
  const cfg = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
  const source = normalizeText(candidate?.sourceText);
  const translated = normalizeText(candidate?.translatedText);
  const force = Boolean(candidate?.force);

  if (!source) {
    return { ok: false, reason: 'empty_source' };
  }
  if (!translated) {
    return { ok: false, reason: 'empty_translation' };
  }

  if (cfg.ignoreIdentical && source.toLowerCase() === translated.toLowerCase()) {
    return { ok: false, reason: 'identical' };
  }

  // Reject pure numbers, symbols, punctuation
  if (/^[\d\s\p{P}\p{S}]+$/u.test(source)) {
    return { ok: false, reason: 'non_word' };
  }

  if (!force) {
    if (/^(https?:\/\/|www\.)/i.test(source)) {
      return { ok: false, reason: 'url' };
    }
    // Single ASCII char is almost always mid-typing noise
    if (source.length < 2 && /^[\x00-\x7F]+$/.test(source)) {
      return { ok: false, reason: 'too_short' };
    }
    // Single CJK char is only kept if its translation is a real foreign word (>= 2 ASCII letters)
    if (source.length === 1 && countCJK(source) === 1 && !hasLatinWords(translated)) {
      return { ok: false, reason: 'too_short' };
    }
    // Code snippet guard
    if (source.length > 15 && /[{};<>]|=>|->|::/.test(source)) {
      return { ok: false, reason: 'code_snippet' };
    }
    if (source.length > cfg.maxLength) {
      return { ok: false, reason: 'too_long' };
    }
    if (countWords(source) > cfg.maxWords) {
      return { ok: false, reason: 'too_many_words' };
    }
  }

  return { ok: true, source, translated };
}

/**
 * Normalizes a captured lookup into a study card where `word` is the foreign/target term
 * and `meaning` is the native explanation (handling both en->zh and zh->en seamlessly).
 */
export function extractStudyEntry(candidate) {
  const sourceText = normalizeText(candidate?.sourceText);
  const translatedText = normalizeText(candidate?.translatedText);
  const sourceLang = normalizeText(candidate?.sourceLang) || 'auto';
  const targetLang = normalizeText(candidate?.targetLang) || 'zh-CN';
  const phonetic = normalizeText(candidate?.phonetic);
  const rawAlts = Array.isArray(candidate?.alternatives) ? candidate.alternatives : [];

  let word = sourceText;
  let meaning = translatedText;
  let direction = `${sourceLang}->${targetLang}`;

  if (isMostlyCJK(sourceText) && !isMostlyCJK(translatedText) && hasLatinWords(translatedText)) {
    word = translatedText;
    meaning = sourceText;
    direction = 'zh->en';
  } else if (!isMostlyCJK(sourceText) && isMostlyCJK(translatedText)) {
    direction = 'en->zh';
  }

  const alternatives = [];
  const seenAlts = new Set([meaning.toLowerCase()]);
  for (const alt of rawAlts) {
    const cleanAlt = normalizeText(alt);
    if (cleanAlt && !seenAlts.has(cleanAlt.toLowerCase())) {
      seenAlts.add(cleanAlt.toLowerCase());
      alternatives.push(cleanAlt);
    }
    if (alternatives.length >= 6) break;
  }

  return {
    id: normalizeWordId(word),
    word,
    meaning,
    phonetic,
    alternatives,
    sourceLang,
    targetLang,
    direction,
  };
}

/**
 * Checks whether a newly captured lookup is likely a typing continuation or typo fix
 * of the immediately preceding auto-captured item (e.g. "par" -> "params", "prams" -> "params").
 */
export function isLikelyTypingCorrection(prevItem, nextWord, nowMs = Date.now(), windowMs = DEFAULT_CAPTURE_OPTIONS.correctionWindowMs) {
  if (!prevItem || prevItem.deletedAt) return false;
  if (prevItem.starred) return false;
  if ((prevItem.lookupCount || 1) > 1) return false;
  if ((prevItem.reviewCount || 0) > 0) return false;

  const prevMs = Date.parse(prevItem.lastLookupAt || prevItem.updatedAt || '');
  if (!Number.isFinite(prevMs) || nowMs - prevMs > windowMs || nowMs < prevMs) {
    return false;
  }

  const a = normalizeWordId(prevItem.word);
  const b = normalizeWordId(nextWord);
  if (!a || !b || a === b) return false;

  // Only treat single-token or prefix extensions as typing corrections
  if (b.startsWith(a) || a.startsWith(b)) {
    return true;
  }

  if (a.length >= 3 && b.length >= 3) {
    const dist = levenshtein(a, b);
    if (a[0] === b[0] && dist <= 1) return true;
    if (a.slice(0, 2) === b.slice(0, 2) && dist <= 2) return true;
  }

  return false;
}

export function createEmptyStore(nowIso = new Date().toISOString()) {
  return {
    version: STORE_VERSION,
    updatedAt: nowIso,
    recentOpIds: [],
    items: {},
  };
}

export function normalizeStore(raw) {
  const nowIso = new Date().toISOString();
  if (!raw || typeof raw !== 'object') {
    return createEmptyStore(nowIso);
  }
  const items = {};
  if (raw.items && typeof raw.items === 'object') {
    for (const [key, val] of Object.entries(raw.items)) {
      if (!val || typeof val !== 'object' || !val.word) continue;
      const id = normalizeWordId(val.id || key || val.word);
      if (!id) continue;
      items[id] = {
        id,
        word: normalizeText(val.word),
        meaning: normalizeText(val.meaning),
        phonetic: normalizeText(val.phonetic),
        alternatives: Array.isArray(val.alternatives)
          ? val.alternatives.map(normalizeText).filter(Boolean).slice(0, 6)
          : [],
        sourceLang: normalizeText(val.sourceLang) || 'auto',
        targetLang: normalizeText(val.targetLang) || 'zh-CN',
        direction: normalizeText(val.direction) || 'en->zh',
        lookupCount: Math.max(1, Number(val.lookupCount) || 1),
        reviewCount: Math.max(0, Number(val.reviewCount) || 0),
        intervalDays: Math.max(0, Number(val.intervalDays) || 0),
        status: val.status === 'mastered' ? 'mastered' : 'learning',
        starred: Boolean(val.starred),
        note: typeof val.note === 'string' ? val.note.trim() : '',
        firstLookupAt: val.firstLookupAt || val.updatedAt || nowIso,
        lastLookupAt: val.lastLookupAt || val.updatedAt || nowIso,
        nextReviewAt: val.nextReviewAt || val.lastLookupAt || nowIso,
        updatedAt: val.updatedAt || nowIso,
        deletedAt: val.deletedAt || null,
      };
    }
  }

  const recentOpIds = Array.isArray(raw.recentOpIds)
    ? raw.recentOpIds.filter((id) => typeof id === 'string').slice(-MAX_RECENT_OP_IDS)
    : [];

  return {
    version: STORE_VERSION,
    updatedAt: raw.updatedAt || nowIso,
    recentOpIds,
    items,
  };
}

export function createOpId(prefix = 'op') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function addDaysIso(baseIso, days) {
  const baseMs = Date.parse(baseIso) || Date.now();
  return new Date(baseMs + days * DAY_MS).toISOString();
}

function applyUpsertLookup(items, op) {
  const entry = op.entry;
  if (!entry || !entry.word) return;
  const id = normalizeWordId(entry.id || entry.word);
  if (!id) return;

  const ts = op.timestamp || new Date().toISOString();
  const tsMs = Date.parse(ts) || Date.now();
  const cooldownMs = Number.isFinite(op.cooldownMs) ? op.cooldownMs : DEFAULT_CAPTURE_OPTIONS.cooldownMs;
  const existing = items[id];

  if (!existing || existing.deletedAt) {
    items[id] = {
      id,
      word: entry.word,
      meaning: entry.meaning || '',
      phonetic: entry.phonetic || '',
      alternatives: Array.isArray(entry.alternatives) ? entry.alternatives.slice(0, 6) : [],
      sourceLang: entry.sourceLang || 'auto',
      targetLang: entry.targetLang || 'zh-CN',
      direction: entry.direction || 'en->zh',
      lookupCount: 1,
      reviewCount: 0,
      intervalDays: 0,
      status: 'learning',
      starred: Boolean(op.starred),
      note: '',
      firstLookupAt: ts,
      lastLookupAt: ts,
      nextReviewAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    return;
  }

  const lastMs = Date.parse(existing.lastLookupAt || '') || 0;
  const withinCooldown = tsMs >= lastMs && tsMs - lastMs < cooldownMs;

  const mergedAlts = [...(existing.alternatives || [])];
  for (const alt of entry.alternatives || []) {
    if (alt && !mergedAlts.includes(alt) && alt.toLowerCase() !== (entry.meaning || '').toLowerCase()) {
      mergedAlts.push(alt);
    }
  }

  items[id] = {
    ...existing,
    word: entry.word || existing.word,
    meaning: entry.meaning || existing.meaning,
    phonetic: entry.phonetic || existing.phonetic,
    alternatives: mergedAlts.slice(0, 6),
    lookupCount: withinCooldown ? existing.lookupCount : existing.lookupCount + 1,
    // If user had to look up a "mastered" word again, put it back into learning!
    status: !withinCooldown && existing.status === 'mastered' ? 'learning' : existing.status,
    intervalDays: !withinCooldown && existing.status === 'mastered' ? 0 : existing.intervalDays,
    nextReviewAt: !withinCooldown && existing.status === 'mastered' ? ts : existing.nextReviewAt,
    starred: op.starred ? true : existing.starred,
    lastLookupAt: tsMs >= lastMs ? ts : existing.lastLookupAt,
    updatedAt: ts,
  };
}

export function applyReviewAction(item, rating, nowIso = new Date().toISOString()) {
  const prevInterval = Math.max(0, Number(item.intervalDays) || 0);
  let intervalDays = prevInterval;
  let status = item.status === 'mastered' ? 'mastered' : 'learning';
  let nextReviewAt = nowIso;

  switch (rating) {
    case 'again':
      intervalDays = 0;
      status = 'learning';
      nextReviewAt = nowIso;
      break;
    case 'hard':
      intervalDays = prevInterval > 0 ? Math.max(1, Math.round(prevInterval * 1.2)) : 1;
      status = 'learning';
      nextReviewAt = addDaysIso(nowIso, intervalDays);
      break;
    case 'good':
      intervalDays = prevInterval > 0 ? Math.min(60, Math.max(prevInterval + 1, Math.round(prevInterval * 2.2))) : 1;
      status = intervalDays >= 14 ? 'mastered' : 'learning';
      nextReviewAt = addDaysIso(nowIso, intervalDays);
      break;
    case 'master':
      intervalDays = 30;
      status = 'mastered';
      nextReviewAt = addDaysIso(nowIso, 30);
      break;
    default:
      break;
  }

  return {
    ...item,
    reviewCount: (item.reviewCount || 0) + 1,
    intervalDays,
    status,
    nextReviewAt,
    updatedAt: nowIso,
  };
}

/**
 * Replays pending local operations onto a store snapshot idempotently.
 */
export function applyOpsToStore(baseStore, ops = []) {
  const store = normalizeStore(baseStore);
  const seen = new Set(store.recentOpIds);
  const recentOpIds = [...store.recentOpIds];
  let latestTs = store.updatedAt;

  for (const op of ops) {
    if (!op || !op.type) continue;
    if (op.opId && seen.has(op.opId)) {
      continue;
    }

    const ts = op.timestamp || new Date().toISOString();
    if (ts > latestTs) latestTs = ts;

    switch (op.type) {
      case 'upsert_lookup': {
        applyUpsertLookup(store.items, op);
        break;
      }
      case 'replace_lookup': {
        const replaceId = normalizeWordId(op.replaceId);
        const target = replaceId ? store.items[replaceId] : null;
        if (target && !target.starred && (target.lookupCount || 1) <= 1 && (target.reviewCount || 0) === 0) {
          delete store.items[replaceId];
        }
        applyUpsertLookup(store.items, op);
        break;
      }
      case 'review': {
        const id = normalizeWordId(op.id);
        const target = id ? store.items[id] : null;
        if (target && !target.deletedAt) {
          store.items[id] = applyReviewAction(target, op.rating, ts);
        }
        break;
      }
      case 'patch': {
        const id = normalizeWordId(op.id);
        const target = id ? store.items[id] : null;
        if (target && !target.deletedAt && op.patch && typeof op.patch === 'object') {
          const next = { ...target };
          if (typeof op.patch.starred === 'boolean') next.starred = op.patch.starred;
          if (typeof op.patch.note === 'string') next.note = op.patch.note.trim();
          if (op.patch.status === 'learning' || op.patch.status === 'mastered') {
            next.status = op.patch.status;
          }
          if (typeof op.patch.word === 'string' && normalizeText(op.patch.word)) {
            next.word = normalizeText(op.patch.word);
          }
          if (typeof op.patch.meaning === 'string' && normalizeText(op.patch.meaning)) {
            next.meaning = normalizeText(op.patch.meaning);
          }
          next.updatedAt = ts;
          store.items[id] = next;
        }
        break;
      }
      case 'delete': {
        const id = normalizeWordId(op.id);
        const target = id ? store.items[id] : null;
        if (target) {
          store.items[id] = {
            ...target,
            deletedAt: ts,
            updatedAt: ts,
          };
        }
        break;
      }
      default:
        break;
    }

    if (op.opId) {
      seen.add(op.opId);
      recentOpIds.push(op.opId);
    }
  }

  // Prune tombstones older than 30 days to keep JSON small
  const pruneCutoff = Date.now() - 30 * DAY_MS;
  for (const [id, item] of Object.entries(store.items)) {
    if (item.deletedAt) {
      const delMs = Date.parse(item.deletedAt);
      if (Number.isFinite(delMs) && delMs < pruneCutoff) {
        delete store.items[id];
      }
    }
  }

  store.recentOpIds = recentOpIds.slice(-MAX_RECENT_OP_IDS);
  store.updatedAt = latestTs;
  return store;
}

export function getActiveItems(store) {
  const normalized = normalizeStore(store);
  return Object.values(normalized.items).filter((item) => !item.deletedAt);
}

export function isDueForReview(item, nowMs = Date.now()) {
  if (!item || item.deletedAt || item.status === 'mastered') return false;
  const dueMs = Date.parse(item.nextReviewAt || item.lastLookupAt || '');
  if (!Number.isFinite(dueMs)) return true;
  return dueMs <= nowMs;
}

export function sortItems(items, mode = 'recent', nowMs = Date.now()) {
  const list = [...items];
  switch (mode) {
    case 'smart':
      return list.sort((a, b) => {
        const aDue = isDueForReview(a, nowMs) ? 1 : 0;
        const bDue = isDueForReview(b, nowMs) ? 1 : 0;
        if (aDue !== bDue) return bDue - aDue;
        const aScore = (a.starred ? 10 : 0) + (a.lookupCount || 1) * 2;
        const bScore = (b.starred ? 10 : 0) + (b.lookupCount || 1) * 2;
        if (aScore !== bScore) return bScore - aScore;
        return (b.lastLookupAt || '').localeCompare(a.lastLookupAt || '');
      });
    case 'freq':
      return list.sort((a, b) => {
        const diff = (b.lookupCount || 1) - (a.lookupCount || 1);
        if (diff !== 0) return diff;
        return (b.lastLookupAt || '').localeCompare(a.lastLookupAt || '');
      });
    case 'az':
      return list.sort((a, b) => a.word.localeCompare(b.word));
    case 'recent':
    default:
      return list.sort((a, b) => (b.lastLookupAt || '').localeCompare(a.lastLookupAt || ''));
  }
}

export function computeStats(store, nowMs = Date.now()) {
  const active = getActiveItems(store);
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  let dueCount = 0;
  let masteredCount = 0;
  let starredCount = 0;
  let todayNewCount = 0;
  let highFreqCount = 0;

  for (const item of active) {
    if (isDueForReview(item, nowMs)) dueCount += 1;
    if (item.status === 'mastered') masteredCount += 1;
    if (item.starred) starredCount += 1;
    if ((item.lookupCount || 1) >= 2) highFreqCount += 1;
    const firstMs = Date.parse(item.firstLookupAt || '');
    if (Number.isFinite(firstMs) && firstMs >= todayMs) todayNewCount += 1;
  }

  return {
    total: active.length,
    due: dueCount,
    mastered: masteredCount,
    learning: active.length - masteredCount,
    starred: starredCount,
    highFreq: highFreqCount,
    todayNew: todayNewCount,
  };
}
