import annualBundle from '../api/annual.json' with { type: 'json' };
import { storage } from './storage.js';
import type { AnnualLists, BillionairesData, Person, Snapshot } from '../shared/types.js';

const FIELDS = 'rank,personName,finalWorth,estWorthPrev,archivedWorth,countryOfCitizenship,industries,source,gender,birthDate,selfMade,squareImage';
export const FORBES_URL = `https://www.forbes.com/forbesapi/person/rtb/0/position/true.json?fields=${FIELDS}`;
const ANNUAL_URL = (year: number) => `https://www.forbes.com/forbesapi/person/billionaires/${year}/position/true.json?fields=personName,finalWorth`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CACHE_TTL = 10 * 60_000;

export function latestListYear(today = new Date()): number {
  const year = today.getUTCFullYear();
  return today.getUTCMonth() > 3 || (today.getUTCMonth() === 3 && today.getUTCDate() >= 10) ? year : year - 1;
}

export function normalizeName(name: string | null | undefined): string {
  return (name || '').toLowerCase().replace(/\s*&\s*family/g, '').replace(/[^a-z ]/g, '').trim();
}

export async function httpGet<T>(url: string, timeout = 60_000): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new HttpError(response.status);
  return await response.json() as T;
}

class HttpError extends Error {
  constructor(readonly status: number) { super(`Upstream request failed (${status})`); }
}

interface ForbesPerson {
  rank?: number | null;
  personName: string;
  finalWorth?: number | null;
  estWorthPrev?: number | null;
  archivedWorth?: number | null;
  countryOfCitizenship?: string | null;
  industries?: string[] | null;
  source?: string | null;
  gender?: string | null;
  birthDate?: number | null;
  selfMade?: boolean | null;
  squareImage?: string | null;
}
interface ForbesResponse { personList: { personsLists: ForbesPerson[] } }

let annualCache: { latest: number; lists: AnnualLists } | undefined;
async function loadAnnual(latest: number): Promise<AnnualLists> {
  if (annualCache?.latest === latest) return annualCache.lists;
  const lists: AnnualLists = { ...annualBundle };
  const missing = Array.from({ length: Math.max(0, latest - 2021) }, (_, i) => 2021 + i)
    .filter((year) => !lists[year]);
  if (missing.length) {
    const extra = await storage.readBestEffort<AnnualLists>('annual_extra.json');
    let fetched = false;
    for (const year of missing) {
      if (extra[year]) { lists[year] = extra[year]; continue; }
      try {
        const payload = await httpGet<ForbesResponse>(ANNUAL_URL(year));
        lists[year] = extra[year] = Object.fromEntries(payload.personList.personsLists
          .filter((p) => p.finalWorth).map((p) => [normalizeName(p.personName), p.finalWorth!]));
        fetched = true;
      } catch (error) { console.warn(`warning: annual ${year} fetch failed:`, error); }
    }
    if (fetched) {
      try { await storage.write('annual_extra.json', extra); }
      catch (error) { console.warn('warning: could not cache annual lists:', error); }
    }
  }
  annualCache = { latest, lists };
  return lists;
}

async function fetchBillionaires(): Promise<BillionairesData> {
  let payload: ForbesResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { payload = await httpGet<ForbesResponse>(FORBES_URL); break; }
    catch (error) {
      if (error instanceof HttpError && error.status >= 500 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else throw error;
    }
  }
  if (!payload) throw new Error('Could not fetch Forbes data after retries');
  const latest = latestListYear();
  const annual = await loadAnnual(latest);
  const people: Person[] = payload.personList.personsLists.filter((p) => p.finalWorth).map((p) => ({
    rank: p.rank ?? null, name: p.personName, worth: p.finalWorth!,
    prevWorth: p.estWorthPrev ?? null, archivedWorth: p.archivedWorth ?? null,
    country: p.countryOfCitizenship ?? null, industry: p.industries?.[0] ?? null,
    source: p.source ?? null, gender: p.gender ?? null, birthDate: p.birthDate ?? null,
    selfMade: p.selfMade ?? null, image: p.squareImage ?? null,
    annual: Object.fromEntries(Object.entries(annual)
      .filter(([, worths]) => normalizeName(p.personName) in worths)
      .map(([year, worths]) => [year, worths[normalizeName(p.personName)]])),
  })).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return {
    asOf: Date.now(), count: people.length,
    annualYears: Array.from({ length: Math.max(0, latest - 2021) }, (_, i) => 2021 + i),
    archivedAsOf: latest === 2026 ? '2026-03-07' : `${latest}-04-01`, people,
  };
}

let cached: BillionairesData | undefined;
let fetchedAt = 0;
let pending: Promise<BillionairesData> | undefined;
export async function getBillionaires(): Promise<BillionairesData> {
  if (cached && Date.now() - fetchedAt < CACHE_TTL) return cached;
  pending ??= fetchBillionaires().then((data) => {
    cached = data; fetchedAt = Date.now(); return data;
  }).finally(() => { pending = undefined; });
  return pending;
}

export function snapshotEntry(data: BillionairesData): Snapshot {
  return { asOf: data.asOf, people: data.people.map((p) => [p.name, p.worth]) };
}
