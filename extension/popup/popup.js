import { getActiveItems, sortItems } from '../lib/sync-core.js';
import { renderQrSvg } from '../lib/qr.js';

let currentState = null;

const el = (id) => document.getElementById(id);

function formatSyncStatus(syncState, settings, pendingCount) {
  if (!settings?.token || !settings?.gistId) {
    return { text: '未绑定 GitHub Gist', cls: 'sync-status' };
  }
  if (syncState?.status === 'syncing') {
    return { text: '正在同步...', cls: 'sync-status' };
  }
  if (syncState?.status === 'error') {
    return { text: `同步异常: ${syncState.error}`, cls: 'sync-status error' };
  }
  if (pendingCount > 0) {
    return { text: `待同步 ${pendingCount} 项变更`, cls: 'sync-status' };
  }
  if (syncState?.lastSyncAt) {
    const t = new Date(syncState.lastSyncAt);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    return { text: `已同步 · ${hh}:${mm}`, cls: 'sync-status ok' };
  }
  return { text: '已就绪', cls: 'sync-status ok' };
}

function speakWord(word) {
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = /[\u4e00-\u9fff]/.test(word) ? 'zh-CN' : 'en-US';
    window.speechSynthesis.speak(utter);
  } catch {
    // ignore speech errors
  }
}

function renderQr() {
  const settings = currentState?.settings || {};
  const pwaInput = el('input-pwa-url');
  const qrBox = el('qr-box');
  const qrHint = el('qr-hint');

  const baseUrl = (pwaInput.value || settings.pwaUrl || '').trim();
  if (!settings.token || !settings.gistId) {
    qrBox.innerHTML = '<div style="padding:20px;color:#64748b;font-size:12px;">请先完成 GitHub Token 绑定</div>';
    qrHint.textContent = '点击右上角 ⚙ 进入设置向导完成绑定。';
    return;
  }

  if (!baseUrl) {
    qrBox.innerHTML = '<div style="padding:20px;color:#64748b;font-size:12px;">请先填写你的手机 PWA 网址</div>';
    qrHint.textContent = '例如推送本项目到 GitHub 并开启 Pages 后填写：https://用户名.github.io/word_review/';
    return;
  }

  const cleanBase = baseUrl.split('#')[0];
  const pairUrl = `${cleanBase}#token=${encodeURIComponent(settings.token)}&gist=${encodeURIComponent(settings.gistId)}`;
  try {
    qrBox.innerHTML = renderQrSvg(pairUrl, { margin: 3 });
    qrHint.textContent = '手机相机或微信扫一扫（浏览器打开）即可自动导入 Token 并开始复习。';
  } catch (err) {
    qrBox.innerHTML = `<div style="padding:14px;color:#dc2626;font-size:12px;">二维码生成失败: ${err.message}</div>`;
  }
}

function renderWordList() {
  const listEl = el('word-list');
  const emptyEl = el('empty-state');
  const query = el('input-search').value.trim().toLowerCase();

  const allActive = sortItems(getActiveItems(currentState.vocabStore), 'recent');
  const filtered = query
    ? allActive.filter(
        (item) =>
          item.word.toLowerCase().includes(query) ||
          item.meaning.toLowerCase().includes(query)
      )
    : allActive;

  const visible = filtered.slice(0, 20);
  listEl.innerHTML = '';

  if (visible.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  for (const item of visible) {
    const li = document.createElement('li');
    li.className = 'word-item';

    const main = document.createElement('div');
    main.className = 'word-main';

    const top = document.createElement('div');
    top.className = 'word-top';

    const wordSpan = document.createElement('span');
    wordSpan.className = 'word-text';
    wordSpan.textContent = item.word;
    top.appendChild(wordSpan);

    if (item.lookupCount > 1) {
      const freqBadge = document.createElement('span');
      freqBadge.className = 'word-badge freq';
      freqBadge.textContent = `×${item.lookupCount}`;
      top.appendChild(freqBadge);
    }
    if (item.status === 'mastered') {
      const mBadge = document.createElement('span');
      mBadge.className = 'word-badge mastered';
      mBadge.textContent = '已掌握';
      top.appendChild(mBadge);
    }

    const meaning = document.createElement('div');
    meaning.className = 'word-meaning';
    meaning.textContent = item.meaning;
    meaning.title = item.meaning;

    main.appendChild(top);
    main.appendChild(meaning);

    const actions = document.createElement('div');
    actions.className = 'word-actions';

    const speakBtn = document.createElement('button');
    speakBtn.className = 'mini-btn';
    speakBtn.textContent = '🔊';
    speakBtn.title = '朗读';
    speakBtn.addEventListener('click', () => speakWord(item.word));

    const starBtn = document.createElement('button');
    starBtn.className = `mini-btn${item.starred ? ' starred' : ''}`;
    starBtn.textContent = item.starred ? '★' : '☆';
    starBtn.title = '重点标记';
    starBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'PATCH_WORD',
        id: item.id,
        patch: { starred: !item.starred },
      });
      await refreshState();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = '✕';
    delBtn.title = '删除';
    delBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DELETE_WORD', id: item.id });
      await refreshState();
    });

    actions.append(speakBtn, starBtn, delBtn);
    li.append(main, actions);
    listEl.appendChild(li);
  }
}

function renderAll() {
  if (!currentState) return;
  const { settings, syncState, stats, pendingOps } = currentState;

  const statusInfo = formatSyncStatus(syncState, settings, pendingOps?.length || 0);
  const statusEl = el('sync-status');
  statusEl.textContent = statusInfo.text;
  statusEl.className = statusInfo.cls;

  el('setup-banner').classList.toggle('hidden', Boolean(settings?.token && settings?.gistId));
  el('stat-total').textContent = String(stats?.total || 0);
  el('stat-due').textContent = String(stats?.due || 0);
  el('stat-today').textContent = String(stats?.todayNew || 0);
  el('toggle-enabled').checked = settings?.enabled !== false;

  if (!el('input-pwa-url').value && settings?.pwaUrl) {
    el('input-pwa-url').value = settings.pwaUrl;
  }

  if (!el('qr-panel').classList.contains('hidden')) {
    renderQr();
  }
  renderWordList();
}

async function refreshState() {
  currentState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  renderAll();
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshState();

  el('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  el('btn-go-setup').addEventListener('click', () => chrome.runtime.openOptionsPage());

  el('btn-sync').addEventListener('click', async () => {
    el('sync-status').textContent = '正在同步...';
    await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    await refreshState();
  });

  el('toggle-enabled').addEventListener('change', async (e) => {
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { enabled: e.target.checked },
    });
    await refreshState();
  });

  el('btn-toggle-add').addEventListener('click', () => {
    el('manual-panel').classList.toggle('hidden');
    el('qr-panel').classList.add('hidden');
  });

  el('btn-toggle-qr').addEventListener('click', () => {
    el('qr-panel').classList.toggle('hidden');
    el('manual-panel').classList.add('hidden');
    renderQr();
  });

  el('btn-save-pwa-url').addEventListener('click', async () => {
    const pwaUrl = el('input-pwa-url').value.trim();
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { pwaUrl },
    });
    await refreshState();
    renderQr();
  });

  el('btn-add-word').addEventListener('click', async () => {
    const word = el('input-word').value.trim();
    const meaning = el('input-meaning').value.trim();
    if (!word || !meaning) return;
    await chrome.runtime.sendMessage({ type: 'ADD_MANUAL_WORD', word, meaning });
    el('input-word').value = '';
    el('input-meaning').value = '';
    el('manual-panel').classList.add('hidden');
    await refreshState();
  });

  el('input-search').addEventListener('input', renderWordList);
});
