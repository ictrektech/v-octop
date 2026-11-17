// Adapted from ictrektech/v-harness gateway/vos-ops.mjs (43cb212e99, MIT, see LICENSE.v-harness).
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

export const OPS_PATH = '/__va/vos-ops';
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const ACTIONS = new Set(['restart', 'stop-container', 'remove-container', 'remove-image']);
const LOG_QUERY = 'stdout=1&stderr=1&timestamps=1&tail=';
const LOG_DEFAULT_TAIL = 150;
const LOG_SCAN_TAIL = 1000;
const LOG_MAX_RECORDS = 300;
const LOG_MAX_CONTEXT = 50;
const LOG_BYTES = 1024 * 1024;
const LOG_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;
const LOG_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Cursor values echo a Docker stamp, so only the Z form is accepted and padded
// comparisons stay valid across RFC3339Nano's trimmed trailing zeros.
const LOG_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const LOG_SPAN = /^(\d{1,8})(ms|s|m|h|d)$/;
const LOG_SPAN_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
const PATTERN_MAX = 200;
const DIAGNOSE_TAIL = 2000;
const DIAGNOSE_ERROR_GROUPS = 40;
const DIAGNOSE_ERROR_SAMPLE = 300;
const DIAGNOSE_HEALTH_OUTPUT = 500;
const ERROR_LINE = /\b(?:error|fatal|panic|exception|traceback|failed|failure)\b/i;

class OpsError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

const denied = () => new OpsError(403, 'forbidden');
const stale = () => new OpsError(409, 'target-changed');
const bounded = (value, size = 2000) => typeof value === 'string' ? value.slice(0, size) : '';

function engine(method, path, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const requestOptions = { method, path, socketPath: process.env.VA_DOCKER_SOCK ?? '/var/run/docker.sock',
      signal: AbortSignal.timeout(method === 'GET' ? 8000 : 35000) };
    const req = request(requestOptions, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new OpsError(status === 404 ? 404 : [304, 409].includes(status) ? 409 : 502,
          status === 404 ? 'not-found' : [304, 409].includes(status) ? 'target-changed' : 'docker-unavailable'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) res.destroy(new OpsError(502, 'response-too-large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function dockerJson(path) {
  return JSON.parse(await engine('GET', path));
}

async function vos(token, path, body, base) {
  const res = await fetch(new URL(path, base), {
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const response = await res.json();
  if (res.status === 401 || response.code === 10001) throw new OpsError(401, 'sign-in-required');
  if (res.status === 403 || response.code === 10002) throw denied();
  if (response.code === 10067) throw new OpsError(404, 'not-found');
  if (response.code === 10068) throw stale();
  if (!res.ok || response.code !== 0 || !response.data) throw new OpsError(502, 'vos-request-failed');
  return response.data;
}

function mainStack(container) {
  const labels = container.Labels ?? {};
  if (labels['io.vos.platform.managed'] !== 'true' || labels['io.vos.platform.kind'] !== 'app') return null;
  const project = labels['com.docker.compose.project'];
  if (!/^vos-app-[a-z0-9_-]+-[0-9a-hjkmnp-tv-z]{26}$/.test(project ?? '')) return null;
  const ordinal = labels['com.docker.compose.container-number'];
  const service = labels['com.docker.compose.service'];
  if (!/^[1-9][0-9]*$/.test(ordinal ?? '') || !/^[a-z0-9][a-z0-9_.-]*$/i.test(service ?? '') ||
      !(container.Names ?? []).some(name => name === `/${project}-${service}-${ordinal}`)) return null;
  const config = labels['com.docker.compose.project.config_files'];
  const match = /\/apps\/([a-z0-9][a-z0-9._-]{0,127})\/([a-zA-Z0-9.+-]+)\/rendered\/docker-compose\.yml$/.exec(config ?? '');
  if (!match || !project.startsWith(`vos-app-${match[1].toLowerCase().replace(/\./g, '-')}-`)) return null;
  return { appId: match[1], version: match[2], project };
}

const SELF_APP_ID = 'com.ictrek.v-octop';

// Diagnostic reports are restricted to named VOS app-stack containers.
function visible(c) {
  const stack = mainStack(c);
  return stack !== null && stack.appId !== SELF_APP_ID;
}

function summarizeContainer(c, apps) {
  const stack = mainStack(c);
  const app = stack ? apps.find(a => a.appId === stack.appId) : undefined;
  const retired = Boolean(app && ['installed', 'stopped'].includes(app.state) && app.version !== stack.version);
  return {
    id: c.Id, name: bounded(c.Names?.[0]?.replace(/^\//, ''), 200), image: bounded(c.Image, 300),
    imageId: c.ImageID, state: bounded(c.State, 40), status: bounded(c.Status, 300), stack,
    ports: (c.Ports ?? []).filter(p => p.PublicPort).map(p => ({
      hostPort: p.PublicPort, containerPort: p.PrivatePort, protocol: p.Type, address: p.IP ?? '',
    })),
    stoppable: retired && stack.appId !== SELF_APP_ID && ['running', 'restarting'].includes(c.State),
    cleanup: retired && stack.appId !== SELF_APP_ID && ['created', 'exited'].includes(c.State),
  };
}

function candidates(images, containers) {
  const inUse = new Set(containers.map(c => c.ImageID));
  return images.filter(i => IMAGE_ID.test(i.Id) && !inUse.has(i.Id)
    && (i.RepoTags ?? []).every(t => t === '<none>:<none>')
    && (i.RepoDigests ?? []).every(t => t === '<none>@<none>'))
    .map(i => ({ id: i.Id, created: i.Created, bytes: i.Size }));
}

function taggedImages(images, containers) {
  const inUse = new Set(containers.map(c => c.ImageID));
  return images.filter(i => IMAGE_ID.test(i.Id) && !inUse.has(i.Id))
    .map(i => ({ id: i.Id, tags: (i.RepoTags ?? []).filter(t => t !== '<none>:<none>').sort(),
      bytes: i.Size, digests: (i.RepoDigests ?? []).filter(d => d !== '<none>@<none>').sort() }))
    .filter(i => i.tags.length > 0);
}

function logText(data) {
  // Non-TTY Docker streams prepend an eight-byte header to each frame.
  if (data.length < 8 || ![1, 2].includes(data[0]) || data[1] || data[2] || data[3]) {
    return data.toString('utf8');
  }
  const lines = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const end = offset + 8 + data.readUInt32BE(offset + 4);
    if (end > data.length || ![1, 2].includes(data[offset])) throw new OpsError(502, 'docker-unavailable');
    lines.push(data.subarray(offset + 8, end).toString('utf8'));
    offset = end;
  }
  return lines.join('');
}

/**
 * Docker timestamps mark log frames; a frame may carry several lines and only
 * its first line is stamped. Continuation lines fold into the previous record
 * so stack traces stay whole for filtering and context.
 */
function logRecords(data) {
  const records = [];
  let current = null;
  for (const line of logText(data).replace(/\n$/, '').split('\n')) {
    const match = LOG_TS.exec(line);
    if (match) {
      current = { ts: match[1], text: line.slice(match[1].length + 1) };
      records.push(current);
    } else if (current) current.text += '\n' + line;
    else if (line) {
      current = { ts: null, text: line };
      records.push(current);
    }
  }
  return records;
}

function logSince(value, nowMs, code) {
  if (value === null) return null;
  if (LOG_RFC3339.test(value) && !Number.isNaN(Date.parse(value))) {
    return { docker: value, ms: Date.parse(value) };
  }
  const span = LOG_SPAN.exec(value);
  if (span) {
    const ms = nowMs - Number(span[1]) * LOG_SPAN_MS[span[2]];
    return { docker: new Date(ms).toISOString(), ms };
  }
  throw new OpsError(400, code);
}

const logNano = ts => ts.replace(/(?:\.(\d+))?Z$/, (_, frac = '') => '.' + frac.padEnd(9, '0') + 'Z');

/**
 * Parses the shared log query: since/until (RFC 3339 or a span like 30m),
 * after (a Z-form RFC 3339 polling cursor), pattern (case-insensitive) and
 * context (records around each match). The cursor and time bounds go to Docker
 * as since/until; the cursor is exclusive by stamp so polling resumes exactly
 * after the last record already seen. With any of them the Docker-side scan
 * window widens from the default tail.
 */
function logFilter(url, nowMs) {
  const since = logSince(url.searchParams.get('since'), nowMs, 'invalid-since');
  const until = logSince(url.searchParams.get('until'), nowMs, 'invalid-until');
  if (since && until && until.ms < since.ms) throw new OpsError(400, 'invalid-since');
  let after = null;
  const raw = url.searchParams.get('after');
  if (raw !== null) {
    if (raw.length > 40 || !LOG_CURSOR.test(raw) || Number.isNaN(Date.parse(raw))) {
      throw new OpsError(400, 'invalid-after');
    }
    after = raw;
  }
  if (after && since) throw new OpsError(400, 'invalid-after');
  if (after && until && until.ms < Date.parse(after)) throw new OpsError(400, 'invalid-after');
  let pattern = null;
  const patternRaw = url.searchParams.get('pattern');
  if (patternRaw !== null) {
    if (patternRaw.length < 1 || patternRaw.length > PATTERN_MAX) throw new OpsError(400, 'invalid-pattern');
    pattern = patternRaw.toLowerCase();
  }
  let context = 0;
  if (url.searchParams.has('context')) {
    context = Number(url.searchParams.get('context'));
    if (!Number.isInteger(context) || context < 0 || context > LOG_MAX_CONTEXT) throw new OpsError(400, 'invalid-context');
  }
  const lower = since ?? (after ? { docker: after } : null);
  const query = LOG_QUERY + (lower || until || pattern ? LOG_SCAN_TAIL : LOG_DEFAULT_TAIL) +
    (lower ? '&since=' + encodeURIComponent(lower.docker) : '') +
    (until ? '&until=' + encodeURIComponent(until.docker) : '');
  return { since, until, after, cursor: after === null ? null : logNano(after), pattern, context, query };
}

/**
 * Applies the parsed filter to parsed records. Time filtering only drops
 * records with a parsable stamp, so unlabeled frames stay visible. The after
 * cursor is exclusive by padded stamp, so records at or before the cursor are
 * dropped even when Docker's since is inclusive at the boundary. Context
 * windows never cross the since/until boundary. Beyond LOG_MAX_RECORDS the
 * earliest records are returned and `truncated` reports the remainder.
 */
function filterRecords(records, filter) {
  const window = [];
  records.forEach((record, index) => {
    const ts = record.ts === null ? null : Date.parse(record.ts);
    if (filter.cursor !== null && record.ts !== null && logNano(record.ts) <= filter.cursor) return;
    if (ts !== null && !Number.isNaN(ts)) {
      if (filter.since && ts < filter.since.ms) return;
      if (filter.until && ts > filter.until.ms) return;
    }
    window.push(index);
  });
  const windowSet = new Set(window);
  const picked = new Set();
  for (const index of window) {
    if (filter.pattern === null || records[index].text.toLowerCase().includes(filter.pattern)) picked.add(index);
  }
  if (filter.pattern !== null && filter.context > 0) {
    for (const index of [...picked]) {
      for (let offset = index - filter.context; offset <= index + filter.context; offset++) {
        if (windowSet.has(offset)) picked.add(offset);
      }
    }
  }
  const selected = [...picked].sort((a, b) => a - b).map(index => records[index]);
  const truncated = selected.length > LOG_MAX_RECORDS;
  return { records: truncated ? selected.slice(0, LOG_MAX_RECORDS) : selected,
    truncated, scanned: records.length, window: window.length };
}

function logsPayload(id, result, filter) {
  const text = result.records.map(record => (record.ts ? record.ts + ' ' : '') + record.text).join('\n');
  const stamped = result.records.filter(record => record.ts !== null);
  // Polling resumes from the last returned stamp; without new records the
  // cursor stays where the caller left it so the next poll retries the gap.
  const next = stamped.at(-1)?.ts ?? filter.after ?? null;
  return { id, text, truncated: result.truncated, scanned: result.scanned,
    returned: result.records.length, first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null, next };
}

/**
 * Merges every stack member's parsed records into one timeline ordered by
 * padded Docker stamps, tagging each record with its container name. Unstamped
 * leading records travel with the container's first stamp so they stay next to
 * the records they precede on their own stream.
 */
function appLogsPayload(appId, sources, filter) {
  const rows = [];
  for (const { name, records } of sources) {
    let anchor = '';
    for (const record of records) {
      if (record.ts !== null) anchor = logNano(record.ts);
      rows.push({ ts: record.ts, text: record.text, name, anchor });
    }
  }
  rows.sort((a, b) => a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0);
  const result = filterRecords(rows, filter);
  const text = result.records
    .map(row => (row.ts ? row.ts + ' ' : '') + `[${row.name}] ${row.text}`).join('\n');
  const stamped = result.records.filter(row => row.ts !== null);
  const next = stamped.at(-1)?.ts ?? filter.after ?? null;
  return { appId, containers: sources.map(source => source.name), text,
    truncated: result.truncated, scanned: result.scanned, returned: result.records.length,
    first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null, next };
}

/**
 * Collapses repeated error lines into one entry with a count and span so a
 * recurring exception costs one row instead of hundreds.
 */
function errorGroups(records) {
  const groups = new Map();
  for (const record of records) {
    if (!ERROR_LINE.test(record.text)) continue;
    const key = record.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const entry = groups.get(key) ?? { count: 0, first: null, last: null, sample: '' };
    entry.count++;
    if (record.ts !== null) {
      if (entry.first === null || record.ts < entry.first) entry.first = record.ts;
      if (entry.last === null || record.ts > entry.last) entry.last = record.ts;
    }
    if (!entry.sample) entry.sample = bounded(record.text, DIAGNOSE_ERROR_SAMPLE);
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, DIAGNOSE_ERROR_GROUPS);
}

const capabilityKeys = new Map();
const tenants = new Map();
const READ_PATHS = new Set(['/inventory', '/status', '/logs', '/app-logs', '/diagnose']);
const GRANT_TTL_MS = 15 * 60 * 1000;
const CONFIRM_TTL_MS = 60 * 1000;

export function vosOpsEnvironment(namespace) {
  let key = capabilityKeys.get(namespace);
  if (!key) {
    key = randomBytes(32).toString('hex');
    capabilityKeys.set(namespace, key);
    tenants.set(key, namespace);
  }
  return {
    VA_VOS_OPS_URL: `http://127.0.0.1:${process.env.PORT ?? 8080}${OPS_PATH}/agent`,
    VA_VOS_OPS_KEY: key,
  };
}

export function createVosOps({
  sessionFor, tokenFor, userinfoUrl, readBody, respond, daemon = dockerJson,
  daemonCall = engine, platform = vos, now = Date.now, audit = console.info,
}) {
  const grants = new Map();

  function closeSession(sessionId) {
    for (const [key, grant] of grants) {
      if (grant.sessionId === sessionId) grants.delete(key);
    }
  }

  async function requireAdmin(token, base) {
    const permissions = await platform(token, '/v1000/rbac/permission/my', undefined, base);
    if (permissions.is_super_admin !== true) throw denied();
  }

  async function inventory(token, base) {
    const listing = await platform(token, '/v1000/app/list', undefined, base);
    if (!Array.isArray(listing.data) || listing.total !== listing.data.length ||
        listing.data.some(a => !APP_ID.test(a?.app_id ?? '') || typeof a.installed_app_id !== 'string' ||
          typeof a.version !== 'string' || typeof a.state !== 'string')) {
      throw new OpsError(502, 'vos-request-failed');
    }
    return listing.data.map(a => ({
      appId: a.app_id, installationId: a.installed_app_id, version: a.version,
      state: a.state, lastError: bounded(a.last_error),
      restartable: a.state === 'installed' && a.app_id !== SELF_APP_ID,
    }));
  }

  /**
   * One-call diagnosis for a visible container: Docker-inspect facts that
   * never appear in application logs (exit code, OOM, restart count, health
   * checks) plus a collapsed error-line summary. No raw log body is returned.
   */
  async function diagnose(id) {
    if (!CONTAINER_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
    const container = (await daemon('/containers/json?all=1')).find(c => c.Id === id);
    if (!container || !visible(container)) throw new OpsError(404, 'not-found');
    let inspect;
    try {
      inspect = JSON.parse(await daemonCall('GET', `/containers/${id}/json`));
    } catch (error) {
      if (error instanceof OpsError && error.status === 404) throw stale();
      throw error;
    }
    const state = inspect.State ?? {};
    const health = state.Health ?? null;
    const records = logRecords(await daemonCall('GET',
      `/containers/${id}/logs?${LOG_QUERY}${DIAGNOSE_TAIL}`, LOG_BYTES));
    const stamped = records.filter(record => record.ts !== null);
    return {
      id, name: bounded(container.Names?.[0]?.replace(/^\//, ''), 200),
      image: bounded(container.Image, 300), stack: mainStack(container),
      state: {
        status: bounded(state.Status, 40), running: state.Running === true,
        restarting: state.Restarting === true, oomKilled: state.OOMKilled === true,
        exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
        error: bounded(state.Error, 500), startedAt: state.StartedAt ?? null,
        finishedAt: state.FinishedAt ?? null,
        restartCount: typeof inspect.RestartCount === 'number' ? inspect.RestartCount : 0,
        health: health ? {
          status: bounded(health.Status, 40),
          failingStreak: typeof health.FailingStreak === 'number' ? health.FailingStreak : 0,
          recent: (health.Log ?? []).slice(-3).map(entry => ({
            start: entry.Start ?? null, end: entry.End ?? null,
            exitCode: typeof entry.ExitCode === 'number' ? entry.ExitCode : null,
            output: bounded(entry.Output, DIAGNOSE_HEALTH_OUTPUT).trim(),
          })),
        } : null,
      },
      logs: {
        scanned: records.length, first: stamped[0]?.ts ?? null, last: stamped.at(-1)?.ts ?? null,
        errors: errorGroups(records),
      },
    };
  }

  async function target(action, id, token, base) {
    if (action === 'restart' && APP_ID.test(id) && !CONTAINER_ID.test(id)) {
      const app = (await inventory(token, base)).find(a => a.appId === id);
      if (!app || app.state !== 'installed' || id === SELF_APP_ID) throw stale();
      return { appId: app.appId, installationId: app.installationId, version: app.version, state: app.state };
    }
    if (['stop-container', 'remove-container'].includes(action) && CONTAINER_ID.test(id)) {
      const [apps, containers] = await Promise.all([inventory(token, base), daemon('/containers/json?all=1')]);
      const container = containers.find(c => c.Id === id);
      const item = container && summarizeContainer(container, apps);
      if (!item || (action === 'stop-container' ? !item.stoppable : !item.cleanup)) throw stale();
      const app = apps.find(a => a.appId === item.stack.appId);
      return {
        id, name: item.name, image: item.image, imageId: item.imageId,
        state: item.state, stack: item.stack, ports: item.ports,
        installedVersion: app.version, installationId: app.installationId,
      };
    }
    if (action === 'remove-image' && IMAGE_ID.test(id)) {
      const [containers, images] = await Promise.all([daemon('/containers/json?all=1'), daemon('/images/json?all=1')]);
      const item = candidates(images, containers).find(i => i.id === id);
      if (!item) throw stale();
      return item;
    }
    throw new OpsError(400, 'invalid-target');
  }

  async function execute(pending, token, base, stillAllowed, namespace) {
    const { action, id, item } = pending;
    const current = await target(action, id, token, base);
    if (JSON.stringify(current) !== JSON.stringify(item)) throw stale();
    await requireAdmin(token, base);
    if (!stillAllowed()) throw stale();
    audit('VOS ops attempt', JSON.stringify({ namespace, action, id }));
    let taskId = null;
    if (action === 'restart') {
      const task = await platform(token, '/v1000/app/restart_async', { app_id: id }, base);
      taskId = task.task_id;
    } else if (action === 'stop-container') {
      await daemonCall('POST', `/containers/${id}/stop?t=30`);
    } else if (action === 'remove-container') {
      await daemonCall('DELETE', `/containers/${id}?force=0&v=0`);
    } else {
      await daemonCall('DELETE', `/images/${id}?force=0&noprune=1`);
    }
    audit('VOS ops accepted', JSON.stringify({ namespace, action, id, taskId }));
    return { action, id, taskId };
  }

  async function handle(req, res, url) {
    const suffix = url.pathname.slice(OPS_PATH.length);
    const agent = suffix.startsWith('/agent/');
    const path = agent ? suffix.slice('/agent'.length) : suffix;
    try {
      const session = agent ? null : sessionFor(req);
      const namespace = agent
        ? tenants.get(req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1])
        : session?.namespace;
      if (!namespace) throw new OpsError(401, 'sign-in-required');
      if (agent) {
        if (req.method !== 'GET' || !READ_PATHS.has(path)) throw denied();
      } else if (req.headers['x-va-ops'] !== '1' ||
                 (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        throw denied();
      }
      const token = await tokenFor(namespace);
      if (!token) throw new OpsError(401, 'sign-in-required');
      const base = userinfoUrl();
      await requireAdmin(token, base);
      if (agent) {
        if (![...grants.values()].some(grant =>
          grant.namespace === namespace && grant.expert && grant.expires > now())) throw denied();
      } else if (path === '/authorize' && req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        if (!body || typeof body.expert !== 'boolean') throw new OpsError(400, 'invalid-body');
        for (const [key, entry] of grants) if (entry.expires <= now()) grants.delete(key);
        closeSession(session.sessionId);
        if (grants.size >= 128) throw new OpsError(429, 'too-many-grants');
        const key = randomBytes(32).toString('hex');
        grants.set(key, {
          sessionId: session.sessionId, namespace, expert: body.expert,
          expires: Math.min(now() + GRANT_TTL_MS, session.expiresAt),
        });
        respond(res, 200, { grant: key, expiresIn: Math.floor((grants.get(key).expires - now()) / 1000) });
        return;
      } else {
        const key = req.headers['x-va-ops-grant'];
        const grant = grants.get(key);
        const stillAllowed = () => grant && grants.get(key) === grant
          && grant.sessionId === session.sessionId && grant.expires > now();
        if (!stillAllowed()) throw denied();
        if (path === '/close' && req.method === 'POST') {
          grants.delete(key);
          respond(res, 200, { closed: true });
          return;
        }
        if (path === '/preview' && req.method === 'POST') {
          const body = await readBody(req).catch(() => null);
          if (!body || !ACTIONS.has(body.action) || typeof body.id !== 'string') {
            throw new OpsError(400, 'invalid-target');
          }
          const { action, id } = body;
          const item = await target(action, id, token, base);
          if (!stillAllowed()) throw stale();
          const confirmation = randomBytes(32).toString('hex');
          grant.pending = { action, id, item, confirmation, expires: now() + CONFIRM_TTL_MS };
          respond(res, 200, { action, targetId: id, target: item, confirmation, expiresIn: 60 });
          return;
        }
        if (path === '/execute' && req.method === 'POST') {
          const body = await readBody(req).catch(() => null);
          if (!body || typeof body.confirmation !== 'string' || typeof body.targetId !== 'string') {
            throw new OpsError(400, 'invalid-body');
          }
          const pending = grant.pending;
          if (!pending || pending.confirmation !== body.confirmation || pending.expires <= now()) throw stale();
          if (body.targetId !== pending.id) throw new OpsError(400, 'confirmation-mismatch');
          delete grant.pending;
          const result = await execute(pending, token, base, stillAllowed, namespace);
          respond(res, 200, result);
          return;
        }
      }
      if (path === '/inventory' && req.method === 'GET') {
        const [apps, containers, images] = await Promise.all([
          inventory(token, base), daemon('/containers/json?all=1'), daemon('/images/json?all=1'),
        ]);
        const rows = containers.map(c => summarizeContainer(c, apps));
        respond(res, 200, {
          apps, containers: rows.filter(c => c.stack && c.stack.appId !== SELF_APP_ID && CONTAINER_ID.test(c.id)),
          publishedPorts: rows.flatMap(c => c.ports.map(p => ({ ...p, container: c.name, appId: c.stack?.appId ?? null }))),
          unusedImages: candidates(images, containers),
          unreferencedTaggedImages: taggedImages(images, containers),

        });
        return;
      }
      if (path === '/status' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (CONTAINER_ID.test(id ?? '') || IMAGE_ID.test(id ?? '')) throw new OpsError(400, 'app-id-required');
        if (!APP_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
        const app = await platform(token, '/v1000/app/status?' + new URLSearchParams({ app_id: id }), undefined, base);
        const workflow = app.workflow;
        respond(res, 200, {
          appId: app.app_id, version: app.version, state: app.state, lastError: bounded(app.last_error),
          workflow: workflow ? { taskId: workflow.task_id, status: workflow.status,
            stage: workflow.current_stage ?? null, failure: bounded(workflow.failure?.message) } : null,
        });
        return;
      }
      if (path === '/logs' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!CONTAINER_ID.test(id ?? '')) throw new OpsError(400, 'invalid-target');
        const filter = logFilter(url, now());
        const [containers, apps] = await Promise.all([daemon('/containers/json?all=1'), inventory(token, base)]);
        const c = containers.find(c => c.Id === id);
        const stack = c && mainStack(c);
        if (!stack || !visible(c) || !apps.some(a => a.appId === stack.appId)) throw new OpsError(404, 'not-found');
        const result = filterRecords(logRecords(
          await daemonCall('GET', `/containers/${id}/logs?${filter.query}`, LOG_BYTES)), filter);
        respond(res, 200, logsPayload(id, result, filter));
        return;
      }
      if (path === '/app-logs' && req.method === 'GET') {
        const appId = url.searchParams.get('appId');
        if (!APP_ID.test(appId ?? '')) throw new OpsError(400, 'invalid-target');
        const filter = logFilter(url, now());
        const [containers, apps] = await Promise.all([daemon('/containers/json?all=1'), inventory(token, base)]);
        if (!apps.some(a => a.appId === appId)) throw new OpsError(404, 'not-found');
        const members = containers
          .filter(c => CONTAINER_ID.test(c.Id) && visible(c) && mainStack(c)?.appId === appId)
          .map(c => ({ id: c.Id, name: bounded(c.Names?.[0]?.replace(/^\//, ''), 200) }));
        if (members.length === 0) throw new OpsError(404, 'not-found');
        const sources = await Promise.all(members.map(async member => ({
          name: member.name,
          records: logRecords(await daemonCall('GET', `/containers/${member.id}/logs?${filter.query}`, LOG_BYTES)),
        })));
        respond(res, 200, appLogsPayload(appId, sources, filter));
        return;
      }
      if (path === '/diagnose' && req.method === 'GET') {
        respond(res, 200, await diagnose(url.searchParams.get('id')));
        return;
      }
      respond(res, 404, { error: 'not-found' });
    } catch (error) {
      const status = error instanceof OpsError ? error.status : 502;
      respond(res, status, { error: error instanceof OpsError ? error.message : 'upstream-unavailable' });
    }
  }

  return { handle, closeSession };
}
