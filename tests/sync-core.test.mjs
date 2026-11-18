import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOpsToStore,
  applyReviewAction,
  computeStats,
  createEmptyStore,
  createOpId,
  extractStudyEntry,
  isDueForReview,
  isLikelyTypingCorrection,
  normalizeStore,
  shouldCaptureLookup,
  simplifyAlternatives,
  simplifyMeaning,
  sortItems,
} from '../shared/sync-core.js';

test('shouldCaptureLookup filters screenshot-style typing noise and code snippets', () => {
  assert.equal(shouldCaptureLookup({ sourceText: '', translatedText: 'a' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: 'p', translatedText: 'p' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: '单词fu', translatedText: '单词fu' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: '单词复习', translatedText: '单词复习' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: 'https://google.com', translatedText: 'https://google.com' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: 'const fn = (a) => { return a; };', translatedText: '函数' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: '12345', translatedText: '12345' }).ok, false);

  const okEn = shouldCaptureLookup({ sourceText: 'params', translatedText: '参数' });
  assert.equal(okEn.ok, true);

  const okZh = shouldCaptureLookup({ sourceText: '单词', translatedText: 'word' });
  assert.equal(okZh.ok, true);

  // Too long sentence rejected by default, allowed when force=true
  const longText = 'This is a very long error message copied from terminal output during debugging';
  assert.equal(shouldCaptureLookup({ sourceText: longText, translatedText: '这是一条很长的报错信息' }).ok, false);
  assert.equal(shouldCaptureLookup({ sourceText: longText, translatedText: '这是一条很长的报错信息', force: true }).ok, true);
});

test('extractStudyEntry normalizes both en->zh and zh->en so English term is always the study word', () => {
  const enToZh = extractStudyEntry({
    sourceText: '  Params ',
    translatedText: '参数',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    alternatives: ['参数', '参量'],
    phonetic: '/pəˈræmz/',
  });
  assert.equal(enToZh.id, 'params');
  assert.equal(enToZh.word, 'Params');
  assert.equal(enToZh.meaning, '参数');
  assert.deepEqual(enToZh.alternatives, []);
  assert.equal(enToZh.direction, 'en->zh');

  const zhToEn = extractStudyEntry({
    sourceText: '单词',
    translatedText: 'word',
    sourceLang: 'auto',
    targetLang: 'en',
  });
  assert.equal(zhToEn.id, 'word');
  assert.equal(zhToEn.word, 'word');
  assert.equal(zhToEn.meaning, '单词');
  assert.equal(zhToEn.direction, 'zh->en');
});

test('isLikelyTypingCorrection catches partial typing and minor typos within 15s', () => {
  const baseTime = Date.parse('2026-11-18T10:00:00.000Z');
  const prev = {
    id: 'par',
    word: 'par',
    lookupCount: 1,
    reviewCount: 0,
    starred: false,
    lastLookupAt: '2026-11-18T10:00:00.000Z',
  };

  assert.equal(isLikelyTypingCorrection(prev, 'params', baseTime + 5000), true);
  assert.equal(isLikelyTypingCorrection(prev, 'params', baseTime + 25000), false);
  assert.equal(isLikelyTypingCorrection({ ...prev, starred: true }, 'params', baseTime + 5000), false);
  assert.equal(isLikelyTypingCorrection({ ...prev, lookupCount: 2 }, 'params', baseTime + 5000), false);

  const typoPrev = { ...prev, id: 'prams', word: 'prams' };
  assert.equal(isLikelyTypingCorrection(typoPrev, 'params', baseTime + 4000), true);
  assert.equal(isLikelyTypingCorrection(typoPrev, 'probe', baseTime + 4000), false);
});

test('applyOpsToStore handles lookup increments, cooldowns, re-learning mastered words, and idempotent replay', () => {
  let store = createEmptyStore('2026-11-18T10:00:00.000Z');
  const entry = extractStudyEntry({ sourceText: 'probe', translatedText: '探测' });

  const op1 = {
    type: 'upsert_lookup',
    opId: 'op-1',
    timestamp: '2026-11-18T10:00:00.000Z',
    entry,
    cooldownMs: 300000,
  };
  store = applyOpsToStore(store, [op1]);
  assert.equal(store.items.probe.lookupCount, 1);

  // Replaying exact same opId is idempotent
  store = applyOpsToStore(store, [op1]);
  assert.equal(store.items.probe.lookupCount, 1);

  // Lookup within 5-minute cooldown does not inflate lookupCount
  store = applyOpsToStore(store, [{
    type: 'upsert_lookup',
    opId: 'op-2',
    timestamp: '2026-11-18T10:02:00.000Z',
    entry,
    cooldownMs: 300000,
  }]);
  assert.equal(store.items.probe.lookupCount, 1);

  // Mark mastered on phone
  store = applyOpsToStore(store, [{
    type: 'review',
    opId: 'op-3',
    timestamp: '2026-11-18T12:00:00.000Z',
    id: 'probe',
    rating: 'master',
  }]);
  assert.equal(store.items.probe.status, 'mastered');
  assert.equal(store.items.probe.reviewCount, 1);

  // Looking up a previously mastered word again brings it back into learning and increments count!
  store = applyOpsToStore(store, [{
    type: 'upsert_lookup',
    opId: 'op-4',
    timestamp: '2026-11-18T15:00:00.000Z',
    entry,
    cooldownMs: 300000,
  }]);
  assert.equal(store.items.probe.lookupCount, 2);
  assert.equal(store.items.probe.status, 'learning');
});

test('replace_lookup removes transient prefix typo and keeps final word', () => {
  let store = createEmptyStore('2026-11-18T10:00:00.000Z');
  store = applyOpsToStore(store, [{
    type: 'upsert_lookup',
    opId: createOpId(),
    timestamp: '2026-11-18T10:00:00.000Z',
    entry: extractStudyEntry({ sourceText: 'par', translatedText: '标准' }),
  }]);
  assert.ok(store.items.par);

  store = applyOpsToStore(store, [{
    type: 'replace_lookup',
    opId: createOpId(),
    timestamp: '2026-11-18T10:00:05.000Z',
    replaceId: 'par',
    entry: extractStudyEntry({ sourceText: 'params', translatedText: '参数' }),
  }]);
  assert.equal(store.items.par, undefined);
  assert.equal(store.items.params.meaning, '参数');
});

test('review progression, due calculation, sorting, and stats work accurately', () => {
  const base = createEmptyStore('2026-11-18T00:00:00.000Z');
  let store = applyOpsToStore(base, [
    {
      type: 'upsert_lookup',
      opId: '1',
      timestamp: '2026-11-18T08:00:00.000Z',
      entry: extractStudyEntry({ sourceText: 'probe', translatedText: '探测' }),
    },
    {
      type: 'upsert_lookup',
      opId: '2',
      timestamp: '2026-11-18T08:10:00.000Z',
      entry: extractStudyEntry({ sourceText: 'params', translatedText: '参数' }),
    },
    {
      type: 'upsert_lookup',
      opId: '3',
      timestamp: '2026-11-18T08:20:00.000Z',
      entry: extractStudyEntry({ sourceText: 'params', translatedText: '参数' }),
    },
  ]);

  const nowMs = Date.parse('2026-11-18T09:00:00.000Z');
  const sortedFreq = sortItems(Object.values(store.items), 'freq', nowMs);
  assert.equal(sortedFreq[0].id, 'params');
  assert.equal(sortedFreq[0].lookupCount, 2);

  const reviewed = applyReviewAction(store.items.probe, 'good', '2026-11-18T09:00:00.000Z');
  assert.equal(reviewed.intervalDays, 1);
  assert.equal(isDueForReview(reviewed, nowMs + 1000), false);
  assert.equal(isDueForReview(reviewed, nowMs + 25 * 3600 * 1000), true);

  const stats = computeStats(store, nowMs);
  assert.equal(stats.total, 2);
  assert.equal(stats.highFreq, 1);
});

test('simplifyMeaning and simplifyAlternatives keep 1 concise meaning and filter synonym clutter', () => {
  assert.equal(simplifyMeaning('回复 响应 反应 应对 反映 解答 回应'), '回复');
  assert.equal(simplifyMeaning('探测；探针'), '探测');
  assert.equal(simplifyMeaning('响应、反应、应对'), '响应');

  // Single-POS synonym list is dropped cleanly
  assert.deepEqual(simplifyAlternatives('回复', ['名词: 响应、反应、应对']), []);

  // Multi-POS distinct meanings keep 1 concise term per distinct POS
  assert.deepEqual(
    simplifyAlternatives('探测', ['名词: 探针、探测器', '动词: 探测、探查']),
    ['名词: 探针']
  );

  // Legacy scraped item in store is auto-cleaned by normalizeStore
  const cleaned = normalizeStore({
    version: 1,
    items: {
      response: {
        id: 'response',
        word: 'response',
        meaning: '回复 响应 反应 应对 反映 解答 回应',
        alternatives: ['名词: 响应、反应、应对'],
      },
    },
  });
  assert.equal(cleaned.items.response.meaning, '回复');
  assert.deepEqual(cleaned.items.response.alternatives, []);
});
