/**
 * Cross-browser pronunciation player for WordReview (Mobile PWA + Chrome Extension).
 * Uses HTML5 Audio dictionary MP3 first (works on Android Quark/UC/WeChat/Chrome & iOS Safari
 * even when no system TTS engine is installed), falling back to Google TTS and Web Speech API.
 * Canonical source: shared/tts.js
 */

let sharedAudio = null;
let playSeq = 0;

function getAudioUrls(word) {
  const isZh = /[\u3400-\u9fff]/.test(word);
  const encoded = encodeURIComponent(word);
  if (isZh) {
    return [
      `https://dict.youdao.com/dictvoice?audio=${encoded}&le=zh`,
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=${encoded}`,
    ];
  }
  return [
    `https://dict.youdao.com/dictvoice?audio=${encoded}&type=2`,
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encoded}`,
  ];
}

function trySpeechSynthesis(word, { onStart, onEnd, onError }) {
  try {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
      onError?.('当前浏览器不支持语音朗读');
      return;
    }

    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    const isZh = /[\u3400-\u9fff]/.test(word);
    const targetLang = isZh ? 'zh-CN' : 'en-US';

    if (synth.speaking) {
      synth.cancel();
    }

    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = targetLang;
    if (voices.length > 0) {
      const matched = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(targetLang.slice(0, 2)));
      if (matched) utter.voice = matched;
    }

    let settled = false;
    utter.onstart = () => {
      onStart?.();
    };
    utter.onend = () => {
      if (!settled) {
        settled = true;
        onEnd?.();
      }
    };
    utter.onerror = () => {
      if (!settled) {
        settled = true;
        onError?.('设备未安装语音引擎且离线，无法朗读');
      }
    };

    synth.speak(utter);
  } catch {
    onError?.('设备不支持语音朗读');
  }
}

export function playPronunciation(text, { onStart, onEnd, onError } = {}) {
  const word = typeof text === 'string' ? text.trim() : '';
  if (!word) return;

  const seq = ++playSeq;
  const urls = getAudioUrls(word);

  if (typeof globalThis.Audio !== 'function') {
    trySpeechSynthesis(word, { onStart, onEnd, onError });
    return;
  }

  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = 'none';
  }

  // Reset previous playback cleanly without breaking gesture context
  sharedAudio.onended = null;
  sharedAudio.onerror = null;
  try {
    sharedAudio.pause();
  } catch {
    // ignore pause error
  }

  const tryUrlAt = (idx) => {
    if (seq !== playSeq) return;
    if (idx >= urls.length) {
      trySpeechSynthesis(word, { onStart, onEnd, onError });
      return;
    }

    let failed = false;
    const handleFail = () => {
      if (failed || seq !== playSeq) return;
      failed = true;
      tryUrlAt(idx + 1);
    };

    sharedAudio.onended = () => {
      if (seq === playSeq) onEnd?.();
    };
    sharedAudio.onerror = handleFail;
    sharedAudio.src = urls[idx];

    try {
      onStart?.();
      const promise = sharedAudio.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(handleFail);
      }
    } catch {
      handleFail();
    }
  };

  tryUrlAt(0);
}
