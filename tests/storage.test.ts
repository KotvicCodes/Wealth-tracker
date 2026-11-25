import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { Storage } from '../lib/storage.js';
import type { History } from '../shared/types.js';

let directory: string;
process.env.VERCEL_BLOB_RETRIES = '0';
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
beforeEach(async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  // Keep test files on the workspace volume, separate from real application data.
  directory = await mkdtemp(join(process.cwd(), 'node_modules/.storage-test-'));
});
afterEach(async () => {
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  await rm(directory, { recursive: true, force: true });
});

test('local JSON storage round-trips existing formats and handles missing/corrupt files', async () => {
  const store = new Storage(directory);
  assert.deepEqual(await store.read('history.json'), {});
  const payload = { '2026-01-01': { asOf: 123, people: [['Example', 100]] } };
  await store.write('history.json', payload);
  assert.deepEqual(await store.read('history.json'), payload);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')), payload);
  await writeFile(join(directory, 'reference.json'), '{broken');
  assert.deepEqual(await store.read('reference.json'), {});
});

test('daily snapshots use UTC dates, retain 130 days, and save once for concurrent requests', async () => {
  const store = new Storage(directory);
  const now = Date.parse('2026-11-25T00:01:00Z');
  await store.write('history.json', {
    expired: { asOf: now - 131 * 86_400_000, people: [] },
    recent: { asOf: now - 90 * 86_400_000, people: [['Example', 80]] },
  });
  const snapshot = { asOf: now, people: [['Example', 100] as [string, number]] };
  assert.deepEqual(await Promise.all([store.appendToday(snapshot, now), store.appendToday(snapshot, now)]), [true, false]);
  const history = await store.read<History>('history.json');
  assert.deepEqual(Object.keys(history), ['recent', '2026-11-25']);
  assert.deepEqual(history['2026-11-25'], snapshot);
});

test('the installed Blob SDK uploads stable public JSON paths with overwrite enabled', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_only_token';
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  try {
    const payload = { example: [1, 2, 3] };
    agent.get('https://vercel.com').intercept({
      path: '/api/blob/?pathname=history.json', method: 'PUT', body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
        'x-content-type': 'application/json', 'x-cache-control-max-age': '60', 'x-add-random-suffix': '0', 'x-allow-overwrite': '1',
      },
    }).reply(200, { pathname: 'history.json', url: 'https://test.public.blob.vercel-storage.com/history.json' });
    await new Storage(directory).write('history.json', payload);
    agent.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await agent.close(); }
});

test('Blob reads paginate past backup prefix matches and download only the exact path', async (t) => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_only_token';
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://vercel.com');
    pool.intercept({ method: 'GET', path: '/api/blob?prefix=reference.json' }).reply(200, {
      blobs: [{ pathname: 'reference.json.backup', url: 'https://example.invalid/backup' }],
      hasMore: true, cursor: 'next',
    });
    pool.intercept({ method: 'GET', path: '/api/blob?prefix=reference.json&cursor=next' }).reply(200, {
      blobs: [{ pathname: 'reference.json', url: 'https://example.invalid/reference.json' }], hasMore: false,
    });
    const payload = { worldAdultsM: 5700 };
    const download = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
      assert.equal(String(input), 'https://example.invalid/reference.json');
      return Response.json(payload);
    });
    assert.deepEqual(await new Storage(directory).read('reference.json'), payload);
    assert.equal(download.mock.callCount(), 1);
    agent.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await agent.close(); }
});

test('a missing Blob returns an empty document without a download', async (t) => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_only_token';
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  try {
    agent.get('https://vercel.com').intercept({ method: 'GET', path: '/api/blob?prefix=history.json' })
      .reply(200, { blobs: [], hasMore: false });
    const download = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected download'); });
    assert.deepEqual(await new Storage(directory).read('history.json'), {});
    assert.equal(download.mock.callCount(), 0);
    agent.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); await agent.close(); }
});
