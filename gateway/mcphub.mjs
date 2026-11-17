/** Discover and proxy MCPHub servers with the current tenant's VOS identity. */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { accessTokenFor } from './office.mjs';

const defaultBase = 'http://mcphub:3000/app/com.ictrek.mcphub';
const tenants = new Map();
const keys = new Map();

export function mcphubEnvironment(namespace) {
  if (!keys.has(namespace)) {
    const key = randomBytes(32).toString('hex');
    keys.set(namespace, key);
    tenants.set(key, { namespace, servers: new Map() });
  }
  return {
    VA_MCPHUB_URL: `http://127.0.0.1:${process.env.PORT ?? 8080}/__va/mcphub`,
    VA_MCPHUB_KEY: keys.get(namespace),
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function handleMcphub(req, res, path) {
  const tenant = tenants.get(req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]);
  if (!tenant) return json(res, 401, { error: 'invalid-capability' });

  const discovery = req.method === 'GET' && path === '/catalog';
  const server = tenant.servers.get(path);
  if (!discovery && (!server || !['GET', 'POST', 'DELETE'].includes(req.method))) {
    req.resume();
    return json(res, 404, { error: 'not-found' });
  }
  const token = await accessTokenFor(tenant.namespace);
  if (!token) {
    tenant.servers.clear();
    return json(res, 401, { error: 'vos-session-unavailable' });
  }
  const base = new URL(process.env.MCPHUB_URL ?? defaultBase);
  const headers = { authorization: `Bearer ${token}` };
  if (discovery) {
    try {
      const response = await fetch(`${base.href.replace(/\/$/, '')}/api/integration/discovery`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(4000),
      });
      if ([401, 403].includes(response.status)) {
        tenant.servers.clear();
        return json(res, response.status, { error: 'discovery-denied' });
      }
      if (!response.ok) return json(res, 502, { error: 'discovery-unavailable' });
      const body = await response.json();
      if (body.success !== true || !Array.isArray(body.data?.servers)) {
        return json(res, 502, { error: 'invalid-catalog' });
      }
      const prefix = base.pathname.replace(/\/$/, '');
      const entries = new Map();
      for (const row of body.data.servers) {
        if (typeof row?.name !== 'string' || !row.name || ['.', '..'].includes(row.name)) continue;
        const endpoint = `${prefix}/mcp/${encodeURIComponent(row.name)}`;
        if (row.mcp_path !== endpoint) continue;
        const id = 'mcphub__' + createHash('sha256').update(tenant.namespace).update('\0')
          .update(row.name).digest('hex').slice(0, 24);
        entries.set(`/mcp/${id}`, {
          id, name: row.name, description: typeof row.description === 'string' ? row.description : '',
          endpoint,
        });
      }
      tenant.servers = entries;
      return json(res, 200, {
        servers: [...entries.values()].map(({ id, name, description }) => ({ id, name, description })),
      });
    } catch {
      return json(res, 502, { error: 'discovery-unavailable' });
    }
  }

  const abort = new AbortController();
  res.once('close', () => abort.abort());
  headers.accept = 'application/json, text/event-stream';
  for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
  }
  let response;
  try {
    response = await fetch(new URL(server.endpoint, base.origin), {
      method: req.method, headers, redirect: 'error', signal: abort.signal,
      ...(req.method === 'POST' ? { body: req, duplex: 'half' } : {}),
    });
  } catch {
    if (!res.destroyed) json(res, 502, { error: 'mcphub-unavailable' });
    return;
  }
  const reply = { 'cache-control': 'no-store' };
  for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
    const value = response.headers.get(name);
    if (value !== null) reply[name] = value;
  }
  res.writeHead(response.status, reply);
  if (response.body) await pipeline(Readable.fromWeb(response.body), res).catch(() => res.destroy());
  else res.end();
}
