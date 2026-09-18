import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function weightedPick(items, draw = randomInt) {
  if (!Array.isArray(items) || items.length < 2 || items.length > 30) {
    throw new AppError('룰렛 항목을 2~30개 입력해 주세요.');
  }
  const clean = items.map((item) => {
    if (typeof item?.label !== 'string' || !item.label.trim() || item.label.trim().length > 40 ||
        !Number.isSafeInteger(item.weight) || item.weight < 0 || item.weight > 10000) {
      throw new AppError('항목 이름은 1~40자, 가중치는 0~10,000의 정수로 입력해 주세요.');
    }
    return { label: item.label.trim(), weight: item.weight };
  });
  const total = clean.reduce((sum, item) => sum + item.weight, 0);
  if (!total) throw new AppError('적어도 한 항목의 가중치는 1 이상이어야 해요.');
  let ticket = draw(total);
  const index = clean.findIndex((item) => (ticket -= item.weight) < 0);
  return { items: clean, index, total, result: clean[index], id: randomUUID() };
}

export class Room extends EventEmitter {
  constructor(channelId, channelName, demo = false, now = Date.now) {
    super();
    this.setMaxListeners(50);
    this.channelId = channelId;
    this.channelName = channelName;
    this.demo = demo;
    this.now = now;
    this.connection = demo ? 'demo' : 'disconnected';
    this.connectionMessage = demo ? '체험 채팅만 사용하고 있어요.' : '치지직 채팅에 연결해 주세요.';
    this.collecting = false;
    this.participants = new Map();
    this.previousWinners = new Set();
    this.excludeWinners = true;
    this.speaker = null;
    this.round = 0;
    this.poll = null;
    this.roulette = null;
    this.messages = [];
    this.seenMessages = new Map();
    this.audioOwner = null;
    this.closed = false;
  }

  changed() { this.emit('change'); }

  setConnection(status, message) {
    this.connection = status;
    this.connectionMessage = message;
    if (!['connected', 'demo'].includes(status)) this.stopSpeaker();
    this.changed();
  }

  requireChat() {
    if (!['connected', 'demo'].includes(this.connection)) {
      throw new AppError('치지직 채팅 연결을 먼저 확인해 주세요.', 409, 'CHAT_DISCONNECTED');
    }
  }

  stopSpeaker() {
    clearTimeout(this.speakerTimer);
    this.speaker = null;
    this.changed();
  }

  expireSpeaker() {
    if (this.speaker && this.now() >= this.speaker.endsAt) this.stopSpeaker();
  }

  drawViewer() {
    this.requireChat();
    this.expireSpeaker();
    if (this.speaker) throw new AppError('현재 발언권을 종료한 뒤 다시 추첨해 주세요.', 409);
    const candidates = [...this.participants.values()].filter((p) =>
      !this.excludeWinners || !this.previousWinners.has(p.id));
    if (!candidates.length) throw new AppError('추첨할 참가자가 없어요. 참가자를 모집해 주세요.', 409);
    const chosen = candidates[randomInt(candidates.length)];
    this.collecting = false;
    this.previousWinners.add(chosen.id);
    const startsAt = this.now();
    this.speaker = { ...chosen, round: ++this.round, startsAt, endsAt: startsAt + 30000 };
    this.speakerTimer = setTimeout(() => this.stopSpeaker(), 30000);
    this.speakerTimer.unref?.();
    this.changed();
    return this.speaker;
  }

  startPoll(question, options) {
    this.requireChat();
    if (this.poll?.active) throw new AppError('진행 중인 투표를 먼저 마감해 주세요.', 409);
    if (typeof question !== 'string' || !question.trim() || question.length > 100 ||
        !Array.isArray(options) || options.length < 2 || options.length > 10 ||
        options.some((x) => typeof x !== 'string' || !x.trim() || x.length > 40)) {
      throw new AppError('질문은 1~100자, 선택지는 2~10개(각 40자 이내)로 입력해 주세요.');
    }
    const labels = options.map((x) => x.trim());
    if (new Set(labels).size !== labels.length) throw new AppError('선택지 이름이 중복돼요.');
    this.poll = { id: randomUUID(), question: question.trim(), options: labels, votes: new Map(), active: true };
    this.changed();
  }

  ingest(event) {
    if (this.closed || event?.channelId !== this.channelId ||
        !['connected', 'demo'].includes(this.connection) ||
        typeof event.senderChannelId !== 'string' || !event.senderChannelId ||
        typeof event.content !== 'string' || !event.content.trim()) return false;
    // Ignore stale/redelivered upstream events; local receipt time governs the deadline too.
    const now = this.now();
    if (typeof event.messageTime !== 'number' || event.messageTime < now - 60000 || event.messageTime > now + 5000) return false;
    const key = JSON.stringify([event.senderChannelId, event.messageTime, event.content]);
    if (this.seenMessages.has(key)) return false;
    this.seenMessages.set(key, now);
    if (this.seenMessages.size > 5000) this.seenMessages.delete(this.seenMessages.keys().next().value);
    this.expireSpeaker();
    const text = event.content.trim().slice(0, 1000);
    const nickname = typeof event.profile?.nickname === 'string' ? event.profile.nickname.slice(0, 40) : '시청자';
    const id = event.senderChannelId;
    let kind = 'chat';
    if (text === '!참여' && this.collecting && this.participants.size < 1000) {
      this.participants.set(id, { id, nickname });
      kind = 'join';
    }
    const vote = /^!투표\s*([1-9]|10)$/.exec(text);
    if (vote && this.poll?.active && Number(vote[1]) <= this.poll.options.length) {
      // The latest valid choice replaces the previous vote, never increases a user's vote count.
      if (this.poll.votes.size < 10000 || this.poll.votes.has(id)) this.poll.votes.set(id, Number(vote[1]) - 1);
      kind = 'vote';
    }
    const speech = this.speaker && this.speaker.id === id && !text.startsWith('!') &&
      event.messageTime >= this.speaker.startsAt && event.messageTime < this.speaker.endsAt;
    if (speech) kind = 'tts';
    const message = { id: randomUUID(), nickname, text, kind, at: now };
    this.messages.push(message);
    this.messages = this.messages.slice(-40);
    if (speech) this.emit('tts', { ...message, text: text.slice(0, 150), round: this.speaker.round,
      endsAt: this.speaker.endsAt, speaker: this.speaker, audioOwner: this.audioOwner });
    this.changed();
    return true;
  }

  snapshot() {
    this.expireSpeaker();
    const counts = this.poll ? this.poll.options.map((_, i) => [...this.poll.votes.values()].filter((x) => x === i).length) : [];
    return {
      serverTime: this.now(), channelName: this.channelName, demo: this.demo,
      connection: this.connection, connectionMessage: this.connectionMessage,
      collecting: this.collecting, excludeWinners: this.excludeWinners,
      participants: [...this.participants.values()].map((p) => ({ ...p, won: this.previousWinners.has(p.id) })),
      speaker: this.speaker, round: this.round, messages: this.messages, audioOwner: this.audioOwner,
      poll: this.poll && { id: this.poll.id, question: this.poll.question, options: this.poll.options,
        counts, total: this.poll.votes.size, active: this.poll.active },
      roulette: this.roulette,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.speakerTimer);
    this.removeAllListeners();
  }
}
