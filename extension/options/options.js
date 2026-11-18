import { renderQrSvg } from '../lib/qr.js';

const el = (id) => document.getElementById(id);

function showStatus(boxId, ok, html) {
  const box = el(boxId);
  box.classList.remove('hidden', 'ok', 'error');
  box.classList.add(ok ? 'ok' : 'error');
  box.innerHTML = html;
}

function buildPairUrl(settings) {
  const base = (el('input-pwa-url').value || settings?.pwaUrl || '').trim();
  if (!base || !settings?.token || !settings?.gistId) return '';
  const cleanBase = base.split('#')[0];
  return `${cleanBase}#token=${encodeURIComponent(settings.token)}&gist=${encodeURIComponent(settings.gistId)}`;
}

function renderQrBlock(settings) {
  const pairUrl = buildPairUrl(settings);
  const section = el('qr-section');
  if (!pairUrl) {
    section.classList.add('hidden');
    return;
  }
  try {
    el('qr-container').innerHTML = renderQrSvg(pairUrl, { margin: 3 });
    el('link-open-pwa').href = pairUrl;
    section.classList.remove('hidden');
  } catch (err) {
    section.classList.add('hidden');
  }
}

async function loadOptions() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const s = state.settings || {};

  el('input-token').value = s.token || '';
  if (!s.pwaUrl && s.githubUser) {
    el('input-pwa-url').placeholder = `https://${s.githubUser}.github.io/word_review/`;
  }
  el('input-pwa-url').value = s.pwaUrl || '';

  el('opt-enabled').checked = s.enabled !== false;
  el('opt-prefix-replace').checked = s.enablePrefixReplace !== false;
  el('opt-ignore-identical').checked = s.ignoreIdentical !== false;
  el('opt-debounce').value = String(s.debounceMs || 2200);
  el('opt-max-len').value = String(s.maxLength || 60);
  el('opt-max-words').value = String(s.maxWords || 5);

  if (s.token && s.gistId) {
    showStatus(
      'gist-status',
      true,
      `已绑定 GitHub 用户 <strong>${s.githubUser || '已验证'}</strong> · Gist ID: <code>${s.gistId}</code>`
    );
  }

  renderQrBlock(s);
  return state;
}

document.addEventListener('DOMContentLoaded', async () => {
  let state = await loadOptions();

  el('btn-toggle-token').addEventListener('click', () => {
    const inp = el('input-token');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el('btn-toggle-token').textContent = show ? '隐藏' : '显示';
  });

  el('btn-init-gist').addEventListener('click', async () => {
    const token = el('input-token').value.trim();
    if (!token) {
      showStatus('gist-status', false, '请先输入 GitHub Token');
      return;
    }

    el('btn-init-gist').disabled = true;
    el('btn-init-gist').textContent = '验证中...';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'INIT_GIST',
        token,
        pwaUrl: el('input-pwa-url').value.trim(),
      });
      if (!res?.ok) {
        throw new Error(res?.error || '验证失败');
      }
      const actionLabel = res.gistInfo.created ? '已自动新建私有词本 Gist' : '已找到并自动关联已有词本 Gist';
      showStatus(
        'gist-status',
        true,
        `✓ 验证成功！用户 <strong>${res.user.login}</strong> · ${actionLabel} (<code>${res.gistInfo.gistId}</code>)`
      );
      if (!el('input-pwa-url').value) {
        el('input-pwa-url').placeholder = `https://${res.user.login}.github.io/word_review/`;
      }
      state = await loadOptions();
    } catch (err) {
      showStatus('gist-status', false, `✗ ${err.message}`);
    } finally {
      el('btn-init-gist').disabled = false;
      el('btn-init-gist').textContent = '验证并自动关联词本';
    }
  });

  el('btn-save-pwa').addEventListener('click', async () => {
    const pwaUrl = el('input-pwa-url').value.trim();
    await chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: { pwaUrl },
    });
    state = await loadOptions();
    if (pwaUrl && (!state.settings?.token || !state.settings?.gistId)) {
      showStatus('gist-status', false, '网址已保存，请先完成第 1 步 GitHub Token 绑定以生成扫码链接。');
    }
  });

  el('btn-copy-pair-url').addEventListener('click', async () => {
    const url = buildPairUrl(state.settings);
    if (!url) return;
    await navigator.clipboard.writeText(url);
    el('btn-copy-pair-url').textContent = '已复制 ✓';
    setTimeout(() => {
      el('btn-copy-pair-url').textContent = '复制配对链接';
    }, 2000);
  });

  el('btn-save-opts').addEventListener('click', async () => {
    const nextSettings = {
      enabled: el('opt-enabled').checked,
      enablePrefixReplace: el('opt-prefix-replace').checked,
      ignoreIdentical: el('opt-ignore-identical').checked,
      debounceMs: Math.max(800, Number(el('opt-debounce').value) || 2200),
      maxLength: Math.max(15, Number(el('opt-max-len').value) || 60),
      maxWords: Math.max(1, Number(el('opt-max-words').value) || 5),
    };
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: nextSettings });
    showStatus('opts-status', true, '✓ 采集过滤规则已保存');
  });

  el('btn-export-json').addEventListener('click', async () => {
    const latest = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    const blob = new Blob([JSON.stringify(latest.vocabStore, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `word-review-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  el('input-import-json').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await chrome.runtime.sendMessage({ type: 'IMPORT_STORE', store: parsed });
      if (!res?.ok) throw new Error(res?.error || '导入失败');
      showStatus('opts-status', true, `✓ 成功导入 ${res.count} 条词条并加入同步队列`);
    } catch (err) {
      showStatus('opts-status', false, `✗ 导入失败: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });
});
