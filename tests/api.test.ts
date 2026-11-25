import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { handleApi, type Route } from '../lib/handler.js';
import { latestListYear, normalizeName, FORBES_URL, getBillionaires } from '../lib/forbes.js';
import { refreshIfStale } from '../lib/reference.js';
import { storage } from '../lib/storage.js';
import type { Snapshot, ReferenceData } from '../shared/types.js';

test('annual periods advance at the April 10 UTC boundary and names join across annual lists', () => {
  assert.equal(latestListYear(new Date('2027-04-09T23:59:59Z')), 2026);
  assert.equal(latestListYear(new Date('2027-04-10T00:00:00Z')), 2027);
  assert.equal(latestListYear(new Date('2027-01-01')), 2026);
  assert.equal(normalizeName('  Jane Smith & family'), 'jane smith');
  assert.equal(normalizeName('François Example'), 'franois example');
});

test('API routes preserve payloads, caching, errors, gzip, and cron behavior', async (t) => {
  const originalSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  t.after(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });
  t.mock.method(globalThis, 'Date', class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? '2026-11-25T12:00:00Z'); }
  });
  let now = Date.parse('2026-11-25T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  let upstreamStatus = 200;
  const upstream = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), FORBES_URL);
    return Response.json({ personList: { personsLists: [
      { personName: 'Elon Musk', rank: 2, finalWorth: 200_000, estWorthPrev: 190_000, industries: ['Automotive', 'Technology'] },
      { personName: 'Example & family', rank: 1, finalWorth: 300_000 },
      { personName: 'Zero', finalWorth: 0 },
    ] } }, { status: upstreamStatus });
  });
  const saved: Snapshot[] = [];
  t.mock.method(storage, 'appendToday', async (entry: Snapshot) => { saved.push(entry); return saved.length === 1; });
  const reference: ReferenceData = { updatedAt: now, worldAdultsM: 5700 };
  const history = { '2026-01-01': { asOf: 123, people: [['Example', 100]] } };
  t.mock.method(storage, 'readBestEffort', async (name: string) => name === 'history.json' ? history : reference);

  const server = createServer((req, res) => { void handleApi(req.url!.slice(5).split('?')[0] as Route, req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const body = res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
          resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(body.toString()) });
        });
      });
      req.on('error', reject); req.end();
    });

  await t.test('live results sort, trim, attach annual values, and share concurrent fetches', async () => {
    const [first, second] = await Promise.all([call('/api/billionaires'), call('/api/billionaires')]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, second.body);
    assert.equal(first.body.count, 2);
    const people = first.body.people as { name: string; annual: Record<string, number>; industry: string | null }[];
    assert.equal(people[0].name, 'Example & family');
    assert.equal(people[0].industry, null);
    assert.equal(people[1].industry, 'Automotive');
    assert.ok(people[1].annual['2021'] > 0);
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(saved.length, 0); // Only cron writes in production.
  });
  await t.test('history and reference use the existing JSON shapes and optional gzip', async () => {
    const result = await call('/api/history?unused=1', { 'accept-encoding': 'gzip' });
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(result.headers.vary, 'Accept-Encoding');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(result.body, history);
    assert.deepEqual((await call('/api/reference')).body, reference);
  });
  await t.test('cron rejects missing/wrong secrets before making side effects', async () => {
    process.env.CRON_SECRET = 'test-secret';
    assert.equal((await call('/api/cron')).status, 401);
    assert.equal((await call('/api/cron', { authorization: 'Bearer incorrect' })).status, 401);
    assert.equal(saved.length, 0);
    const result = await call('/api/cron', { authorization: 'Bearer test-secret' });
    assert.deepEqual(result.body, { ok: true, saved: true, count: 2, reference: 'fresh' });
    assert.deepEqual(saved[0].people, [['Example & family', 300_000], ['Elon Musk', 200_000]]);
  });
  await t.test('non-GET calls return 405', async () => {
    const result = await call('/api/cron', {}, 'POST');
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, 'GET');
  });
  await t.test('expired cache refetches and upstream failures become JSON errors', async () => {
    now += 11 * 60_000;
    upstreamStatus = 403;
    const result = await call('/api/billionaires');
    assert.equal(result.status, 502);
    assert.match(String(result.body.error), /403/);
    const cron = await call('/api/cron', { authorization: 'Bearer test-secret' });
    assert.equal(cron.status, 500);
    assert.equal(cron.body.ok, false);
    upstreamStatus = 200;
    assert.equal((await call('/api/billionaires')).status, 200);
  });
});

test('population refresh preserves World Bank units, fallback data, and weekly cadence', async (t) => {
  t.mock.method(storage, 'readBestEffort', async () => ({}));
  let written: ReferenceData | undefined;
  t.mock.method(storage, 'write', async (name: string, value: ReferenceData) => {
    assert.equal(name, 'reference.json'); written = value;
  });
  const upstream = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.match(String(url), /SP.POP.1564.TO/);
    return Response.json([{}, [
      { countryiso3code: 'WLD', value: 5_700_000_000 },
      { countryiso3code: 'USA', value: 220_123_456 },
      { countryiso3code: 'FRA', value: null },
    ]]);
  });
  assert.equal(await refreshIfStale(), 'updated');
  assert.equal(written?.worldAdultsM, 5700);
  assert.deepEqual(written?.countryAdultsM, { 'United States': 220.123 });
  t.mock.method(storage, 'readBestEffort', async () => written);
  assert.equal(await refreshIfStale(), 'fresh');
  assert.equal(upstream.mock.callCount(), 1);
});

test('malformed population data is a best-effort failure', async (t) => {
  t.mock.method(storage, 'readBestEffort', async () => ({}));
  t.mock.method(globalThis, 'fetch', async () => Response.json([{}, []]));
  t.mock.method(console, 'warn', () => {});
  const write = t.mock.method(storage, 'write', async () => {});
  assert.equal(await refreshIfStale(), 'failed');
  assert.equal(write.mock.callCount(), 0);
});


test('future annual lists merge bundled years with stored and newly fetched lists', async (t) => {
  t.mock.method(globalThis, 'Date', class FixedDate extends Date {
    constructor(value?: string | number) { super(value ?? '2028-05-01T12:00:00Z'); }
    static now() { return Date.parse('2028-05-01T12:00:00Z'); }
  });
  t.mock.method(Date, 'now', () => Date.parse('2028-05-01T12:00:00Z'));
  const extra = { '2026': { 'elon musk': 250_000 } };
  t.mock.method(storage, 'readBestEffort', async (name: string) => {
    assert.equal(name, 'annual_extra.json'); return extra;
  });
  const write = t.mock.method(storage, 'write', async (name: string, value: object) => {
    assert.equal(name, 'annual_extra.json');
    assert.deepEqual(value, { ...extra, '2027': { 'elon musk': 275_000 } });
  });
  const upstream = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    if (String(url) === FORBES_URL) return Response.json({ personList: { personsLists: [
      { personName: 'Elon Musk', rank: 1, finalWorth: 300_000 },
    ] } });
    assert.match(String(url), /billionaires\/2027\//);
    return Response.json({ personList: { personsLists: [{ personName: 'Elon Musk & family', finalWorth: 275_000 }] } });
  });
  const result = await getBillionaires();
  assert.equal(result.archivedAsOf, '2028-04-01');
  assert.equal(result.annualYears.at(-1), 2027);
  assert.equal(result.people[0].annual['2026'], 250_000);
  assert.equal(result.people[0].annual['2027'], 275_000);
  assert.ok(result.people[0].annual['2021'] > 0);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(upstream.mock.callCount(), 2);
});
