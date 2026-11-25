import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { list, put } from '@vercel/blob';
import type { History, Snapshot } from '../shared/types.js';

const DATA_DIR = new URL('../data/', import.meta.url);
export const KEEP_DAYS = 130;
const DOCUMENTS = ['history.json', 'reference.json', 'annual_extra.json'] as const;
type DocumentName = typeof DOCUMENTS[number];

/** The Blob path and JSON formats match the existing Python deployment. */
export class Storage {
  constructor(private readonly directory: string | URL = DATA_DIR) {}

  async read<T extends object>(name: DocumentName): Promise<T> {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      // Prefixes may also match backups. Search all pages for the exact path.
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: name, cursor });
        const blob = page.blobs.find((item) => item.pathname === name);
        if (blob) {
          const response = await fetch(blob.downloadUrl || blob.url, {
            cache: 'no-store', signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`Blob download failed (${response.status})`);
          return await response.json() as T;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return {} as T;
    }
    try {
      return JSON.parse(await readFile(join(this.directoryPath(), name), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {} as T;
      throw error;
    }
  }

  async readBestEffort<T extends object>(name: DocumentName): Promise<T> {
    try { return await this.read<T>(name); }
    catch (error) { console.warn(`warning: could not read ${name}:`, error); return {} as T; }
  }

  async write(name: DocumentName, value: object): Promise<void> {
    const body = JSON.stringify(value);
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      await put(name, body, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json', cacheControlMaxAge: 60,
      });
      return;
    }
    const directory = this.directoryPath();
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, path);
  }

  private directoryPath(): string {
    return this.directory instanceof URL ? fileURLToPath(this.directory) : this.directory;
  }

  private pendingSnapshot: Promise<boolean> | undefined;

  async appendToday(entry: Snapshot, now = Date.now()): Promise<boolean> {
    // Serialize read-modify-write within a process, including concurrent local requests.
    const previous = this.pendingSnapshot;
    const operation = (async () => {
      await previous;
      try {
        const today = new Date(now).toISOString().slice(0, 10);
        const history = await this.read<History>('history.json');
        if (today in history) return false;
        history[today] = entry;
        const cutoff = now - KEEP_DAYS * 86_400_000;
        await this.write('history.json', Object.fromEntries(
          Object.entries(history).filter(([, snapshot]) => snapshot.asOf >= cutoff),
        ));
        return true;
      } catch (error) {
        console.warn('warning: could not save snapshot:', error);
        return false;
      }
    })();
    this.pendingSnapshot = operation;
    try { return await operation; }
    finally { if (this.pendingSnapshot === operation) this.pendingSnapshot = undefined; }
  }
}

export const storage = new Storage();
