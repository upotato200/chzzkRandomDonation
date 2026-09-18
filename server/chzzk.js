import io from 'socket.io-client';
import { AppError } from './room.js';

const API = 'https://openapi.chzzk.naver.com';
export class ChzzkApi {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(path, { token, body, method = 'GET' } = {}) {
    let response;
    try {
      response = await this.fetch(API + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AppError('치지직 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.', 503, 'UPSTREAM_TEMPORARY');
    }
    const data = await response.json().catch(() => null);
    const status = response.ok && data?.code && Number(data.code) !== 200 ? Number(data.code) : response.status;
    if (!response.ok || status >= 400) {
      if (status === 401 && data?.message === 'INVALID_TOKEN') throw new AppError('치지직 로그인을 다시 해 주세요.', 401, 'INVALID_TOKEN');
      if (status === 401) throw new AppError('치지직 앱 인증 설정을 확인해 주세요.', 502, 'INVALID_CLIENT');
      if (status === 403) throw new AppError('앱의 유저 정보 조회·채팅 메시지 조회 권한을 확인해 주세요.', 403, 'FORBIDDEN');
      if (status === 429 || status >= 500) throw new AppError('치지직 연결을 잠시 후 다시 시도해 주세요.', 503, 'UPSTREAM_TEMPORARY');
      throw new AppError('치지직 요청에 실패했어요. 앱 설정과 권한을 확인해 주세요.', 502, 'UPSTREAM_REQUEST');
    }
    if (!data || typeof data !== 'object') throw new AppError('치지직 응답을 확인할 수 없어요.', 502, 'UPSTREAM_REQUEST');
    return data.content ?? data;
  }

  async token(fields) {
    const value = await this.request('/auth/v1/token', { method: 'POST', body: {
      clientId: this.config.clientId, clientSecret: this.config.clientSecret, ...fields,
    } });
    if (typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string') {
      throw new AppError('치지직 인증을 완료하지 못했어요.', 502, 'UPSTREAM_REQUEST');
    }
    return { accessToken: value.accessToken, refreshToken: value.refreshToken,
      expiresAt: Date.now() + Math.max(60, Number(value.expiresIn) || 86400) * 1000 };
  }

  exchange(code, state) { return this.token({ grantType: 'authorization_code', code, state }); }
  async authorized(account, path, options = {}) {
    const refresh = async () => {
      if (!account.refreshing) {
        account.refreshing = this.token({ grantType: 'refresh_token', refreshToken: account.refreshToken })
          .then((tokens) => Object.assign(account, tokens)).finally(() => { account.refreshing = null; });
      }
      await account.refreshing;
    };
    if (Date.now() >= account.expiresAt - 60000) await refresh();
    try { return await this.request(path, { ...options, token: account.accessToken }); }
    catch (error) {
      if (error.code !== 'INVALID_TOKEN') throw error;
      await refresh();
      return this.request(path, { ...options, token: account.accessToken });
    }
  }
}

function unpack(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return null; }
}

export class ChatConnection {
  constructor(api, account, room, connect = io) {
    this.api = api;
    this.account = account;
    this.room = room;
    this.connect = connect;
    this.generation = 0;
    this.attempts = 0;
    this.stopped = true;
  }

  stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshakeTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  start() {
    this.stop();
    this.stopped = false;
    this.attempts = 0;
    return this.open();
  }

  fail(error, generation) {
    if (this.stopped || generation !== this.generation) return;
    const retryable = error.code === 'UPSTREAM_TEMPORARY';
    this.stop();
    if (retryable && this.attempts < 5) {
      const delay = Math.min(30000, 1000 * 2 ** this.attempts++);
      this.room.setConnection('reconnecting', '채팅 연결이 끊겨 재연결 중이에요. 발언권은 종료됐어요.');
      this.stopped = false;
      this.retryTimer = setTimeout(() => void this.open(), delay);
      this.retryTimer.unref?.();
    } else this.room.setConnection(error.code === 'INVALID_TOKEN' ? 'reauth' : 'error', error.message);
  }

  async open() {
    const generation = ++this.generation;
    this.room.setConnection('connecting', '치지직 채팅을 연결하고 있어요.');
    try {
      const session = await this.api.authorized(this.account, '/open/v1/sessions/auth');
      if (this.stopped || generation !== this.generation) return;
      const url = new URL(session.url);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.nchat.naver.com') || url.username || url.password) {
        throw new AppError('치지직 채팅 서버 주소를 확인할 수 없어요.', 502, 'UPSTREAM_REQUEST');
      }
      this.socket = this.connect(url.href, { transports: ['websocket'], reconnection: false,
        forceNew: true, timeout: 8000 });
      const transient = () => this.fail(new AppError('채팅 연결이 끊겼어요. 다시 연결해 주세요.', 503, 'UPSTREAM_TEMPORARY'), generation);
      this.handshakeTimer = setTimeout(transient, 15000);
      this.handshakeTimer.unref?.();
      this.socket.on('connect_error', transient);
      this.socket.on('connect_timeout', transient);
      this.socket.on('error', transient);
      this.socket.on('disconnect', transient);
      let subscribing = false;
      this.socket.on('SYSTEM', async (raw) => {
        if (generation !== this.generation || this.stopped) return;
        const event = unpack(raw);
        if (event?.type === 'connected' && typeof event.data?.sessionKey === 'string' && !subscribing) {
          subscribing = true;
          try {
            await this.api.authorized(this.account,
              '/open/v1/sessions/events/subscribe/chat?sessionKey=' + encodeURIComponent(event.data.sessionKey), { method: 'POST' });
          } catch (error) { this.fail(error, generation); }
        }
        if (event?.data?.channelId !== this.room.channelId || event.data?.eventType !== 'CHAT') return;
        if (event.type === 'subscribed') {
          clearTimeout(this.handshakeTimer);
          this.attempts = 0;
          this.room.setConnection('connected', '치지직 채팅을 실시간으로 받고 있어요.');
        } else if (event.type === 'revoked') {
          this.fail(new AppError('치지직 연결 권한이 해제됐어요. 권한 확인 후 다시 로그인해 주세요.', 403, 'FORBIDDEN'), generation);
        } else if (event.type === 'unsubscribed') transient();
      });
      this.socket.on('CHAT', (raw) => {
        if (!this.stopped && generation === this.generation) this.room.ingest(unpack(raw));
      });
    } catch (error) {
      this.fail(error instanceof AppError ? error : new AppError('치지직 연결을 확인해 주세요.', 502, 'UPSTREAM_REQUEST'), generation);
    }
  }
}
