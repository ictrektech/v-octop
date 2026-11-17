import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { handleMcphub, mcphubEnvironment } from './mcphub.mjs';
import { rememberTokens } from './office.mjs';

test('MCPHub catalog and streamed tool calls are scoped to the current VOS user', async (t) => {
  const prefix = '/app/com.ictrek.mcphub';
  const name = 'shared server';
  const endpoint = `${prefix}/mcp/shared%20server`;
  let enabled = true;
  let forwarded = 0;
  const upstream = createServer(async (req, res) => {
    const principal = req.headers.authorization;
    if (req.url === `${prefix}/api/integration/discovery`) {
      const servers = principal === 'Bearer fixture-a' && enabled
        ? [{ name, description: 'Fixture', mcp_path: endpoint, apiKey: 'not-for-clients' },
          { name: 'malformed', mcp_path: 'http://elsewhere.example/mcp' }]
        : [];
      res.end(JSON.stringify({ success: true, data: { servers } }));
      return;
    }
    assert.equal(req.url, endpoint);
    assert.equal(principal, 'Bearer fixture-a');
    assert.equal(req.headers['mcp-session-id'], 'fixture-session');
    assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
    assert.equal(req.headers.cookie, undefined);
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    forwarded++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'fixture-session' });
    res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());
  process.env.MCPHUB_URL = `http://127.0.0.1:${upstream.address().port}${prefix}`;
  t.after(() => { delete process.env.MCPHUB_URL; });

  rememberTokens('a', { access: 'fixture-a', expiresAt: Date.now() + 3600000 });
  rememberTokens('b', { access: 'fixture-b', expiresAt: Date.now() + 3600000 });
  const proxy = createServer((req, res) => void handleMcphub(req, res, req.url));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const headers = (namespace) => ({ authorization: `Bearer ${mcphubEnvironment(namespace).VA_MCPHUB_KEY}` });
  const discover = async (namespace) => (await (await fetch(origin + '/catalog', { headers: headers(namespace) })).json()).servers;
  const [service] = await discover('a');
  assert.deepEqual(service, { id: service.id, name, description: 'Fixture' });
  assert.deepEqual(await discover('b'), []);
  const url = origin + '/mcp/' + service.id;
  assert.equal((await fetch(url, { headers: headers('b') })).status, 404);
  assert.equal((await fetch(url)).status, 401);
  const result = await fetch(url, { method: 'POST',
    headers: { ...headers('a'), 'content-type': 'application/json', 'mcp-session-id': 'fixture-session',
      'mcp-protocol-version': '2025-03-26', cookie: 'not-for-upstream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  assert.equal(result.headers.get('mcp-session-id'), 'fixture-session');
  assert.match(await result.text(), /"tools":\[\]/);
  assert.equal(forwarded, 1);
  enabled = false;
  assert.deepEqual(await discover('a'), []);
  assert.equal((await fetch(url, { headers: headers('a') })).status, 404);
});
