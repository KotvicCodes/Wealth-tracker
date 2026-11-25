import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { BillionairesData, Person } from '../shared/types.js';

const person = (name: string, rank: number, worth: number, country: string, industry: string): Person => ({
  name, rank, worth, country, industry, prevWorth: worth - 100, archivedWorth: worth - 500,
  annual: { '2021': worth / 2, '2023': worth / 1.5, '2025': worth - 1000 },
  source: 'Example', gender: 'M', birthDate: 0, selfMade: true, image: null,
});
const data: BillionairesData = {
  asOf: Date.now(), count: 3, annualYears: [2021, 2022, 2023, 2024, 2025],
  archivedAsOf: new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10),
  people: [person('First Example', 1, 10_000, 'United States', 'Technology'),
    person('Second Example', 2, 5000, 'France', 'Fashion & Retail'),
    person('Third Example', 600, 2000, 'France', 'Technology')],
};

// Exercise the actual entrypoint. Chart rendering is stubbed because jsdom has
// no canvas implementation; configurations and chart creation still run.
const bundle = await build({
  entryPoints: ['app.ts'], bundle: true, write: false, format: 'iife',
  plugins: [{
    name: 'chart-test-double',
    setup(builder) {
      builder.onResolve({ filter: /^chart\.js\/auto$/ }, () => ({ path: 'chart', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export default class Chart {
          static defaults = { font: {}, plugins: { legend: {} } };
          constructor(canvas, config) { window.chartConfigs[canvas.id] = config; }
          destroy() {}
        }`, loader: 'js' }));
    },
  }],
});
const html = await readFile('index.html', 'utf8');

async function setup(failure = false) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only' });
  const win = dom.window;
  win.chartConfigs = {};
  win.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  win.HTMLCanvasElement.prototype.getContext = (() => null) as typeof win.HTMLCanvasElement.prototype.getContext;
  win.fetch = async (url: string) => {
    if (url === '/api/billionaires') return Response.json(failure ? { error: 'upstream unavailable' } : data, { status: failure ? 502 : 200 });
    if (url === '/api/history') return Response.json({
      snapshot: { asOf: Date.now() - 90 * 86_400_000, people: data.people.map((p) => [p.name, p.worth - 500]) },
    });
    return Response.json({ worldAdultsM: 5700, countryAdultsM: { France: 50 } });
  };
  win.eval(bundle.outputFiles[0].text);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom;
}

test('frontend loads rankings, filters, sorts, switches scope, and opens person details', async () => {
  const dom = await setup();
  const doc = dom.window.document;
  try {
    assert.equal(doc.querySelectorAll('#tbody tr').length, 3);
    assert.match(doc.getElementById('asof')!.textContent!, /3 billionaires/);
    const country = doc.getElementById('countryFilter') as HTMLSelectElement;
    country.value = 'France'; country.dispatchEvent(new dom.window.Event('change'));
    assert.equal(doc.querySelectorAll('#tbody tr').length, 2);
    doc.getElementById('scope500')!.click();
    assert.equal(doc.querySelectorAll('#tbody tr').length, 1);
    country.value = ''; country.dispatchEvent(new dom.window.Event('change'));
    doc.querySelector<HTMLElement>('th[data-sort="worth"]')!.click();
    assert.match(doc.querySelector('#tbody tr')!.textContent!, /First Example/);
    doc.querySelector<HTMLElement>('#tbody tr')!.click();
    assert.equal(doc.getElementById('personModal')!.hidden, false);
    assert.equal(doc.querySelectorAll('#modalStats .mstat').length, 7);
    assert.match(doc.getElementById('modalHead')!.textContent!, /First Example/);
    doc.getElementById('modalClose')!.click();
    assert.equal(doc.getElementById('personModal')!.hidden, true);
    const search = doc.getElementById('search') as HTMLInputElement;
    search.value = 'Second'; search.dispatchEvent(new dom.window.Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 175));
    assert.equal(doc.querySelectorAll('#tbody tr').length, 1);
    assert.match(doc.querySelector('#tbody tr')!.textContent!, /Second Example/);
  } finally { dom.window.close(); }
});

test('performance periods, analysis charts, and odds presets run with typed API fixtures', async () => {
  const dom = await setup();
  const win = dom.window;
  const doc = win.document;
  try {
    doc.querySelector<HTMLElement>('[data-view="performance"]')!.click();
    assert.equal(doc.querySelectorAll('#perfTiles .tile').length, 11);
    for (const period of ['day', 'm1', 'm3', 'ytd', 'y1', 'y3', 'y5']) {
      doc.querySelector<HTMLElement>(`[data-period="${period}"]`)!.click();
      assert.equal(win.localStorage.getItem('wt.period'), period);
      assert.ok(win.chartConfigs.chTraject);
    }
    doc.querySelector<HTMLElement>('[data-view="analysis"]')!.click();
    assert.ok(doc.querySelectorAll('#tiles .tile').length >= 8);
    assert.ok(win.chartConfigs.chWealthTime);
    doc.querySelector<HTMLElement>('[data-view="odds"]')!.click();
    doc.querySelector<HTMLElement>('[data-preset="0"]')!.click();
    assert.equal((doc.getElementById('oddsCountry') as HTMLSelectElement).value, 'United States');
    assert.match(doc.getElementById('oddsResult')!.textContent!, /Factor breakdown/);
    assert.equal(JSON.parse(win.localStorage.getItem('wt.odds')!).i, 'Technology');
  } finally { win.close(); }
});

test('frontend shows API failures without rendering a misleading empty dataset', async () => {
  const dom = await setup(true);
  try {
    assert.equal(dom.window.document.getElementById('error')!.hidden, false);
    assert.match(dom.window.document.getElementById('error')!.textContent!, /upstream unavailable/);
    assert.equal(dom.window.document.querySelectorAll('#tbody tr').length, 0);
  } finally { dom.window.close(); }
});
