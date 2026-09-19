import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

async function fixture(t, configured = false, options = {}) {
  const config = { origin: 'http://localhost:3000', redirectUri: 'http://localhost:3000/auth/chzzk/callback',
    ...(configured ? { clientId: 'test-id', clientSecret: 'test-secret' } : {}), ...options };
  const app = createApp(config, {
    api: { exchange: async (code) => ({ code }), authorized: async (account) => ({ channelId: account.code, channelName: '채널 ' + account.code }) },
    makeConnection: (_, room) => ({ start: () => room.setConnection('connected', '연결됨'), stop: () => {} }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function client() {
    const bootstrap = await fetch(origin + '/api/bootstrap');
    let cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    let data = await bootstrap.json();
    return {
      get data() { return data; },
      async get(path, headers = {}) { return fetch(origin + path, { headers: { cookie, ...headers }, redirect: 'manual' }); },
      async post(path, body = {}, extra = {}) { return fetch(origin + path, { method: 'POST',
        headers: { cookie, origin: config.origin, 'x-csrf-token': data.csrf, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }); },
      async login(channel) {
        const start = await this.get('/auth/chzzk');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        const callback = await this.get(`/auth/chzzk/callback?code=${channel}&state=${state}`);
        assert.equal(callback.status, 302);
        cookie = callback.headers.get('set-cookie').split(';')[0];
        data = await (await this.get('/api/bootstrap')).json();
      },
    };
  }
  return { origin, client };
}

test('설정 누락을 명시하고 인증 없이 실제 채널 API와 이벤트에 접근할 수 없다', async (t) => {
  const { origin, client } = await fixture(t);
  const user = await client();
  assert.equal(user.data.configured, false);
  assert.equal(user.data.state, null);
  assert.equal((await fetch(origin + '/api/events')).status, 401);
  assert.equal((await user.post('/api/viewer/draw')).status, 401);
  assert.equal((await user.get('/auth/chzzk')).headers.get('location'), '/?auth=setup');
  const source = await (await user.get('/')).text();
  assert.ok(!source.includes('test-secret'));
});

test('체험 세션 분리 및 CSRF 차단', async (t) => {
  const { client } = await fixture(t);
  const a = await client(), b = await client();
  assert.equal((await a.post('/api/demo/start', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.post('/api/demo/start', {}, { 'x-csrf-token': 'wrong' })).status, 403);
  await a.post('/api/demo/start');
  await b.post('/api/demo/start');
  const result = await (await a.post('/api/viewer/draw')).json();
  assert.ok(result.state.speaker);
  assert.equal((await (await b.get('/api/bootstrap')).json()).state.speaker, null);
  assert.equal((await a.post('/api/viewer/draw')).status, 409);
  assert.equal((await a.post('/api/unknown')).status, 404);
});

test('OAuth state 검증 및 채널 격리, 실제 채널의 위조 체험 채팅 차단', async (t) => {
  const { client } = await fixture(t, true);
  const a = await client(), b = await client();
  assert.equal((await a.get('/auth/chzzk/callback?code=A&state=wrong')).headers.get('location'), '/?auth=invalid_state');
  await a.login('A');
  await b.login('B');
  assert.equal(a.data.authenticated, true);
  await a.post('/api/poll/start', { channelId: 'B', question: 'A의 투표', options: ['하나', '둘'] });
  const stateA = (await (await a.get('/api/bootstrap')).json()).state;
  const stateB = (await (await b.get('/api/bootstrap')).json()).state;
  assert.equal(stateA.poll.question, 'A의 투표');
  assert.equal(stateB.poll, null);
  assert.equal((await a.post('/api/demo/chat', { nickname: '가짜', text: '!참여' })).status, 403);
  await a.post('/api/logout');
  assert.equal((await a.get('/api/events')).status, 401);
  assert.equal((await b.get('/api/bootstrap')).status, 200);
});


test('새 익명 세션은 공통 제한을 넘길 수 없고 기존 세션은 계속 쓸 수 있다', async (t) => {
  const { origin } = await fixture(t, false, { maxSessionStartsPerClient: 2, maxStreams: 2, maxDemoStreams: 1 });
  const first = await fetch(origin + '/api/bootstrap');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.equal(first.status, 200);
  assert.equal((await fetch(origin + '/api/bootstrap', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(origin + '/api/bootstrap')).status, 200);
  assert.equal((await fetch(origin + '/api/bootstrap')).status, 429);
  assert.equal((await fetch(origin + '/auth/chzzk', { redirect: 'manual' })).status, 429);
});

test('신뢰 프록시에서는 X-Forwarded-For를 세션 제한 키로 쓰지 않는다', async (t) => {
  const { origin } = await fixture(t, false, { trustedProxy: true, maxSessionStartsPerClient: 1 });
  const headers = { 'x-real-ip': '198.51.100.10', 'x-forwarded-for': '198.51.100.1' };
  assert.equal((await fetch(origin + '/api/bootstrap', { headers })).status, 200);
  assert.equal((await fetch(origin + '/api/bootstrap', { headers: { ...headers, 'x-forwarded-for': '198.51.100.2' } })).status, 429);
});


test('데모 SSE 전역 상한은 다른 세션을 막고 연결 종료 뒤에는 회복된다', async (t) => {
  const { client } = await fixture(t, false, { maxDemoStreams: 1 });
  const a = await client(), b = await client();
  await a.post('/api/demo/start');
  await b.post('/api/demo/start');
  const stream = await a.get('/api/events');
  assert.equal(stream.status, 200);
  assert.equal((await b.get('/api/events')).status, 429);
  await stream.body.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const recovered = await b.get('/api/events');
  assert.equal(recovered.status, 200);
  await recovered.body.cancel();
});
