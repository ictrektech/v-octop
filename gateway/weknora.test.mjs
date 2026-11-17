import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { closeWeknoraCapabilities, ensureWeknoraCapability } from './weknora.mjs';

function health(socketPath) {
  return new Promise((resolve, reject) => {
    get({ socketPath, path: '/health', agent: false }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('HybRAG socket recovers after the previous gateway closes', async t => {
  const home = mkdtempSync(join(tmpdir(), 'octop-hyb-'));
  const socketDir = join(home, '.vagent');
  mkdirSync(socketDir);
  const socketPath = join(socketDir, 'weknora.sock');
  const upstream = createServer((_req, res) => res.end('ok'));
  const legacy = createServer((_req, res) => res.writeHead(503).end());
  const previousAddress = process.env.WEKNORA_URL;
  t.after(async () => {
    await closeWeknoraCapabilities();
    await Promise.all([upstream, legacy].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(home, { recursive: true, force: true });
    if (previousAddress === undefined) delete process.env.WEKNORA_URL;
    else process.env.WEKNORA_URL = previousAddress;
  });

  await once(upstream.listen(0, '127.0.0.1'), 'listening');
  process.env.WEKNORA_URL = `http://127.0.0.1:${upstream.address().port}`;
  await once(legacy.listen(socketPath), 'listening');
  await ensureWeknoraCapability({ namespace: 'test', linuxName: 'test', home, userHelper: '/bin/true' });
  assert.equal(await health(socketPath), 200);
  const before = statSync(socketPath);
  assert.equal(before.mode & 0o777, 0o600);

  await new Promise(resolve => legacy.close(resolve));
  assert.throws(() => statSync(socketPath), { code: 'ENOENT' });
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const current = statSync(socketPath, { throwIfNoEntry: false });
    if (current) {
      assert.equal(current.ino, before.ino);
      assert.equal(await health(socketPath), 200);
      return;
    }
    await delay(100);
  }
  assert.fail('the running gateway did not restore the HybRAG socket');
});
