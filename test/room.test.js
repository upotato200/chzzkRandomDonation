import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, weightedPick } from '../server/room.js';

const event = (channelId, id, content, at) => ({ channelId, senderChannelId: id,
  content, profile: { nickname: id }, messageTime: at });

test('채널 격리: 다른 채널의 채팅은 참가·투표·TTS에 반영하지 않는다', () => {
  const room = new Room('a', 'A', true, () => 100000);
  room.collecting = true;
  room.startPoll('질문', ['하나', '둘']);
  assert.equal(room.ingest(event('b', 'viewer', '!참여', 100000)), false);
  assert.equal(room.ingest(event('b', 'viewer', '!투표1', 100000)), false);
  assert.equal(room.participants.size, 0);
  assert.equal(room.poll.votes.size, 0);
  room.close();
});

test('모집 중이면 일반 채팅으로 자동 참가하고, 중복 재전송은 제거한다', () => {
  const room = new Room('a', 'A', true, () => 100000);
  room.collecting = true;
  const a = event('a', 'one', '안녕하세요', 100000);
  a.profile.nickname = '같은이름';
  assert.equal(room.ingest(a), true);
  assert.equal(room.ingest(a), false);
  room.ingest({ ...a, senderChannelId: 'two', content: '!투표1', messageTime: 100001 });
  assert.equal(room.participants.size, 2);
  room.close();
});

test('당첨 즉시 30초 시작, 당첨자만 읽고 정확한 종료 경계 이후는 차단한다', () => {
  let now = 100000;
  const room = new Room('a', 'A', true, () => now);
  room.participants.set('winner', { id: 'winner', nickname: '당첨자' });
  const output = [];
  room.on('tts', (message) => output.push(message));
  room.drawViewer();
  assert.equal(room.speaker.startsAt, 100000);
  assert.equal(room.speaker.endsAt, 130000);
  assert.equal(room.collecting, false);
  room.ingest(event('a', 'other', '내 채팅', now));
  room.ingest(event('a', 'winner', '준비 없이 바로', now));
  now = 129999;
  room.ingest(event('a', 'winner', '마지막', now));
  now = 130000;
  room.ingest(event('a', 'winner', '시간 지남', now));
  assert.deepEqual(output.map((m) => m.text), ['준비 없이 바로', '마지막']);
  assert.equal(room.speaker, null);
  assert.throws(() => room.drawViewer(), /참가자가 없어요/);
  room.close();
});

test('재추첨 이전의 늦은 채팅은 새 발언권으로 읽지 않는다', () => {
  let now = 100000;
  const room = new Room('a', 'A', true, () => now);
  room.participants.set('winner', { id: 'winner', nickname: '당첨자' });
  room.excludeWinners = false;
  room.drawViewer();
  room.stopSpeaker();
  now += 10000;
  room.drawViewer();
  let speeches = 0;
  room.on('tts', () => speeches++);
  room.ingest(event('a', 'winner', '이전 라운드', now - 1000));
  assert.equal(speeches, 0);
  room.close();
});

test('수동 종료와 연결 끊김이 발언권을 즉시 해제한다', () => {
  const room = new Room('a', 'A', true);
  room.participants.set('winner', { id: 'winner', nickname: '당첨자' });
  room.excludeWinners = false;
  room.drawViewer();
  room.stopSpeaker();
  assert.equal(room.speaker, null);
  room.drawViewer();
  room.setConnection('reconnecting', '재연결');
  assert.equal(room.speaker, null);
  assert.throws(() => room.drawViewer(), /연결/);
  room.close();
});

test('숫자 투표는 1인 1표, 변경 가능, 마감·잘못된 번호는 미반영', () => {
  let now = 100000;
  const room = new Room('a', 'A', true, () => now);
  room.startPoll('무엇?', ['하나', '둘']);
  room.ingest(event('a', 'one', '!투표1', now++));
  room.ingest(event('a', 'one', '!투표2', now++));
  room.ingest(event('a', 'two', '!투표1', now++));
  room.ingest(event('a', 'three', '!투표3', now++));
  assert.deepEqual(room.snapshot().poll.counts, [1, 1]);
  assert.equal(room.snapshot().poll.total, 2);
  room.poll.active = false;
  room.ingest(event('a', 'three', '!투표2', now++));
  assert.equal(room.snapshot().poll.total, 2);
  room.startPoll('새 투표', ['가', '나']);
  assert.equal(room.snapshot().poll.total, 0);
  room.close();
});

test('가중치 추첨의 모든 정수 구간은 설정 비율과 정확히 일치한다', () => {
  const items = [{ label: 'zero', weight: 0 }, { label: 'A', weight: 1 }, { label: 'B', weight: 3 }];
  const results = [0, 1, 2, 3].map((ticket) => weightedPick(items, () => ticket).result.label);
  assert.deepEqual(results, ['A', 'B', 'B', 'B']);
  for (const weight of [-1, 0.5, NaN, Infinity, 10001]) {
    assert.throws(() => weightedPick([{ label: 'A', weight }, { label: 'B', weight: 1 }]));
  }
  assert.throws(() => weightedPick([{ label: 'A', weight: 0 }, { label: 'B', weight: 0 }]));
});
