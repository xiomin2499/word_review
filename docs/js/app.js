import {
  applyOpsToStore,
  computeStats,
  createEmptyStore,
  createOpId,
  extractStudyEntry,
  getActiveItems,
  isDueForReview,
  normalizeStore,
  sortItems,
} from './sync-core.js';
import {
  findOrCreateVocabGist,
  syncVocabGist,
  validateToken,
} from './gist-client.js';

const LS_KEYS = {
  CONFIG: 'wr_pwa_config_v1',
  STORE: 'wr_pwa_store_v1',
  PENDING: 'wr_pwa_pending_ops_v1',
  ETAG: 'wr_pwa_etag_v1',
  PREFS: 'wr_pwa_prefs_v1',
};

const DEFAULT_PREFS = {
  reviewFilter: 'due', // due | freq | starred | all
  direction: 'word-first', // word-first | meaning-first
  peekMode: false, // false = tap to reveal, true = always visible
  listSort: 'recent',
  theme: 'auto', // auto | light | dark
};

const state = {
  config: { token: '', gistId: '', githubUser: '' },
  store: createEmptyStore(),
  pendingOps: [],
  etag: '',
  prefs: { ...DEFAULT_PREFS },
  lastSyncAt: '',
  syncStatus: 'local', // local | syncing | ok | err
  syncError: '',
  activeTab: 'review',
  deckIds: [],
  deckIndex: 0,
  revealed: false,
  editingId: null,
  deferredInstallPrompt: null,
};

const el = (id) => document.getElementById(id);

function showToast(msg) {
  const box = el('pwa-toast');
  box.textContent = msg;
  box.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => box.classList.add('hidden'), 2400);
}

function loadFromLocalStorage() {
  try {
    const cfg = JSON.parse(localStorage.getItem(LS_KEYS.CONFIG) || 'null');
    if (cfg) state.config = { ...state.config, ...cfg };
    const st = JSON.parse(localStorage.getItem(LS_KEYS.STORE) || 'null');
    if (st) state.store = normalizeStore(st);
    const ops = JSON.parse(localStorage.getItem(LS_KEYS.PENDING) || 'null');
    if (Array.isArray(ops)) state.pendingOps = ops;
    state.etag = localStorage.getItem(LS_KEYS.ETAG) || '';
    const prefs = JSON.parse(localStorage.getItem(LS_KEYS.PREFS) || 'null');
    if (prefs) state.prefs = { ...DEFAULT_PREFS, ...prefs };
  } catch {
    // ignore corrupt storage
  }
}

function saveToLocalStorage() {
  localStorage.setItem(LS_KEYS.CONFIG, JSON.stringify(state.config));
  localStorage.setItem(LS_KEYS.STORE, JSON.stringify(state.store));
  localStorage.setItem(LS_KEYS.PENDING, JSON.stringify(state.pendingOps));
  localStorage.setItem(LS_KEYS.ETAG, state.etag || '');
  localStorage.setItem(LS_KEYS.PREFS, JSON.stringify(state.prefs));
}

function applyTheme() {
  const mode = state.prefs.theme || 'auto';
  const root = document.documentElement;
  if (mode === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (mode === 'light') {
    root.removeAttribute('data-theme');
  } else {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    if (prefersDark) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }
  const labels = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };
  el('btn-theme-cycle').textContent = labels[mode] || labels.auto;
}

function consumePairingHash() {
  const rawHash = location.hash || '';
  if (!rawHash.includes('token=')) return false;

  const params = new URLSearchParams(rawHash.slice(1));
  const token = (params.get('token') || '').trim();
  const gistId = (params.get('gist') || '').trim();
  if (!token) return false;

  state.config.token = token;
  if (gistId) state.config.gistId = gistId;
  state.etag = '';
  saveToLocalStorage();

  // Immediately strip sensitive token from address bar & history
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

function speakText(text) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US';
    window.speechSynthesis.speak(u);
  } catch {
    // ignore speech error
  }
}

let syncInFlight = null;

async function syncWithGist({ quiet = false } = {}) {
  if (!state.config.token) return false;
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    state.syncStatus = 'syncing';
    renderTopbar();

    try {
      if (!state.config.gistId) {
        const info = await findOrCreateVocabGist(state.config.token);
        state.config.gistId = info.gistId;
        saveToLocalStorage();
      }

      const opsSnapshot = [...state.pendingOps];
      const res = await syncVocabGist({
        token: state.config.token,
        gistId: state.config.gistId,
        pendingOps: opsSnapshot,
        etag: state.etag,
      });

      const syncedIds = new Set(opsSnapshot.map((o) => o.opId));
      state.pendingOps = state.pendingOps.filter((o) => !syncedIds.has(o.opId));

      if (res.changed && res.store) {
        state.store =
          state.pendingOps.length > 0
            ? applyOpsToStore(res.store, state.pendingOps)
            : res.store;
      }

      state.etag = res.etag || state.etag;
      state.lastSyncAt = new Date().toISOString();
      state.syncStatus = 'ok';
      state.syncError = '';
      saveToLocalStorage();
      rebuildDeck({ preserveCurrent: true });
      renderAll();
      if (!quiet) showToast('已与云端词本同步');
      return true;
    } catch (err) {
      state.syncStatus = 'err';
      state.syncError = err.message || '同步失败';
      renderTopbar();
      if (!quiet) showToast(`同步失败：${state.syncError}`);
      return false;
    } finally {
      syncInFlight = null;
      renderTopbar();
    }
  })();

  return syncInFlight;
}

function queueLocalOp(op) {
  state.pendingOps.push(op);
  state.store = applyOpsToStore(state.store, [op]);
  saveToLocalStorage();
  if (state.config.token) {
    clearTimeout(queueLocalOp._timer);
    queueLocalOp._timer = setTimeout(() => {
      syncWithGist({ quiet: true });
    }, 1200);
  }
}

function getFilteredReviewItems() {
  const active = getActiveItems(state.store);
  const nowMs = Date.now();
  let filtered;
  switch (state.prefs.reviewFilter) {
    case 'freq':
      filtered = active.filter((i) => (i.lookupCount || 1) >= 2 && i.status !== 'mastered');
      break;
    case 'starred':
      filtered = active.filter((i) => i.starred);
      break;
    case 'all':
      filtered = active;
      break;
    case 'due':
    default:
      filtered = active.filter((i) => isDueForReview(i, nowMs));
      break;
  }
  return sortItems(filtered, 'smart', nowMs);
}

function rebuildDeck({ preserveCurrent = false } = {}) {
  const currentId = preserveCurrent ? state.deckIds[state.deckIndex] : null;
  const items = getFilteredReviewItems();
  state.deckIds = items.map((i) => i.id);
  if (currentId && state.deckIds.includes(currentId)) {
    state.deckIndex = state.deckIds.indexOf(currentId);
  } else {
    state.deckIndex = 0;
    state.revealed = Boolean(state.prefs.peekMode);
  }
}

function formatShortDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${hh}:${mm}`;
}

function renderTopbar() {
  const ind = el('sync-indicator');
  const btn = el('btn-sync-now');
  btn.classList.toggle('spinning', state.syncStatus === 'syncing');

  if (!state.config.token) {
    ind.textContent = '本地模式 · 未绑定云端';
    ind.className = 'sync-indicator';
  } else if (state.syncStatus === 'syncing') {
    ind.textContent = '正在同步...';
    ind.className = 'sync-indicator';
  } else if (state.syncStatus === 'err') {
    ind.textContent = `同步异常 (${state.syncError})`;
    ind.className = 'sync-indicator err';
  } else if (state.pendingOps.length > 0) {
    ind.textContent = `待上传 ${state.pendingOps.length} 项`;
    ind.className = 'sync-indicator';
  } else if (state.lastSyncAt) {
    ind.textContent = `已同步 · ${formatShortDate(state.lastSyncAt)}`;
    ind.className = 'sync-indicator ok';
  } else {
    ind.textContent = '已连接云端';
    ind.className = 'sync-indicator ok';
  }
}

function renderReviewView() {
  const stats = computeStats(state.store);
  el('chip-due-count').textContent = String(stats.due);

  const showOnboarding = !state.config.token && stats.total === 0;
  el('onboarding-card').classList.toggle('hidden', !showOnboarding);

  document.querySelectorAll('#review-filters .filter-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === state.prefs.reviewFilter);
  });

  el('btn-toggle-direction').textContent =
    state.prefs.direction === 'word-first' ? '方向：英 → 中' : '方向：中 → 英';
  el('btn-toggle-peek').textContent =
    state.prefs.peekMode ? '模式：直接看释义' : '模式：遮盖释义';

  const stage = el('flashcard-stage');
  stage.innerHTML = '';

  const validIds = state.deckIds.filter((id) => state.store.items[id] && !state.store.items[id].deletedAt);
  state.deckIds = validIds;

  if (validIds.length === 0) {
    el('deck-progress').textContent = '0 / 0';
    const empty = document.createElement('div');
    empty.className = 'empty-deck';
    empty.innerHTML =
      stats.total === 0
        ? `<div class="empty-emoji">📚</div>
           <h3>生词本还是空的</h3>
           <p>去电脑浏览器打开 Google 翻译查个单词，或点「生词表 → + 添加」手动录入。</p>`
        : `<div class="empty-emoji">🎉</div>
           <h3>这一组已经全部过完啦！</h3>
           <p>太棒了！你可以切换上方筛选查看「高频易忘」或「全部」单词。</p>
           <button id="btn-switch-all" class="btn btn-secondary" type="button">浏览全部单词 (${stats.total})</button>`;
    stage.appendChild(empty);
    const swAll = document.getElementById('btn-switch-all');
    if (swAll) {
      swAll.addEventListener('click', () => {
        state.prefs.reviewFilter = 'all';
        saveToLocalStorage();
        rebuildDeck();
        renderReviewView();
      });
    }
    return;
  }

  if (state.deckIndex >= validIds.length) state.deckIndex = 0;
  const item = state.store.items[validIds[state.deckIndex]];
  el('deck-progress').textContent = `${state.deckIndex + 1} / ${validIds.length}`;

  const isWordFirst = state.prefs.direction === 'word-first';
  const frontText = isWordFirst ? item.word : item.meaning;
  const backMain = isWordFirst ? item.meaning : item.word;
  const showAnswer = state.prefs.peekMode || state.revealed;

  const card = document.createElement('div');
  card.className = 'flashcard';

  const top = document.createElement('div');
  top.className = 'card-top';

  const badges = document.createElement('div');
  badges.className = 'badges-wrap';

  const countBadge = document.createElement('span');
  countBadge.className = `badge${item.lookupCount >= 2 ? ' freq' : ''}`;
  countBadge.textContent = `查过 ${item.lookupCount} 次`;
  badges.appendChild(countBadge);

  if (item.status === 'mastered') {
    const mBadge = document.createElement('span');
    mBadge.className = 'badge mastered';
    mBadge.textContent = '已掌握';
    badges.appendChild(mBadge);
  }

  const tools = document.createElement('div');
  tools.className = 'card-tools';

  const speakBtn = document.createElement('button');
  speakBtn.type = 'button';
  speakBtn.className = 'tool-btn';
  speakBtn.textContent = '🔊';
  speakBtn.addEventListener('click', () => speakText(item.word));

  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = `tool-btn${item.starred ? ' starred' : ''}`;
  starBtn.textContent = item.starred ? '★' : '☆';
  starBtn.addEventListener('click', () => {
    queueLocalOp({
      type: 'patch',
      opId: createOpId('pat'),
      timestamp: new Date().toISOString(),
      id: item.id,
      patch: { starred: !item.starred },
    });
    renderAll();
  });

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tool-btn';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', () => openWordModal(item.id));

  tools.append(speakBtn, starBtn, editBtn);
  top.append(badges, tools);

  const front = document.createElement('div');
  front.className = 'card-front';
  const wordDiv = document.createElement('div');
  wordDiv.className = 'card-word';
  wordDiv.textContent = frontText;
  front.appendChild(wordDiv);

  if (isWordFirst && item.phonetic) {
    const phDiv = document.createElement('div');
    phDiv.className = 'card-phonetic';
    phDiv.textContent = item.phonetic;
    front.appendChild(phDiv);
  }

  const ansArea = document.createElement('div');
  ansArea.className = `card-answer-area${showAnswer ? ' revealed' : ''}`;
  if (!showAnswer) {
    ansArea.innerHTML = '<div class="tap-reveal-hint">👆 点击查看释义与备注</div>';
    ansArea.addEventListener('click', () => {
      state.revealed = true;
      renderReviewView();
    });
  } else {
    const mainMean = document.createElement('div');
    mainMean.className = 'meaning-main';
    mainMean.textContent = backMain;
    ansArea.appendChild(mainMean);

    if (item.alternatives?.length) {
      const alts = document.createElement('div');
      alts.className = 'meaning-alts';
      alts.textContent = `其他释义：${item.alternatives.join(' · ')}`;
      ansArea.appendChild(alts);
    }
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'meaning-note';
      note.textContent = `📝 ${item.note}`;
      ansArea.appendChild(note);
    }
  }

  const metaFoot = document.createElement('div');
  metaFoot.className = 'card-meta-foot';
  metaFoot.innerHTML = `<span>最近查询：${formatShortDate(item.lastLookupAt)}</span><span>已复习 ${item.reviewCount || 0} 次</span>`;

  card.append(top, front, ansArea, metaFoot);
  stage.appendChild(card);

  const actions = document.createElement('div');
  actions.className = 'review-actions';

  const ratings = [
    { key: 'again', cls: 'rate-again', label: '忘了', sub: '本轮重看' },
    { key: 'hard', cls: 'rate-hard', label: '模糊', sub: '明天再看' },
    { key: 'good', cls: 'rate-good', label: '记住了', sub: '拉长间隔' },
    { key: 'master', cls: 'rate-master', label: '已掌握', sub: '归档 30天' },
  ];

  for (const r of ratings) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `rate-btn ${r.cls}`;
    btn.innerHTML = `${r.label}<span>${r.sub}</span>`;
    btn.addEventListener('click', () => handleRateCard(item.id, r.key));
    actions.appendChild(btn);
  }
  stage.appendChild(actions);
}

function handleRateCard(id, rating) {
  queueLocalOp({
    type: 'review',
    opId: createOpId('rev'),
    timestamp: new Date().toISOString(),
    id,
    rating,
  });

  if (rating === 'again') {
    // Move current card to end of active session queue so user sees it again
    const idx = state.deckIds.indexOf(id);
    if (idx !== -1) {
      state.deckIds.splice(idx, 1);
      state.deckIds.push(id);
      if (state.deckIndex >= state.deckIds.length) state.deckIndex = 0;
    }
  } else {
    // Advance in deck
    const idx = state.deckIds.indexOf(id);
    if (idx !== -1) {
      if (state.prefs.reviewFilter === 'due' || rating === 'master') {
        state.deckIds.splice(idx, 1);
      } else {
        state.deckIndex += 1;
      }
      if (state.deckIndex >= state.deckIds.length) state.deckIndex = 0;
    }
  }

  state.revealed = Boolean(state.prefs.peekMode);
  renderAll();
}

function renderWordsView() {
  document.querySelectorAll('#list-sorts .filter-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.sort === state.prefs.listSort);
  });

  const query = el('list-search').value.trim().toLowerCase();
  let items = getActiveItems(state.store);
  if (state.prefs.listSort === 'mastered') {
    items = items.filter((i) => i.status === 'mastered');
  }
  const sortMode = state.prefs.listSort === 'mastered' ? 'recent' : state.prefs.listSort;
  items = sortItems(items, sortMode);

  if (query) {
    items = items.filter(
      (i) =>
        i.word.toLowerCase().includes(query) ||
        i.meaning.toLowerCase().includes(query) ||
        (i.note && i.note.toLowerCase().includes(query))
    );
  }

  const container = el('word-list-container');
  container.innerHTML = '';

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-deck"><p>没有匹配的生词记录</p></div>';
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'list-card';
    row.addEventListener('click', () => openWordModal(item.id));

    const left = document.createElement('div');
    left.className = 'list-card-left';

    const wRow = document.createElement('div');
    wRow.className = 'list-word-row';
    const wSpan = document.createElement('span');
    wSpan.className = 'list-word';
    wSpan.textContent = item.word;
    wRow.appendChild(wSpan);

    if (item.lookupCount > 1) {
      const b = document.createElement('span');
      b.className = 'badge freq';
      b.textContent = `×${item.lookupCount}`;
      wRow.appendChild(b);
    }
    if (item.status === 'mastered') {
      const b = document.createElement('span');
      b.className = 'badge mastered';
      b.textContent = '已掌握';
      wRow.appendChild(b);
    }

    const mDiv = document.createElement('div');
    mDiv.className = 'list-meaning';
    mDiv.textContent = item.note ? `${item.meaning} · 📝 ${item.note}` : item.meaning;

    left.append(wRow, mDiv);

    const right = document.createElement('div');
    right.className = 'list-card-right';

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'tool-btn';
    speakBtn.textContent = '🔊';
    speakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText(item.word);
    });

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = `tool-btn${item.starred ? ' starred' : ''}`;
    starBtn.textContent = item.starred ? '★' : '☆';
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      queueLocalOp({
        type: 'patch',
        opId: createOpId('pat'),
        timestamp: new Date().toISOString(),
        id: item.id,
        patch: { starred: !item.starred },
      });
      renderAll();
    });

    right.append(speakBtn, starBtn);
    row.append(left, right);
    container.appendChild(row);
  }
}

function renderSettingsView() {
  const stats = computeStats(state.store);
  el('s-total').textContent = String(stats.total);
  el('s-due').textContent = String(stats.due);
  el('s-mastered').textContent = String(stats.mastered);
  el('s-today').textContent = String(stats.todayNew);

  const topFreq = sortItems(getActiveItems(state.store), 'freq').slice(0, 5);
  const topBox = el('top-freq-list');
  topBox.innerHTML = '';
  if (topFreq.length === 0) {
    topBox.innerHTML = '<div class="hint-text">暂无查词统计</div>';
  } else {
    for (const item of topFreq) {
      const row = document.createElement('div');
      row.className = 'freq-row';
      row.innerHTML = `<span><strong>${escapeHtml(item.word)}</strong> · ${escapeHtml(item.meaning)}</span><span class="badge freq">查过 ${item.lookupCount} 次</span>`;
      topBox.appendChild(row);
    }
  }

  if (!el('cfg-token').value && state.config.token) {
    el('cfg-token').value = state.config.token;
  }
  if (!el('cfg-gist').value && state.config.gistId) {
    el('cfg-gist').value = state.config.gistId;
  }

  // Show iOS Safari install tip when not running standalone
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  el('ios-install-hint').classList.toggle('hidden', !(isIos && !isStandalone));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderAll() {
  renderTopbar();
  renderReviewView();
  renderWordsView();
  renderSettingsView();
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.tab === tab);
  });
  el(`view-${tab}`).classList.add('active');
}

function openWordModal(id = null) {
  state.editingId = id;
  const item = id ? state.store.items[id] : null;
  el('modal-title').textContent = item ? '编辑词条' : '手动添加生词';
  el('m-word').value = item ? item.word : '';
  el('m-meaning').value = item ? item.meaning : '';
  el('m-note').value = item ? item.note || '' : '';
  el('m-meta-info').textContent = item
    ? `查询 ${item.lookupCount} 次 · 复习 ${item.reviewCount || 0} 次 · 首次查询 ${formatShortDate(item.firstLookupAt)}`
    : '';

  el('btn-modal-delete').classList.toggle('hidden', !item);
  const starBtn = el('btn-modal-star');
  starBtn.classList.toggle('hidden', !item);
  if (item) {
    starBtn.textContent = item.starred ? '★ 已标重点' : '☆ 标为重点';
  }
  el('modal-backdrop').classList.remove('hidden');
}

function closeWordModal() {
  el('modal-backdrop').classList.add('hidden');
  state.editingId = null;
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  el('btn-sync-now').addEventListener('click', () => {
    if (!state.config.token) {
      switchTab('settings');
      showToast('请先配置 GitHub Token');
      return;
    }
    syncWithGist({ quiet: false });
  });

  el('btn-go-bind').addEventListener('click', () => switchTab('settings'));

  el('btn-load-demo').addEventListener('click', () => {
    const samples = [
      ['probe', '探测；探针', 'k8s livenessProbe / readinessProbe'],
      ['params', '参数', 'URL query params'],
      ['idempotent', '幂等的', '重复请求不产生副作用'],
      ['throttle', '节流', '限制触发频率'],
    ];
    const ops = samples.flatMap(([word, meaning, note]) => {
      const entry = extractStudyEntry({ sourceText: word, translatedText: meaning });
      return [
        {
          type: 'upsert_lookup',
          opId: createOpId('demo'),
          timestamp: new Date().toISOString(),
          entry,
        },
        {
          type: 'patch',
          opId: createOpId('demopat'),
          timestamp: new Date().toISOString(),
          id: entry.id,
          patch: { note },
        },
      ];
    });
    state.store = applyOpsToStore(state.store, ops);
    saveToLocalStorage();
    rebuildDeck();
    renderAll();
    showToast('已载入 4 个示例词汇');
  });

  document.querySelectorAll('#review-filters .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.prefs.reviewFilter = chip.dataset.filter;
      saveToLocalStorage();
      rebuildDeck();
      renderReviewView();
    });
  });

  el('btn-toggle-direction').addEventListener('click', () => {
    state.prefs.direction =
      state.prefs.direction === 'word-first' ? 'meaning-first' : 'word-first';
    saveToLocalStorage();
    renderReviewView();
  });

  el('btn-toggle-peek').addEventListener('click', () => {
    state.prefs.peekMode = !state.prefs.peekMode;
    state.revealed = state.prefs.peekMode;
    saveToLocalStorage();
    renderReviewView();
  });

  document.querySelectorAll('#list-sorts .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.prefs.listSort = chip.dataset.sort;
      saveToLocalStorage();
      renderWordsView();
    });
  });

  el('list-search').addEventListener('input', renderWordsView);
  el('btn-open-add').addEventListener('click', () => openWordModal(null));
  el('btn-close-modal').addEventListener('click', closeWordModal);
  el('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === el('modal-backdrop')) closeWordModal();
  });

  el('btn-modal-star').addEventListener('click', () => {
    if (!state.editingId) return;
    const item = state.store.items[state.editingId];
    if (!item) return;
    queueLocalOp({
      type: 'patch',
      opId: createOpId('pat'),
      timestamp: new Date().toISOString(),
      id: item.id,
      patch: { starred: !item.starred },
    });
    el('btn-modal-star').textContent = !item.starred ? '★ 已标重点' : '☆ 标为重点';
    renderAll();
  });

  el('btn-modal-delete').addEventListener('click', () => {
    if (!state.editingId) return;
    queueLocalOp({
      type: 'delete',
      opId: createOpId('del'),
      timestamp: new Date().toISOString(),
      id: state.editingId,
    });
    closeWordModal();
    rebuildDeck({ preserveCurrent: false });
    renderAll();
    showToast('已删除词条');
  });

  el('btn-modal-save').addEventListener('click', () => {
    const word = el('m-word').value.trim();
    const meaning = el('m-meaning').value.trim();
    const note = el('m-note').value.trim();
    if (!word || !meaning) {
      showToast('请输入单词和释义');
      return;
    }

    if (state.editingId) {
      queueLocalOp({
        type: 'patch',
        opId: createOpId('pat'),
        timestamp: new Date().toISOString(),
        id: state.editingId,
        patch: { word, meaning, note },
      });
    } else {
      const entry = extractStudyEntry({ sourceText: word, translatedText: meaning });
      queueLocalOp({
        type: 'upsert_lookup',
        opId: createOpId('man'),
        timestamp: new Date().toISOString(),
        entry,
        cooldownMs: 0,
      });
      if (note) {
        queueLocalOp({
          type: 'patch',
          opId: createOpId('pat'),
          timestamp: new Date().toISOString(),
          id: entry.id,
          patch: { note },
        });
      }
    }
    closeWordModal();
    rebuildDeck({ preserveCurrent: true });
    renderAll();
    showToast('已保存');
  });

  el('btn-save-sync').addEventListener('click', async () => {
    const token = el('cfg-token').value.trim();
    const gistIdInput = el('cfg-gist').value.trim();
    const statusBox = el('cfg-status');

    if (!token) {
      statusBox.className = 'cfg-status err';
      statusBox.textContent = '请填写 GitHub Token';
      statusBox.classList.remove('hidden');
      return;
    }

    el('btn-save-sync').disabled = true;
    el('btn-save-sync').textContent = '连接中...';
    try {
      const user = await validateToken(token);
      state.config.token = token;
      state.config.githubUser = user.login;
      state.config.gistId = gistIdInput;
      if (!state.config.gistId) {
        const gistInfo = await findOrCreateVocabGist(token);
        state.config.gistId = gistInfo.gistId;
        el('cfg-gist').value = gistInfo.gistId;
      }
      state.etag = '';
      saveToLocalStorage();
      const ok = await syncWithGist({ quiet: true });
      if (ok) {
        statusBox.className = 'cfg-status ok';
        statusBox.textContent = `✓ 已绑定 ${user.login}，Gist: ${state.config.gistId}`;
      } else {
        statusBox.className = 'cfg-status err';
        statusBox.textContent = `✗ ${state.syncError}`;
      }
      statusBox.classList.remove('hidden');
    } catch (err) {
      statusBox.className = 'cfg-status err';
      statusBox.textContent = `✗ ${err.message}`;
      statusBox.classList.remove('hidden');
    } finally {
      el('btn-save-sync').disabled = false;
      el('btn-save-sync').textContent = '连接并立即同步';
    }
  });

  el('btn-clear-sync').addEventListener('click', () => {
    state.config = { token: '', gistId: '', githubUser: '' };
    state.etag = '';
    state.syncStatus = 'local';
    el('cfg-token').value = '';
    el('cfg-gist').value = '';
    el('cfg-status').classList.add('hidden');
    saveToLocalStorage();
    renderAll();
    showToast('已解除云端绑定（本地词表保留）');
  });

  el('btn-theme-cycle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const idx = order.indexOf(state.prefs.theme);
    state.prefs.theme = order[(idx + 1) % order.length];
    saveToLocalStorage();
    applyTheme();
  });

  el('btn-export-csv').addEventListener('click', () => {
    const rows = getActiveItems(state.store).map((i) => {
      const esc = (s) => `"${String(s || '').replaceAll('"', '""')}"`;
      return [esc(i.word), esc(i.meaning), esc(i.note), i.lookupCount].join(',');
    });
    const csv = '\uFEFFword,meaning,note,lookupCount\n' + rows.join('\n');
    downloadFile(`word-review-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
  });

  el('btn-export-json').addEventListener('click', () => {
    downloadFile(
      `word-review-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(state.store, null, 2),
      'application/json'
    );
  });

  // PWA Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    el('btn-install-pwa').classList.remove('hidden');
  });

  el('btn-install-pwa').addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    el('btn-install-pwa').classList.add('hidden');
  });

  // Auto-sync when app comes back to foreground on mobile
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.config.token) {
      syncWithGist({ quiet: true });
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  loadFromLocalStorage();
  const pairedFromHash = consumePairingHash();
  applyTheme();
  bindEvents();
  rebuildDeck();
  renderAll();
  registerServiceWorker();

  if (pairedFromHash) {
    showToast('✓ 已从二维码自动绑定词本，正在同步...');
  }
  if (state.config.token) {
    await syncWithGist({ quiet: !pairedFromHash });
  }
});
