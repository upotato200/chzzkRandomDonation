import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Room, AppError, weightedPick } from './room.js';
import { ChzzkApi, ChatConnection } from './chzzk.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const opaque = () => randomBytes(32).toString('base64url');
const samples = ['초록별', '달빛고래', '오후의커피', '구름조각', '민트초코', '별사탕', '졸린고양이', '오늘도출석'];
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(config, dependencies = {}) {
  const origin = new URL(config.origin).origin;
  const secure = origin.startsWith('https:');
  const configured = Boolean(config.clientId && config.clientSecret && config.redirectUri);
  const api = dependencies.api || new ChzzkApi(config);
  const makeConnection = dependencies.makeConnection || ((account, room) => new ChatConnection(api, account, room));
  const sessions = new Map();
  const channels = new Map();
  const streams = new Set();
  const demoStreams = new Set();
  const sessionStarts = new Map();
  const limits = {
    sessionStartWindowMs: config.sessionStartWindowMs ?? 10 * 60 * 1000,
    maxSessionStartsPerClient: config.maxSessionStartsPerClient ?? 8,
    maxTrackedClients: config.maxTrackedClients ?? 2000,
    preAuthSessionTtlMs: config.preAuthSessionTtlMs ?? 10 * 60 * 1000,
    sessionTtlMs: config.sessionTtlMs ?? 12 * 60 * 60 * 1000,
    maxStreams: config.maxStreams ?? 250,
    maxDemoStreams: config.maxDemoStreams ?? 25,
  };
  const trustedProxy = config.trustedProxy ?? Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const cookie = (res, id, age = 43200) => res.setHeader('Set-Cookie',
    `studio_sid=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
  const clientAddress = (req) => {
    // Railway provides X-Real-IP as the client address; never trust client-supplied X-Forwarded-For.
    const realIp = trustedProxy && req.headers['x-real-ip'];
    const value = typeof realIp === 'string' ? realIp.trim() : req.socket.remoteAddress;
    return value?.slice(0, 64) || 'unknown';
  };

  function allowNewSession(req) {
    const now = Date.now();
    const key = clientAddress(req);
    const starts = (sessionStarts.get(key) || []).filter((time) => time > now - limits.sessionStartWindowMs);
    if (starts.length >= limits.maxSessionStartsPerClient) throw new AppError('새 연결 요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
    if (!sessionStarts.has(key) && sessionStarts.size >= limits.maxTrackedClients) {
      throw new AppError('새 연결 요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
    }
    starts.push(now);
    sessionStarts.set(key, starts);
  }
  const redirect = (res, location) => { res.writeHead(302, { Location: location }); res.end(); };

  function closeSession(session) {
    for (const stream of session.streams) stream.end();
    session.streams.clear();
    session.demoRoom?.close();
    const room = channels.get(session.channelId)?.room;
    if (room?.audioOwner === session.audioId) { room.audioOwner = null; room.changed(); }
  }

  function cleanupChannels() {
    for (const [id, channel] of channels) {
      if (![...sessions.values()].some((s) => s.channelId === id)) {
        channel.connection.stop();
        channel.room.close();
        channels.delete(id);
      }
    }
  }

  const housekeeping = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) { closeSession(session); sessions.delete(id); }
    }
    for (const [key, starts] of sessionStarts) {
      const active = starts.filter((time) => time > now - limits.sessionStartWindowMs);
      if (active.length) sessionStarts.set(key, active);
      else sessionStarts.delete(key);
    }
    cleanupChannels();
  }, 60000);
  housekeeping.unref();

  function getSession(req, res, create = false) {
    const id = /(?:^|;\s*)studio_sid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let session = id && sessions.get(id);
    if (session && session.expiresAt <= Date.now()) {
      closeSession(session);
      sessions.delete(id);
      session = null;
    }
    if (!session && create) {
      allowNewSession(req);
      if (sessions.size >= 1000) throw new AppError('잠시 후 다시 접속해 주세요.', 503);
      session = { id: opaque(), csrf: opaque(), audioId: randomUUID(), expiresAt: Date.now() + limits.preAuthSessionTtlMs,
        streams: new Set(), calls: [], oauth: null };
      sessions.set(session.id, session);
      cookie(res, session.id);
    }
    if (!session) throw new AppError('페이지를 새로고침한 뒤 다시 연결해 주세요.', 401, 'LOGIN_REQUIRED');
    return session;
  }

  function roomFor(session) {
    const room = session.demoRoom || channels.get(session.channelId)?.room;
    if (!room) throw new AppError('치지직을 연결하거나 체험 모드를 시작해 주세요.', 401, 'LOGIN_REQUIRED');
    return room;
  }

  async function readBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON 형식이 필요해요.', 415);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32768) throw new AppError('요청이 너무 커요.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { throw new AppError('입력 형식을 확인해 주세요.'); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      if (req.headers['sec-fetch-site'] === 'cross-site' && path.startsWith('/api/')) throw new AppError('다른 사이트에서 요청할 수 없어요.', 403);
      if (req.method === 'GET' && path === '/api/bootstrap') {
        const session = getSession(req, res, true);
        return json(res, 200, { csrf: session.csrf, audioId: session.audioId, configured,
          redirectUri: config.redirectUri, authenticated: Boolean(session.channelId),
          state: session.demoRoom || session.channelId ? roomFor(session).snapshot() : null });
      }
      if (req.method === 'GET' && path === '/auth/chzzk') {
        const session = getSession(req, res, true);
        if (!configured) return redirect(res, '/?auth=setup');
        session.oauth = { state: opaque(), expiresAt: Date.now() + 600000 };
        const target = new URL('https://chzzk.naver.com/account-interlock');
        target.search = new URLSearchParams({ clientId: config.clientId, redirectUri: config.redirectUri, state: session.oauth.state });
        return redirect(res, target.href);
      }
      if (req.method === 'GET' && path === '/auth/chzzk/callback') {
        const session = getSession(req, res);
        const pending = session.oauth;
        session.oauth = null;
        if (!pending || pending.expiresAt < Date.now() || !safeEqual(url.searchParams.get('state'), pending.state)) {
          return redirect(res, '/?auth=invalid_state');
        }
        const code = url.searchParams.get('code');
        if (!code || code.length > 2048) return redirect(res, '/?auth=cancelled');
        try {
          const account = await api.exchange(code, pending.state);
          const me = await api.authorized(account, '/open/v1/users/me');
          if (typeof me.channelId !== 'string' || !me.channelId || typeof me.channelName !== 'string') throw new Error('Invalid identity');
          // Channel identity always comes from CHZZK, never a submitted browser channel ID.
          let channel = channels.get(me.channelId);
          if (!channel) {
            if (channels.size >= 100) throw new Error('Channel capacity');
            const room = new Room(me.channelId, me.channelName);
            channel = { room, account, connection: makeConnection(account, room) };
            channels.set(me.channelId, channel);
          } else {
            channel.connection.stop();
            Object.assign(channel.account, account);
          }
          closeSession(session);
          sessions.delete(session.id);
          session.id = opaque();
          session.csrf = opaque();
          session.demoRoom = null;
          session.channelId = me.channelId;
          session.expiresAt = Date.now() + limits.sessionTtlMs;
          sessions.set(session.id, session);
          cookie(res, session.id);
          void channel.connection.start();
          return redirect(res, '/');
        } catch { return redirect(res, '/?auth=failed'); }
      }
      if (req.method === 'GET' && path === '/api/events') {
        const session = getSession(req, res);
        const room = roomFor(session);
        if (session.streams.size >= 5) throw new AppError('열려 있는 진행자 탭을 닫아 주세요.', 429);
        if (streams.size >= limits.maxStreams || (room.demo && demoStreams.size >= limits.maxDemoStreams)) {
          throw new AppError('열려 있는 연결이 많아요. 잠시 후 다시 시도해 주세요.', 429);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        session.streams.add(res);
        streams.add(res);
        if (room.demo) demoStreams.add(res);
        const send = (type, data) => {
          if (res.writableLength > 1024 * 1024) return res.end();
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let scheduled;
        const state = () => { if (!scheduled) scheduled = setTimeout(() => { scheduled = null; send('state', room.snapshot()); }, 80); };
        const tts = (data) => send('tts', data);
        const ping = setInterval(() => {
          if (session.expiresAt <= Date.now()) res.end();
          else send('heartbeat', { serverTime: Date.now() });
        }, 10000);
        room.on('change', state);
        room.on('tts', tts);
        send('state', room.snapshot());
        res.on('close', () => {
          clearTimeout(scheduled);
          clearInterval(ping);
          room.off('change', state);
          room.off('tts', tts);
          session.streams.delete(res);
          streams.delete(res);
          demoStreams.delete(res);
        });
        return;
      }
      if (req.method === 'POST' && path.startsWith('/api/')) {
        const session = getSession(req, res);
        if (req.headers.origin !== origin || !safeEqual(req.headers['x-csrf-token'], session.csrf)) {
          throw new AppError('페이지를 새로고침한 뒤 다시 시도해 주세요.', 403, 'CSRF');
        }
        session.calls = session.calls.filter((time) => time > Date.now() - 10000);
        if (session.calls.length >= 60) throw new AppError('잠시 후 다시 시도해 주세요.', 429);
        session.calls.push(Date.now());
        const body = await readBody(req);
        if (path === '/api/demo/start') {
          if (session.channelId) throw new AppError('실제 채널 연결을 해제한 뒤 체험해 주세요.', 409);
          if (!session.demoRoom) {
            session.demoRoom = new Room(`demo:${session.id}`, '체험 스튜디오', true);
            samples.forEach((nickname, i) => session.demoRoom.participants.set(`sample-${i}`, { id: `sample-${i}`, nickname }));
          }
          return json(res, 200, { state: session.demoRoom.snapshot() });
        }
        if (path === '/api/logout') {
          const channelId = session.channelId;
          for (const [id, item] of sessions) {
            if (item === session || (channelId && item.channelId === channelId)) { closeSession(item); sessions.delete(id); }
          }
          cleanupChannels();
          cookie(res, '', 0);
          return json(res, 200, { ok: true });
        }
        const room = roomFor(session);
        switch (path) {
          case '/api/reconnect': {
            const channel = channels.get(session.channelId);
            if (!channel) throw new AppError('실제 치지직 연결에서 사용할 수 있어요.');
            if (['connecting', 'reconnecting'].includes(room.connection)) throw new AppError('이미 연결 중이에요.', 409);
            void channel.connection.start();
            break;
          }
          case '/api/participants/collect':
            room.requireChat();
            if (typeof body.active !== 'boolean') throw new AppError('모집 상태를 확인해 주세요.');
            room.collecting = body.active;
            break;
          case '/api/participants/reset':
            room.stopSpeaker();
            room.collecting = false;
            room.participants.clear();
            room.previousWinners.clear();
            break;
          case '/api/participants/exclude':
            if (typeof body.active !== 'boolean') throw new AppError('제외 설정을 확인해 주세요.');
            room.excludeWinners = body.active;
            break;
          case '/api/viewer/draw': room.drawViewer(); break;
          case '/api/viewer/stop': room.stopSpeaker(); break;
          case '/api/audio/claim': room.audioOwner = session.audioId; break;
          case '/api/audio/release':
            if (room.audioOwner === session.audioId) room.audioOwner = null;
            break;
          case '/api/poll/start': room.startPoll(body.question, body.options); break;
          case '/api/poll/stop':
            if (!room.poll) throw new AppError('진행 중인 투표가 없어요.');
            room.poll.active = false;
            break;
          case '/api/roulette/draw':
            room.roulette = weightedPick(body.items);
            break;
          case '/api/demo/chat': {
            if (!room.demo) throw new AppError('체험 채팅은 실제 채널에 보낼 수 없어요.', 403);
            if (typeof body.nickname !== 'string' || !body.nickname.trim() || body.nickname.length > 40 ||
                typeof body.text !== 'string' || !body.text.trim() || body.text.length > 150) throw new AppError('닉네임과 150자 이내의 채팅을 입력해 주세요.');
            const nickname = body.nickname.trim();
            const id = [...room.participants.values()].find((p) => p.nickname === nickname)?.id || `manual:${nickname}`;
            room.ingest({ channelId: room.channelId, senderChannelId: id, profile: { nickname }, content: body.text, messageTime: Date.now() });
            break;
          }
          default: throw new AppError('요청을 찾을 수 없어요.', 404);
        }
        room.changed();
        return json(res, 200, { state: room.snapshot() });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && assets[path]) {
        const [file, mime] = assets[path];
        const content = await readFile(root + 'public/' + file);
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(content);
      }
      throw new AppError('페이지를 찾을 수 없어요.', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error instanceof AppError ? error.status : 500,
        { error: error instanceof AppError ? error.message : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
    }
  });
  return {
    server,
    close() {
      clearInterval(housekeeping);
      for (const session of sessions.values()) closeSession(session);
      for (const channel of channels.values()) { channel.connection.stop(); channel.room.close(); }
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (existsSync(root + '.env')) process.loadEnvFile(root + '.env');
  const port = Number(process.env.PORT || 3000);
  const config = { origin: process.env.APP_ORIGIN || `http://localhost:${port}`,
    clientId: process.env.CHZZK_CLIENT_ID, clientSecret: process.env.CHZZK_CLIENT_SECRET,
    redirectUri: process.env.CHZZK_REDIRECT_URI || `http://localhost:${port}/auth/chzzk/callback` };
  if (new URL(config.redirectUri).origin !== new URL(config.origin).origin) throw new Error('APP_ORIGIN and CHZZK_REDIRECT_URI must share an origin');
  const app = createApp(config);
  app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`너의 차례: ${config.origin}`));
  process.on('SIGTERM', () => void app.close());
  process.on('SIGINT', () => void app.close());
}
