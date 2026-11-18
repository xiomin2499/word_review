/**
 * GitHub Gist API client for WordReview conflict-free cloud sync.
 * Canonical source: shared/gist-client.js
 */

import { applyOpsToStore, createEmptyStore, normalizeStore } from './sync-core.js';

export const VOCAB_FILENAME = 'word-review-vocab.json';
export const GIST_DESCRIPTION = 'WordReview Vocabulary Sync';
const GITHUB_API = 'https://api.github.com';

export class GistSyncError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'GistSyncError';
    this.code = code;
    this.status = status;
  }
}

function makeHeaders(token, extra = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function parseErrorResponse(res) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data?.message || '';
  } catch {
    detail = await res.text().catch(() => '');
  }

  if (res.status === 401) {
    return new GistSyncError('AUTH_ERROR', `GitHub Token 无效或已过期 (${detail || 401})`, 401);
  }
  if (res.status === 403) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    if (remaining === '0') {
      return new GistSyncError('RATE_LIMIT', 'GitHub API 请求频率受限，请稍后再试', 403);
    }
    return new GistSyncError('AUTH_ERROR', `GitHub Token 缺少 gist 权限 (${detail || 403})`, 403);
  }
  if (res.status === 404) {
    return new GistSyncError('NOT_FOUND', `找不到指定的 Gist 或无权限访问 (${detail || 404})`, 404);
  }
  return new GistSyncError('API_ERROR', `GitHub 请求失败 (${res.status}): ${detail || res.statusText}`, res.status);
}

export async function validateToken(token, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiBase = options.apiBase || GITHUB_API;
  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    throw new GistSyncError('AUTH_ERROR', '请先填写 GitHub Token');
  }

  let res;
  try {
    res = await fetchImpl(`${apiBase}/user`, {
      method: 'GET',
      headers: makeHeaders(cleanToken),
    });
  } catch (err) {
    throw new GistSyncError('NETWORK_ERROR', `无法连接 GitHub: ${err.message}`);
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  const user = await res.json();
  const scopes = res.headers?.get?.('x-oauth-scopes') || '';
  return {
    login: user.login,
    avatarUrl: user.avatar_url || '',
    scopes,
  };
}

export async function findOrCreateVocabGist(token, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiBase = options.apiBase || GITHUB_API;
  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    throw new GistSyncError('AUTH_ERROR', '请先填写 GitHub Token');
  }

  let listRes;
  try {
    listRes = await fetchImpl(`${apiBase}/gists?per_page=100`, {
      method: 'GET',
      headers: makeHeaders(cleanToken),
    });
  } catch (err) {
    throw new GistSyncError('NETWORK_ERROR', `无法连接 GitHub: ${err.message}`);
  }

  if (!listRes.ok) {
    throw await parseErrorResponse(listRes);
  }

  const gists = await listRes.json();
  const existing = Array.isArray(gists)
    ? gists.find((g) => g?.files && Object.prototype.hasOwnProperty.call(g.files, VOCAB_FILENAME))
    : null;

  if (existing) {
    return {
      gistId: existing.id,
      created: false,
      htmlUrl: existing.html_url || '',
    };
  }

  const initialStore = createEmptyStore();
  let createRes;
  try {
    createRes = await fetchImpl(`${apiBase}/gists`, {
      method: 'POST',
      headers: makeHeaders(cleanToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        description: GIST_DESCRIPTION,
        public: false,
        files: {
          [VOCAB_FILENAME]: {
            content: JSON.stringify(initialStore, null, 2),
          },
        },
      }),
    });
  } catch (err) {
    throw new GistSyncError('NETWORK_ERROR', `创建云端 Gist 失败: ${err.message}`);
  }

  if (!createRes.ok) {
    throw await parseErrorResponse(createRes);
  }

  const created = await createRes.json();
  return {
    gistId: created.id,
    created: true,
    htmlUrl: created.html_url || '',
  };
}

export async function fetchVocabGist(token, gistId, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiBase = options.apiBase || GITHUB_API;
  const cleanToken = (token || '').trim();
  const cleanGistId = (gistId || '').trim();

  if (!cleanToken || !cleanGistId) {
    throw new GistSyncError('CONFIG_ERROR', '缺少 GitHub Token 或 Gist ID');
  }

  const extraHeaders = {};
  if (options.etag) {
    extraHeaders['If-None-Match'] = options.etag;
  }

  let res;
  try {
    res = await fetchImpl(`${apiBase}/gists/${encodeURIComponent(cleanGistId)}`, {
      method: 'GET',
      headers: makeHeaders(cleanToken, extraHeaders),
    });
  } catch (err) {
    throw new GistSyncError('NETWORK_ERROR', `拉取云端词本失败: ${err.message}`);
  }

  if (res.status === 304) {
    return { notModified: true, etag: options.etag };
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  const etag = res.headers?.get?.('etag') || '';
  const gist = await res.json();
  const file = gist?.files?.[VOCAB_FILENAME];

  if (!file) {
    return {
      notModified: false,
      etag,
      needsFileInit: true,
      store: createEmptyStore(),
    };
  }

  let content = file.content || '';
  if (file.truncated && file.raw_url) {
    const rawRes = await fetchImpl(file.raw_url, {
      method: 'GET',
      headers: makeHeaders(cleanToken),
    });
    if (!rawRes.ok) {
      throw await parseErrorResponse(rawRes);
    }
    content = await rawRes.text();
  }

  let parsed = null;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    parsed = null;
  }

  return {
    notModified: false,
    etag,
    needsFileInit: !parsed,
    store: normalizeStore(parsed),
  };
}

export async function patchVocabGist(token, gistId, store, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const apiBase = options.apiBase || GITHUB_API;
  const cleanToken = (token || '').trim();
  const cleanGistId = (gistId || '').trim();

  if (!cleanToken || !cleanGistId) {
    throw new GistSyncError('CONFIG_ERROR', '缺少 GitHub Token 或 Gist ID');
  }

  let res;
  try {
    res = await fetchImpl(`${apiBase}/gists/${encodeURIComponent(cleanGistId)}`, {
      method: 'PATCH',
      headers: makeHeaders(cleanToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        description: GIST_DESCRIPTION,
        files: {
          [VOCAB_FILENAME]: {
            content: JSON.stringify(store, null, 2),
          },
        },
      }),
    });
  } catch (err) {
    throw new GistSyncError('NETWORK_ERROR', `上传词本失败: ${err.message}`);
  }

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return {
    etag: res.headers?.get?.('etag') || '',
    store,
  };
}

/**
 * Performs an atomic read-merge-write sync against GitHub Gist.
 * Always fetches latest remote state before replaying pending local ops so PC and Phone never overwrite each other.
 */
export async function syncVocabGist({
  token,
  gistId,
  pendingOps = [],
  etag = '',
  fetchImpl,
  apiBase,
}) {
  const hasPending = Array.isArray(pendingOps) && pendingOps.length > 0;

  // If we have no local changes, use ETag conditional GET to avoid parsing/traffic when nothing changed
  const remote = await fetchVocabGist(token, gistId, {
    etag: hasPending ? '' : etag,
    fetchImpl,
    apiBase,
  });

  if (remote.notModified) {
    return {
      changed: false,
      etag: remote.etag,
      store: null,
      syncedOpsCount: 0,
    };
  }

  if (!hasPending && !remote.needsFileInit) {
    return {
      changed: true,
      etag: remote.etag,
      store: remote.store,
      syncedOpsCount: 0,
    };
  }

  const mergedStore = applyOpsToStore(remote.store, pendingOps);
  const patched = await patchVocabGist(token, gistId, mergedStore, { fetchImpl, apiBase });

  return {
    changed: true,
    etag: patched.etag,
    store: mergedStore,
    syncedOpsCount: pendingOps.length,
  };
}
