import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { getBillionaires, snapshotEntry } from './forbes.js';
import { refreshIfStale } from './reference.js';
import { storage } from './storage.js';
import type { History, ReferenceData } from '../shared/types.js';

export type Route = 'billionaires' | 'history' | 'reference' | 'cron';
export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
  const json = Buffer.from(JSON.stringify(value));
  const gzip = /\bgzip\b(?!\s*;\s*q=0(?:[\s,]|$))/.test(req.headers['accept-encoding'] || '');
  const body = gzip ? gzipSync(json) : json;
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Content-Length': body.length, Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(body);
}

/** Shared by Vercel functions and the local development server. */
export async function handleApi(route: Route, req: IncomingMessage, res: ServerResponse, local = false): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return;
  }
  if (route === 'cron' && process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    sendJson(req, res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    switch (route) {
      case 'billionaires': {
        const data = await getBillionaires();
        if (local) {
          await storage.appendToday(snapshotEntry(data));
          await refreshIfStale();
        }
        sendJson(req, res, 200, data);
        break;
      }
      case 'history': sendJson(req, res, 200, await storage.readBestEffort<History>('history.json')); break;
      case 'reference': sendJson(req, res, 200, await storage.readBestEffort<ReferenceData>('reference.json')); break;
      case 'cron': {
        const data = await getBillionaires();
        const saved = await storage.appendToday(snapshotEntry(data));
        const reference = await refreshIfStale();
        sendJson(req, res, 200, { ok: true, saved, count: data.count, reference });
        break;
      }
    }
  } catch (error) {
    sendJson(req, res, route === 'cron' ? 500 : 502, {
      ...(route === 'cron' ? { ok: false } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
