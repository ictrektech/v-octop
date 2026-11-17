import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVosOps, OPS_PATH, vosOpsEnvironment } from './vos-ops.mjs';

const appId = 'com.ictrek.demo';
const selfId = 'com.ictrek.v-octop';
const containerId = 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const project = 'vos-app-com-ictrek-demo-' + '0'.repeat(26);
const container = {
  Id: containerId, Names: [`/${project}-service-1`], Image: 'demo:1', ImageID: 'older-digest',
  State: 'running', Status: 'Up', Ports: [],
  Labels: {
    'io.vos.platform.managed': 'true',
    'io.vos.platform.kind': 'app',
    'com.docker.compose.project': project,
    'com.docker.compose.service': 'service',
    'com.docker.compose.container-number': '1',
    'com.docker.compose.project.config_files': `/apps/${appId}/1/rendered/docker-compose.yml`,
  },
};

function fixture() {
  let timestamp = 1000;
  let admin = true;
  let version = '2';
  const operations = [];
  const sessions = ['session-a', 'session-b'].map((sessionId) => ({
    sessionId, namespace: 'admin', expiresAt: 1000000,
  }));
  const route = createVosOps({
    sessionFor: req => req.session,
    tokenFor: async namespace => namespace,
    userinfoUrl: () => 'http://fixture.test',
    readBody: async req => req.body,
    now: () => timestamp,
    respond: (res, status, body) => Object.assign(res, { status, body }),
    audit: () => {},
    async daemon(path) {
      if (path === '/containers/json?all=1') return [container];
      if (path === '/images/json?all=1') {
        return [
          { Id: imageId, Created: 1, Size: 512 },
          { Id: 'sha256:' + 'c'.repeat(64), RepoTags: ['demo:latest'], Size: 512 },
        ];
      }
      throw new Error('unexpected Docker read');
    },
    async daemonCall(method, path) {
      if (method === 'GET' && path === `/containers/${containerId}/json`) {
        return Buffer.from(JSON.stringify({ State: { OOMKilled: true, ExitCode: 137 } }));
      }
      if (method === 'GET' && path.startsWith(`/containers/${containerId}/logs?`)) {
        return Buffer.from('2026-11-17T03:00:00Z ERROR: demo\n');
      }
      operations.push({ method, path });
      return Buffer.alloc(0);
    },
    async platform(token, path, body) {
      if (path.endsWith('/permission/my')) return { is_super_admin: token === 'admin' && admin };
      if (path === '/v1000/app/list') {
        return { total: 2, data: [
          { app_id: appId, installed_app_id: 'fixture', state: 'installed', version },
          { app_id: selfId, installed_app_id: 'self', state: 'installed', version },
        ] };
      }
      if (path === '/v1000/app/restart_async') {
        operations.push({ path, body });
        return { task_id: 'restart-task' };
      }
      throw new Error('unexpected VOS API');
    },
  });
  async function request(path, { session = sessions[0], grant, body, headers, method } = {}) {
    const res = {};
    await route.handle({
      session, body, method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'x-va-ops': '1', ...(grant && { 'x-va-ops-grant': grant }), ...headers },
    }, res, new URL(OPS_PATH + path, 'http://fixture.test'));
    return res;
  }
  const authorize = async options => (await request('/authorize', { body: { expert: false }, ...options })).body.grant;
  return {
    request, authorize, sessions, operations, closeSession: route.closeSession,
    setAdmin: value => { admin = value; },
    setVersion: value => { version = value; },
    advance: ms => { timestamp += ms; },
  };
}

test('only the current VOS super administrator can create and use a browser grant', async () => {
  const f = fixture();
  assert.equal((await f.request('/authorize', { session: null, body: { expert: false } })).status, 401);
  assert.equal((await f.request('/authorize', {
    session: { ...f.sessions[0], namespace: 'regular' }, body: { expert: true },
  })).status, 403);
  assert.equal((await f.request('/authorize', {
    headers: { 'sec-fetch-site': 'cross-site' }, body: { expert: false },
  })).status, 403);
  assert.equal((await f.request('/inventory')).status, 403);
  const grant = await f.authorize();
  assert.ok(grant);
  assert.equal((await f.request('/inventory', { grant, session: f.sessions[1] })).status, 403);
  const inventory = await f.request('/inventory', { grant });
  assert.equal(inventory.body.containers[0].stoppable, true);
  assert.equal(inventory.body.apps.find(row => row.appId === selfId).restartable, false);
  const diagnosis = await f.request('/diagnose?id=' + containerId, { grant });
  assert.equal(diagnosis.body.state.oomKilled, true);
  assert.equal(diagnosis.body.logs.errors[0].count, 1);
  const logs = await f.request('/logs?id=' + containerId + '&pattern=.%2B', { grant });
  assert.equal(logs.body.returned, 0, 'log filtering treats input as literal text');
  f.advance(900001);
  assert.equal((await f.request('/inventory', { grant })).status, 403);
});

test('expert access is opt-in, namespace scoped, revocable and read-only', async () => {
  const f = fixture();
  const headers = { authorization: 'Bearer ' + vosOpsEnvironment('admin').VA_VOS_OPS_KEY };
  const other = { authorization: 'Bearer ' + vosOpsEnvironment('other').VA_VOS_OPS_KEY };
  await f.authorize();
  assert.equal((await f.request('/agent/inventory', { headers })).status, 403);
  await f.authorize({ body: { expert: true } });
  assert.equal((await f.request('/agent/inventory', { headers: other })).status, 403);
  assert.equal((await f.request('/agent/inventory', { headers })).status, 200);
  assert.equal((await f.request('/agent/preview', {
    headers, body: { action: 'restart', id: appId },
  })).status, 403);
  f.closeSession(f.sessions[0].sessionId);
  assert.equal((await f.request('/agent/inventory', { headers })).status, 403);
  assert.deepEqual(f.operations, []);
});

test('confirmed mutations recheck permissions and target, expire, and are single-use', async () => {
  const f = fixture();
  const grant = await f.authorize();
  async function preview(action, id) {
    return f.request('/preview', { grant, body: { action, id } });
  }
  async function execute(confirmation, id) {
    return f.request('/execute', { grant, body: { confirmation, targetId: id } });
  }
  assert.equal((await preview('restart', selfId)).status, 409);
  assert.equal((await preview('remove-image', 'sha256:' + 'c'.repeat(64))).status, 409);
  let res = await preview('restart', appId);
  assert.equal(res.status, 200);
  assert.equal((await execute(res.body.confirmation, 'com.ictrek.wrong')).status, 400);
  f.setVersion('3');
  assert.equal((await execute(res.body.confirmation, appId)).status, 409);
  res = await preview('restart', appId);
  f.setAdmin(false);
  assert.equal((await execute(res.body.confirmation, appId)).status, 403);
  f.setAdmin(true);
  res = await preview('restart', appId);
  f.advance(60001);
  assert.equal((await execute(res.body.confirmation, appId)).status, 409);
  assert.deepEqual(f.operations, []);

  res = await preview('restart', appId);
  const success = await execute(res.body.confirmation, appId);
  assert.equal(success.body.taskId, 'restart-task');
  assert.equal((await execute(res.body.confirmation, appId)).status, 409);
  res = await preview('stop-container', containerId);
  assert.equal((await execute(res.body.confirmation, containerId)).status, 200);
  res = await preview('remove-image', imageId);
  assert.equal((await execute(res.body.confirmation, imageId)).status, 200);
  assert.deepEqual(f.operations, [
    { path: '/v1000/app/restart_async', body: { app_id: appId } },
    { method: 'POST', path: `/containers/${containerId}/stop?t=30` },
    { method: 'DELETE', path: `/images/${imageId}?force=0&noprune=1` },
  ]);
});
