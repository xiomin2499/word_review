import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStudyEntry, createEmptyStore } from '../shared/sync-core.js';
import {
  VOCAB_FILENAME,
  findOrCreateVocabGist,
  syncVocabGist,
  validateToken,
} from '../shared/gist-client.js';

function createMockGitHubServer() {
  const gists = new Map();
  let seq = 1;

  const mockFetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const auth = init.headers?.Authorization || init.headers?.authorization || '';
    if (auth !== 'Bearer valid_token') {
      return new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/user') && method === 'GET') {
      return new Response(JSON.stringify({ login: 'coder-user', avatar_url: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'gist' },
      });
    }

    if (url.includes('/gists?per_page=') && method === 'GET') {
      return new Response(JSON.stringify(Array.from(gists.values())), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/gists') && method === 'POST') {
      const body = JSON.parse(init.body);
      const id = `gist_${seq++}`;
      const record = {
        id,
        description: body.description,
        public: body.public,
        html_url: `https://gist.github.com/${id}`,
        etag: `"etag-${seq}"`,
        files: Object.fromEntries(
          Object.entries(body.files).map(([name, f]) => [name, { filename: name, content: f.content }])
        ),
      };
      gists.set(id, record);
      return new Response(JSON.stringify(record), {
        status: 201,
        headers: { 'content-type': 'application/json', etag: record.etag },
      });
    }

    const gistMatch = url.match(/\/gists\/([^/?]+)$/);
    if (gistMatch) {
      const id = decodeURIComponent(gistMatch[1]);
      const record = gists.get(id);
      if (!record) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (method === 'GET') {
        const ifNoneMatch = init.headers?.['If-None-Match'];
        if (ifNoneMatch && ifNoneMatch === record.etag) {
          return new Response(null, { status: 304, headers: { etag: record.etag } });
        }
        return new Response(JSON.stringify(record), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: record.etag },
        });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        record.etag = `"etag-${++seq}"`;
        for (const [name, f] of Object.entries(body.files)) {
          record.files[name] = { filename: name, content: f.content };
        }
        return new Response(JSON.stringify(record), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: record.etag },
        });
      }
    }

    return new Response('Unhandled', { status: 500 });
  };

  return { mockFetch, gists };
}

test('full PC -> Gist -> Phone -> Gist -> PC concurrent sync preserves both devices updates', async () => {
  const { mockFetch } = createMockGitHubServer();

  // 1. Validate invalid & valid token
  await assert.rejects(() => validateToken('bad', { fetchImpl: mockFetch }), /无效/);
  const user = await validateToken('valid_token', { fetchImpl: mockFetch });
  assert.equal(user.login, 'coder-user');

  // 2. First setup creates private gist; second call finds existing gist
  const created = await findOrCreateVocabGist('valid_token', { fetchImpl: mockFetch });
  assert.equal(created.created, true);
  const found = await findOrCreateVocabGist('valid_token', { fetchImpl: mockFetch });
  assert.equal(found.created, false);
  assert.equal(found.gistId, created.gistId);

  // 3. PC extension syncs "params" and "probe"
  const pcResult = await syncVocabGist({
    token: 'valid_token',
    gistId: created.gistId,
    fetchImpl: mockFetch,
    pendingOps: [
      {
        type: 'upsert_lookup',
        opId: 'pc-1',
        timestamp: '2026-11-18T10:00:00.000Z',
        entry: extractStudyEntry({ sourceText: 'params', translatedText: '参数' }),
      },
      {
        type: 'upsert_lookup',
        opId: 'pc-2',
        timestamp: '2026-11-18T10:01:00.000Z',
        entry: extractStudyEntry({ sourceText: 'probe', translatedText: '探测' }),
      },
    ],
  });
  assert.equal(Object.keys(pcResult.store.items).length, 2);

  // 4. Phone reads via ETag (first gets full data, second gets 304 notModified)
  const phoneInitial = await syncVocabGist({
    token: 'valid_token',
    gistId: created.gistId,
    fetchImpl: mockFetch,
  });
  assert.equal(phoneInitial.changed, true);
  assert.equal(phoneInitial.store.items.params.meaning, '参数');

  const phone304 = await syncVocabGist({
    token: 'valid_token',
    gistId: created.gistId,
    etag: phoneInitial.etag,
    fetchImpl: mockFetch,
  });
  assert.equal(phone304.changed, false);

  // 5. Concurrent edits: Phone marks "params" mastered AND PC adds "idempotent" without knowing yet
  await syncVocabGist({
    token: 'valid_token',
    gistId: created.gistId,
    fetchImpl: mockFetch,
    pendingOps: [
      {
        type: 'review',
        opId: 'phone-1',
        timestamp: '2026-11-18T11:00:00.000Z',
        id: 'params',
        rating: 'master',
      },
    ],
  });

  const pcAfterPhone = await syncVocabGist({
    token: 'valid_token',
    gistId: created.gistId,
    fetchImpl: mockFetch,
    pendingOps: [
      {
        type: 'upsert_lookup',
        opId: 'pc-3',
        timestamp: '2026-11-18T11:01:00.000Z',
        entry: extractStudyEntry({ sourceText: 'idempotent', translatedText: '幂等' }),
      },
    ],
  });

  // Both phone's "mastered" status on params AND PC's new word "idempotent" exist together!
  assert.equal(pcAfterPhone.store.items.params.status, 'mastered');
  assert.equal(pcAfterPhone.store.items.idempotent.meaning, '幂等');
  assert.equal(pcAfterPhone.store.items.probe.meaning, '探测');
});
