(() => {
  if (typeof window.__wordReviewCleanup === 'function') {
    try {
      window.__wordReviewCleanup();
    } catch {
      // ignore cleanup errors from stale context
    }
  }

  const DEBOUNCE_DEFAULT_MS = 2200;
  let debounceMs = DEBOUNCE_DEFAULT_MS;
  let autoEnabled = true;

  let debounceTimer = null;
  let toastTimer = null;
  let lastUrl = location.href;
  let lastObservedKey = '';
  let lastCommittedSignature = '';

  function normalize(str) {
    return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim() : '';
  }

  function getUrlParams() {
    try {
      const sp = new URLSearchParams(location.search);
      return {
        sl: sp.get('sl') || 'auto',
        tl: sp.get('tl') || 'zh-CN',
        text: normalize(sp.get('text') || ''),
      };
    } catch {
      return { sl: 'auto', tl: 'zh-CN', text: '' };
    }
  }

  function isInsideSideDrawer(el) {
    if (!el) return false;
    if (el.closest('[role="dialog"], [aria-modal="true"], nav, header, footer')) {
      return true;
    }
    // Google Translate History / Saved side drawers contain links to myactivity.google.com or close buttons
    let cur = el;
    for (let depth = 0; depth < 8 && cur && cur !== document.body; depth += 1) {
      if (
        cur.querySelector &&
        (cur.querySelector('a[href*="myactivity.google.com"]') ||
          cur.getAttribute('aria-label')?.includes('历史') ||
          cur.getAttribute('aria-label')?.includes('History') ||
          cur.getAttribute('aria-label')?.includes('已保存') ||
          cur.getAttribute('aria-label')?.includes('Saved'))
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function findSourceTextarea() {
    const candidates = Array.from(document.querySelectorAll('c-wiz textarea, textarea'));
    return candidates.find((ta) => !isInsideSideDrawer(ta) && ta.offsetParent !== null) || candidates[0] || null;
  }

  function findTranslationRoot(textarea) {
    if (!textarea) return document.querySelector('main') || document.body;
    let cur = textarea.parentElement;
    for (let i = 0; i < 10 && cur && cur !== document.body; i += 1) {
      const hasResult =
        cur.querySelector('[role="region"], [data-result-index="0"], span[jsname="W297wb"], span.ryNqvb');
      if (hasResult) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.querySelector('main') || document.body;
  }

  function isInsideAlternativesOrTable(el) {
    return Boolean(
      el.closest('table, tr, td, [role="table"], [data-dobid], [data-language-for-alternatives]')
    );
  }

  function extractResultText(root, sourceText) {
    const selectors = [
      '[data-result-index="0"] span[jsname="W297wb"]',
      '[data-result-index="0"] span.ryNqvb',
      '[role="region"] span[jsname="W297wb"]',
      '[role="region"] span.ryNqvb',
      'span[jsname="W297wb"]',
      'span.ryNqvb',
    ];

    for (const sel of selectors) {
      const nodes = Array.from(root.querySelectorAll(sel)).filter(
        (el) =>
          !isInsideSideDrawer(el) &&
          !isInsideAlternativesOrTable(el) &&
          !el.closest('textarea') &&
          el.offsetParent !== null
      );
      if (nodes.length > 0) {
        // Scope strictly to the first translation container so "其他翻译" rows below are never merged in
        const sentenceBox = nodes[0].closest('[data-result-index="0"], [jsname="jqKxS"]') || nodes[0].parentElement;
        const primaryNodes = sentenceBox
          ? nodes.filter((n) => sentenceBox.contains(n))
          : [nodes[0]];
        const leafNodes = primaryNodes.filter(
          (node) => !primaryNodes.some((other) => other !== node && node.contains(other))
        );
        const combined = normalize(leafNodes.map((n) => n.textContent || '').join(' '));
        if (combined && combined !== sourceText) {
          return combined;
        }
        if (combined) return combined;
      }
    }

    // Fallback: look for span[lang] inside primary result container only
    const langSpans = Array.from(
      root.querySelectorAll('[data-result-index="0"] span[lang], [aria-live="polite"] span[lang]')
    ).filter((el) => !isInsideSideDrawer(el) && !isInsideAlternativesOrTable(el) && el.offsetParent !== null);
    if (langSpans.length > 0) {
      const firstBox = langSpans[0].parentElement;
      const scoped = firstBox ? langSpans.filter((n) => firstBox.contains(n)) : [langSpans[0]];
      const text = normalize(scoped.map((n) => n.textContent || '').join(' '));
      if (text) return text;
    }

    return '';
  }

  function extractAlternatives() {
    // Keep only 1 concise meaning from primary translation; multi-POS disambiguation is handled in background enrichment
    return [];
  }

  function extractLanguages(root, urlParams) {
    let sourceLang = urlParams.sl || 'auto';
    let targetLang = urlParams.tl || 'zh-CN';

    const selectedLangButtons = Array.from(
      root.querySelectorAll('button[data-language-code][aria-selected="true"]')
    ).filter((btn) => !isInsideSideDrawer(btn));

    if (selectedLangButtons.length >= 2) {
      sourceLang = selectedLangButtons[0].getAttribute('data-language-code') || sourceLang;
      targetLang = selectedLangButtons[selectedLangButtons.length - 1].getAttribute('data-language-code') || targetLang;
    }
    return { sourceLang, targetLang };
  }

  function readCurrentTranslation() {
    const urlParams = getUrlParams();
    const textarea = findSourceTextarea();
    const root = findTranslationRoot(textarea);
    const sourceText = normalize(textarea ? textarea.value : urlParams.text) || urlParams.text;
    if (!sourceText) return null;

    const translatedText = extractResultText(root, sourceText);
    const alternatives = [];
    const { sourceLang, targetLang } = extractLanguages(root, urlParams);

    return {
      sourceText,
      translatedText,
      alternatives,
      sourceLang,
      targetLang,
      pageUrl: location.href,
    };
  }

  function ensureUiRoot() {
    let root = document.getElementById('wr-toast-root');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'wr-toast-root';

    const quickBtn = document.createElement('button');
    quickBtn.type = 'button';
    quickBtn.className = 'wr-quick-save-btn';
    quickBtn.id = 'wr-quick-save-btn';
    quickBtn.textContent = '★ 记入生词本 (Alt+S)';
    quickBtn.title = '手动立即收藏当前查询词条（可绕过长度限制）';
    quickBtn.addEventListener('click', () => triggerCapture(true));

    root.appendChild(quickBtn);
    document.body.appendChild(root);
    return root;
  }

  function showToast({ type = 'info', title, word, entryId, starred = false }) {
    const root = ensureUiRoot();
    const oldToast = root.querySelector('.wr-toast');
    if (oldToast) oldToast.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const toast = document.createElement('div');
    toast.className = `wr-toast${type === 'error' ? ' wr-toast-error' : ''}`;

    const main = document.createElement('div');
    main.className = 'wr-toast-main';

    const titleEl = document.createElement('div');
    titleEl.className = 'wr-toast-title';
    titleEl.textContent = title;

    const wordEl = document.createElement('div');
    wordEl.className = 'wr-toast-word';
    wordEl.textContent = word;

    main.appendChild(titleEl);
    main.appendChild(wordEl);
    toast.appendChild(main);

    if (entryId) {
      const actions = document.createElement('div');
      actions.className = 'wr-toast-actions';

      const starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.className = `wr-toast-btn${starred ? ' active' : ''}`;
      starBtn.textContent = starred ? '★' : '☆';
      starBtn.title = '标为重点生词';
      starBtn.addEventListener('click', () => {
        const nextStar = !starBtn.classList.contains('active');
        starBtn.classList.toggle('active', nextStar);
        starBtn.textContent = nextStar ? '★' : '☆';
        chrome.runtime.sendMessage({
          type: 'PATCH_WORD',
          id: entryId,
          patch: { starred: nextStar },
        });
      });

      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'wr-toast-btn';
      undoBtn.textContent = '撤销';
      undoBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'UNDO_WORD', id: entryId }, () => {
          toast.remove();
        });
      });

      actions.appendChild(starBtn);
      actions.appendChild(undoBtn);
      toast.appendChild(actions);
    }

    const startHideTimer = () => {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.remove();
      }, 4500);
    };
    toast.addEventListener('mouseenter', () => {
      if (toastTimer) clearTimeout(toastTimer);
    });
    toast.addEventListener('mouseleave', startHideTimer);

    root.appendChild(toast);
    startHideTimer();
  }

  async function triggerCapture(force = false) {
    if (!force && !autoEnabled) return;
    const payload = readCurrentTranslation();
    if (!payload || !payload.sourceText) {
      if (force) {
        showToast({ type: 'error', title: 'WordReview', word: '当前没有可收藏的翻译内容' });
      }
      return;
    }

    const signature = `${payload.sourceText}::${payload.translatedText}`;
    if (!force && signature === lastCommittedSignature) {
      return;
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'LOOKUP_CANDIDATE',
        payload: { ...payload, force },
      });

      if (!res) return;
      if (res.recorded && res.entry) {
        lastCommittedSignature = `${payload.sourceText}::${payload.translatedText || res.entry.meaning}`;
        const countLabel = res.entry.lookupCount > 1 ? ` · 第 ${res.entry.lookupCount} 次` : '';
        const title = res.replaced
          ? 'WordReview · 已自动修正'
          : force
            ? 'WordReview · 已手动收藏'
            : `WordReview · 已记录${countLabel}`;
        showToast({
          title,
          word: `${res.entry.word} → ${res.entry.meaning}`,
          entryId: res.entry.id,
          starred: res.entry.starred,
        });
      } else if (force) {
        showToast({
          type: 'error',
          title: 'WordReview · 未能保存',
          word:
            res.skippedReason === 'identical'
              ? '原文与译文相同（请检查右侧目标语言是否选成了中文）'
              : '未能获取有效译文，请稍后再试',
        });
      }
    } catch {
      // Extension context may reload during development; ignore silently on auto capture
    }
  }

  function scheduleCapture(delayMs = debounceMs) {
    if (!autoEnabled) return;
    const current = readCurrentTranslation();
    if (!current || !current.sourceText) return;

    const obsKey = `${current.sourceText}::${current.translatedText}`;
    if (obsKey === lastObservedKey) return;
    lastObservedKey = obsKey;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      triggerCapture(false);
    }, delayMs);
  }

  function attachListeners() {
    ensureUiRoot();

    // Load user debounce/enabled settings
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
      if (chrome.runtime.lastError || !res?.settings) return;
      autoEnabled = res.settings.enabled !== false;
      if (Number.isFinite(res.settings.debounceMs)) {
        debounceMs = Math.max(800, res.settings.debounceMs);
      }
      const btn = document.getElementById('wr-quick-save-btn');
      if (btn) btn.style.display = 'inline-flex';
      // Capture initial pre-filled URL translation if present
      scheduleCapture(1200);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings?.newValue) {
        const next = changes.settings.newValue;
        autoEnabled = next.enabled !== false;
        if (Number.isFinite(next.debounceMs)) {
          debounceMs = Math.max(800, next.debounceMs);
        }
      }
    });

    const onInput = (e) => {
      if (e.target && e.target.tagName === 'TEXTAREA') {
        lastObservedKey = '';
        scheduleCapture(debounceMs);
      }
    };
    document.addEventListener('input', onInput, true);

    // Keyboard shortcut Alt+S for manual force save
    const onKeyDown = (e) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        triggerCapture(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    const onPopState = () => {
      lastObservedKey = '';
      scheduleCapture(1400);
    };
    window.addEventListener('popstate', onPopState);

    // Lightweight SPA URL & result observer
    let mutationCooldown = null;
    const observer = new MutationObserver(() => {
      if (mutationCooldown) return;
      mutationCooldown = setTimeout(() => {
        mutationCooldown = null;
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          lastObservedKey = '';
          scheduleCapture(1400);
          return;
        }
        const cur = readCurrentTranslation();
        if (cur?.sourceText && cur?.translatedText) {
          const sig = `${cur.sourceText}::${cur.translatedText}`;
          if (sig !== lastObservedKey && sig !== lastCommittedSignature) {
            scheduleCapture(debounceMs);
          }
        }
      }, 450);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    window.__wordReviewCleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (toastTimer) clearTimeout(toastTimer);
      if (mutationCooldown) clearTimeout(mutationCooldown);
      observer.disconnect();
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
      document.getElementById('wr-toast-root')?.remove();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListeners, { once: true });
  } else {
    attachListeners();
  }
})();
