import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';

test('malformed URLs return 400 without stopping subsequent API and static requests', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts', '--production'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', CRON_SECRET: 'server-test-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      const match = output.match(/running at http:\/\/localhost:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited (${code}): ${errors}`)));
  });
  const call = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal((await call('/api/cron?manual=1')).status, 401);
  for (const target of ['//[', 'http://[']) {
    const malformed = await call(target);
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse(malformed.body), { error: 'invalid request URL' });
    assert.equal((await call('/api/cron?manual=1')).status, 401);
    assert.deepEqual(await call('/missing-server-test-file'), { status: 404, body: 'Not found' });
  }
  assert.equal(child.exitCode, null);
});
