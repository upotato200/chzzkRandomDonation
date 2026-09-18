const $ = (id) => document.getElementById(id);
const colors = ['#b8df80', '#396653', '#839857', '#2d5045', '#89baa0', '#536f44', '#d0dd8f', '#446b5a'];
let csrf = '', audioId = '', configured = false, state = null, source = null;
let serverOffset = 0, streamHealthy = false, currentTab = 'viewer';
let weights = [{ label: '한 판 더', weight: 40 }, { label: '노래 한 소절', weight: 20 }, { label: '시청자와 수다', weight: 30 }, { label: '오늘은 여기까지', weight: 10 }];
let toastTimer, viewerRotation = 0, weightedRotation = 0, lastRound = 0, lastLottery = '';
let participantKey = '', messageKey = '', wheelKey = '';
let audioEnabled = false, audioGeneration = 0, utterance = null, queue = [], releaseLock = null;
const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const synth = supported ? window.speechSynthesis : null;
let voices = [];
const seenSpeech = new Set();

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

async function api(path, data = {}) {
  let response;
  try { response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) }); }
  catch { stopSpeech(); throw new Error('서버에 연결할 수 없어요. 연결 상태를 확인해 주세요.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했어요.');
  if (body.state) applyState(body.state);
  return body;
}

function on(id, event, action) {
  $(id).addEventListener(event, async (e) => {
    try { await action(e); } catch (error) { toast(error.message); }
  });
}

function stopSpeech() {
  ++audioGeneration;
  queue = [];
  utterance = null;
  synth?.cancel();
  $('audio-status').textContent = audioEnabled ? '당첨자의 채팅을 자동으로 읽어요.' : '이 브라우저에서 소리가 재생돼요.';
}

function audioUi() {
  $('audio-enabled').checked = audioEnabled;
  $('audio-label').textContent = audioEnabled ? 'TTS 켜짐' : 'TTS 꺼짐';
}

function disableAudio() {
  audioEnabled = false;
  stopSpeech();
  releaseLock?.();
  releaseLock = null;
  audioUi();
}

async function claimLocalAudio() {
  if (!navigator.locks || releaseLock) return true;
  return new Promise((resolve) => {
    navigator.locks.request('your-turn-audio', { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(false); return; }
      await new Promise((release) => { releaseLock = release; resolve(true); });
    }).catch(() => resolve(false));
  });
}

function populateVoices() {
  if (!supported) return;
  const previous = $('voice-select').value;
  voices = synth.getVoices();
  const korean = voices.filter((v) => v.lang.toLowerCase().startsWith('ko'));
  const available = korean.length ? korean : voices;
  $('voice-select').replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = korean.length ? '기본 한국어 음성' : '시스템 기본 음성 (한국어)';
  $('voice-select').append(defaultOption);
  available.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} · ${voice.lang}`;
    $('voice-select').append(option);
  });
  if ([...$('voice-select').options].some((o) => o.value === previous)) $('voice-select').value = previous;
  if (voices.length && !korean.length) $('audio-status').textContent = '한국어 목소리가 없으면 기기의 음성 설정에서 추가해 주세요.';
}

function speakNext() {
  if (!supported || utterance || !queue.length) return;
  const item = queue.shift();
  if (!item.test && (!audioEnabled || !streamHealthy || !state?.speaker ||
      item.round !== state.speaker.round || Date.now() + serverOffset >= item.endsAt)) return speakNext();
  const generation = audioGeneration;
  utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = 'ko-KR';
  utterance.voice = voices.find((v) => v.voiceURI === $('voice-select').value) || voices.find((v) => v.lang.toLowerCase().startsWith('ko')) || null;
  utterance.rate = Number($('rate').value);
  utterance.volume = Number($('volume').value);
  const current = utterance;
  let watchdog;
  current.onstart = () => {
    if (generation !== audioGeneration) return;
    clearTimeout(watchdog);
    $('audio-status').textContent = item.test ? '테스트 음성을 읽고 있어요.' : `읽는 중 · 대기 ${queue.length}개`;
    // Also bound a platform speech engine that never emits an end event.
    watchdog = setTimeout(() => { if (generation === audioGeneration && utterance === current) { stopSpeech(); toast('음성 재생이 지연되어 중지했어요.'); } }, 45000);
  };
  const finish = (error) => {
    clearTimeout(watchdog);
    if (generation !== audioGeneration || utterance !== current) return;
    utterance = null;
    if (error && !['interrupted', 'canceled'].includes(error)) {
      queue = [];
      toast('음성을 재생하지 못했어요. 목소리를 선택한 뒤 음성 테스트를 눌러 주세요.');
    }
    $('audio-status').textContent = audioEnabled ? '다음 채팅을 기다리고 있어요.' : '음성 테스트 완료';
    speakNext();
  };
  current.onend = () => finish();
  current.onerror = (e) => finish(e.error);
  watchdog = setTimeout(() => {
    if (generation === audioGeneration && utterance === current) { stopSpeech(); toast('소리가 시작되지 않았어요. 음성 테스트로 브라우저 재생을 확인해 주세요.'); }
  }, 8000);
  synth.resume();
  synth.speak(current);
}

function testVoice() {
  if (!supported) return toast('이 브라우저는 TTS를 지원하지 않아요. 다른 브라우저에서 열어 주세요.');
  stopSpeech();
  queue.push({ test: true, text: '안녕하세요. 너의 차례입니다. 지금 이 목소리가 잘 들리시나요?' });
  speakNext();
}

function handleSpeech(item) {
  if (!audioEnabled || !streamHealthy || item.audioOwner !== audioId || seenSpeech.has(item.id) ||
      Date.now() + serverOffset >= item.endsAt) return;
  if (!state?.speaker || state.speaker.round < item.round) applyState({ ...state, speaker: item.speaker, round: item.round, serverTime: item.at });
  if (state.speaker?.round !== item.round) return;
  seenSpeech.add(item.id);
  if (seenSpeech.size > 500) seenSpeech.delete(seenSpeech.values().next().value);
  $('speaking-text').querySelector('p').textContent = item.text;
  if (queue.length >= 10) { toast('읽을 채팅이 많아 새 음성을 건너뛰었어요.'); return; }
  queue.push(item);
  speakNext();
}

function connectEvents() {
  source?.close();
  streamHealthy = false;
  source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    streamHealthy = true;
    applyState(JSON.parse(event.data));
  });
  source.addEventListener('heartbeat', () => { streamHealthy = true; });
  source.addEventListener('tts', (event) => handleSpeech(JSON.parse(event.data)));
  source.onerror = () => {
    streamHealthy = false;
    stopSpeech();
    $('connection-message').textContent = '진행자 화면의 연결이 끊겼어요. 재연결 중에는 음성이 중지돼요.';
    $('connection-badge').textContent = '재연결 중';
    $('connection-badge').className = 'status-badge';
    ['draw-viewer', 'collect', 'poll-start', 'draw-weighted'].forEach((id) => { $(id).disabled = true; });
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawWheel(id, entries) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', entries.length ? `룰렛 항목 ${entries.length}개` : '참가자를 기다리는 룰렛');
  let items = entries.length ? entries : Array.from({ length: 8 }, (_, i) => ({ label: 'YOUR TURN', weight: 1 }));
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (!total) { $(id).replaceChildren(); return; }
  let angle = -90;
  items.forEach((item, i) => {
    const sweep = item.weight / total * 360;
    if (!sweep) return;
    const point = (a) => [150 + 150 * Math.cos(a * Math.PI / 180), 150 + 150 * Math.sin(a * Math.PI / 180)];
    const path = document.createElementNS(svg.namespaceURI, sweep >= 359.99 ? 'circle' : 'path');
    if (sweep >= 359.99) { path.setAttribute('cx', '150'); path.setAttribute('cy', '150'); path.setAttribute('r', '150'); }
    else path.setAttribute('d', `M150 150 L${point(angle).join(' ')} A150 150 0 ${sweep > 180 ? 1 : 0} 1 ${point(angle + sweep).join(' ')} Z`);
    path.setAttribute('fill', colors[i % colors.length]);
    path.setAttribute('stroke', '#12231b');
    path.setAttribute('stroke-width', '1');
    svg.append(path);
    if (sweep >= 13) {
      const mid = angle + sweep / 2;
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', String(150 + 99 * Math.cos(mid * Math.PI / 180)));
      text.setAttribute('y', String(150 + 99 * Math.sin(mid * Math.PI / 180)));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', entries.length ? '12' : '10');
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', [0, 2, 4, 6].includes(i % 8) ? '#132b1e' : '#e1eee5');
      text.setAttribute('transform', `rotate(${mid + 90}, ${text.getAttribute('x')}, ${text.getAttribute('y')})`);
      text.textContent = item.label.length > 8 ? item.label.slice(0, 7) + '…' : item.label;
      svg.append(text);
    }
    angle += sweep;
  });
  $(id).replaceChildren(svg);
}

function spinTo(id, items, index) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const before = items.slice(0, index).reduce((sum, item) => sum + item.weight, 0);
  const target = 360 - ((before + items[index].weight / 2) / total * 360);
  const old = id === 'viewer-wheel' ? viewerRotation : weightedRotation;
  const wheel = $(id);
  const next = old + 1800 + ((target - old % 360 + 360) % 360);
  wheel.classList.remove('spinning');
  void wheel.offsetWidth;
  wheel.classList.add('spinning');
  wheel.style.transform = `rotate(${next}deg)`;
  window.setTimeout(() => wheel.classList.remove('spinning'), 3000);
  if (id === 'viewer-wheel') viewerRotation = next; else weightedRotation = next;
}

function renderParticipants() {
  const participants = state?.participants || [];
  const key = JSON.stringify([participants, state?.excludeWinners]);
  if (key === participantKey) return;
  participantKey = key;
  $('participant-count').textContent = participants.length;
  if (!participants.length) {
    $('participants').replaceChildren(el('div', 'empty', '모집을 시작하고 !참여를 입력해 주세요.'));
  } else {
    $('participants').replaceChildren(...participants.map((p) => {
      const row = el('div', `participant${p.won && state.excludeWinners ? ' won' : ''}`);
      row.append(el('span', 'avatar', p.nickname.slice(0, 1)), el('span', 'participant-name', p.nickname), el('span', 'tiny', p.won ? '당첨' : '참가'));
      return row;
    }));
  }
  $('sample-names').replaceChildren(...participants.map((p) => { const option = document.createElement('option'); option.value = p.nickname; return option; }));
  const eligible = participants.filter((p) => !state.excludeWinners || !p.won);
  $('eligible-count').textContent = `추첨 가능 ${eligible.length}명`;
  // Keep the drawn roster visible while its current speaker is active.
  const display = state?.speaker ? participants.filter((p) => !state.excludeWinners || !p.won || p.id === state.speaker.id) : eligible;
  const nextWheelKey = JSON.stringify(display);
  if (nextWheelKey !== wheelKey) { drawWheel('viewer-wheel', display.map((p) => ({ label: p.nickname, weight: 1 }))); wheelKey = nextWheelKey; }
}

function renderPoll() {
  const poll = state?.poll;
  if (!poll) return;
  $('poll-title').textContent = poll.question;
  $('poll-status').textContent = poll.active ? '투표 진행 중' : '마감';
  $('poll-status').className = `mini-badge${poll.active ? ' active' : ''}`;
  $('poll-total').textContent = `참여 ${poll.total.toLocaleString()}명`;
  $('poll-results').replaceChildren(...poll.options.map((option, i) => {
    const percent = poll.total ? poll.counts[i] / poll.total * 100 : 0;
    const row = el('div', 'poll-result');
    const label = el('div', 'poll-result-label');
    const name = el('span');
    name.append(el('b', '', String(i + 1).padStart(2, '0')), document.createTextNode(option));
    label.append(name, el('span', '', `${poll.counts[i]}표 · ${percent.toFixed(1)}%`));
    const track = el('div', 'bar-track');
    const bar = el('div', 'bar');
    bar.style.width = percent + '%';
    track.append(bar);
    row.append(label, track);
    return row;
  }));
}

function applyState(next) {
  const oldSpeaker = state?.speaker;
  state = next;
  serverOffset = next.serverTime - Date.now();
  if (oldSpeaker && (!next.speaker || oldSpeaker.round !== next.speaker.round)) stopSpeech();
  if (audioEnabled && next.audioOwner !== audioId) { disableAudio(); toast('다른 진행자 화면으로 음성 재생이 이동했어요.'); }
  const connected = ['connected', 'demo'].includes(next.connection);
  const badge = $('connection-badge');
  badge.textContent = next.demo ? '체험 모드' : ({ connected: '연결됨', connecting: '연결 중', reconnecting: '재연결 중', reauth: '재로그인 필요', error: '연결 오류' }[next.connection] || '연결 전');
  badge.className = `status-badge${next.demo ? ' demo' : connected ? ' live' : ''}`;
  $('channel-name').textContent = next.channelName;
  $('connection-message').textContent = next.demo ? '체험 모드예요. 아래 체험 채팅으로 참가·투표·TTS를 테스트할 수 있어요. 실제 방송에는 전송되지 않아요.' : next.connectionMessage;
  $('demo-start').hidden = true;
  $('disconnect').hidden = false;
  $('connect').querySelector('span').textContent = next.demo ? '치지직 연결' : '계정 다시 연결';
  $('reconnect').hidden = next.demo || connected || ['connecting', 'reconnecting'].includes(next.connection);
  $('collect').disabled = !connected;
  $('collect').textContent = next.collecting ? '모집 마감' : '모집 시작';
  $('reset-participants').disabled = false;
  $('exclude-winners').checked = next.excludeWinners;
  const eligible = next.participants.filter((p) => !next.excludeWinners || !p.won);
  $('draw-viewer').disabled = !connected || !eligible.length || Boolean(next.speaker);
  $('stop-speaker').disabled = !next.speaker;
  $('poll-start').disabled = !connected || next.poll?.active;
  $('poll-stop').disabled = !next.poll?.active;
  $('draw-weighted').disabled = false;
  $('audio-enabled').disabled = !supported;
  $('demo-chat').hidden = !next.demo;
  $('chat-mode').textContent = next.demo ? '체험 채팅' : '치지직 실시간';
  renderParticipants();
  renderPoll();
  const speaker = next.speaker;
  $('speaker-status').textContent = speaker ? '발언 중' : '대기 중';
  $('speaker-status').className = `mini-badge${speaker ? ' active' : ''}`;
  $('speaker-avatar').textContent = speaker?.nickname.slice(0, 1) || '?';
  $('speaker-name').textContent = speaker?.nickname || '아직 주인공이 없어요';
  $('speaker-hint').textContent = speaker ? '지금 채팅하면 목소리로 전해져요.' : '룰렛을 돌려 한 사람을 만나보세요.';
  $('draw-title').textContent = speaker ? `${speaker.nickname} 님, 너의 차례!` : '다음 주인공을 만나볼까요?';
  $('draw-description').textContent = speaker ? '발언권은 이미 시작됐어요. 바로 대화해 보세요.' : '당첨되는 순간, 45초 동안 채팅이 음성으로 나와요.';
  if (!speaker) $('speaking-text').querySelector('p').textContent = '당첨자의 채팅을 기다리고 있어요.';
  if (speaker && speaker.round !== lastRound) {
    lastRound = speaker.round;
    const roster = next.participants.filter((p) => !next.excludeWinners || !p.won || p.id === speaker.id);
    spinTo('viewer-wheel', roster.map((p) => ({ label: p.nickname, weight: 1 })), roster.findIndex((p) => p.id === speaker.id));
    if (next.demo) $('demo-nickname').value = speaker.nickname;
  }
  const messages = JSON.stringify(next.messages);
  if (messages !== messageKey) {
    messageKey = messages;
    $('messages').replaceChildren(...next.messages.map((message) => {
      const row = el('div', `message ${message.kind}`);
      row.append(el('strong', '', message.nickname), el('span', '', message.text));
      return row;
    }));
    if (!next.messages.length) $('messages').append(el('p', 'empty-chat', next.demo ? '아래에서 체험 채팅을 입력해 보세요.' : '첫 채팅을 기다리고 있어요.'));
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  if (next.roulette && next.roulette.id !== lastLottery) {
    lastLottery = next.roulette.id;
    weights = next.roulette.items.map((item) => ({ ...item }));
    renderWeightEditor();
    spinTo('weighted-wheel', weights, next.roulette.index);
    $('weighted-result').textContent = `당첨! ${next.roulette.result.label}`;
  }
  tick();
}

function tick() {
  const remaining = state?.speaker ? Math.max(0, state.speaker.endsAt - Date.now() - serverOffset) : 45000;
  $('seconds').textContent = Math.ceil(remaining / 1000).toString().padStart(2, '0');
  $('timer-fill').style.width = `${remaining / 450}%`;
  if (state?.speaker && !remaining) { stopSpeech(); $('speaker-status').textContent = '시간 종료'; }
}

function renderWeightEditor() {
  $('weight-items').replaceChildren(...weights.map((item, i) => {
    const row = el('div', 'weight-row');
    const name = document.createElement('input');
    name.value = item.label; name.maxLength = 40; name.setAttribute('aria-label', `항목 ${i + 1} 이름`);
    name.addEventListener('input', () => { item.label = name.value; updateWeightVisual(); });
    const weight = document.createElement('input');
    weight.type = 'number'; weight.min = '0'; weight.max = '10000'; weight.step = '1'; weight.value = item.weight;
    weight.setAttribute('aria-label', `항목 ${i + 1} 가중치`);
    weight.addEventListener('input', () => { item.weight = weight.value === '' ? NaN : Number(weight.value); updateWeightVisual(); });
    const percent = el('span', 'weight-percent');
    const remove = el('button', 'weight-remove', '×');
    remove.setAttribute('aria-label', `항목 ${i + 1} 삭제`);
    remove.disabled = weights.length <= 2;
    remove.addEventListener('click', () => { weights.splice(i, 1); renderWeightEditor(); });
    row.append(name, weight, percent, remove);
    return row;
  }));
  $('add-weight').disabled = weights.length >= 30;
  updateWeightVisual();
}

function updateWeightVisual() {
  const valid = weights.every((item) => Number.isSafeInteger(item.weight) && item.weight >= 0 && item.weight <= 10000);
  const sum = valid ? weights.reduce((s, item) => s + item.weight, 0) : 0;
  document.querySelectorAll('.weight-percent').forEach((node, i) => { node.textContent = sum ? `${(weights[i].weight / sum * 100).toFixed(1)}%` : '—'; });
  drawWheel('weighted-wheel', valid ? weights : []);
}

async function demo() {
  $('setup-dialog').close();
  await api('/api/demo/start');
  connectEvents();
  $('demo-nickname').value = state.participants[0]?.nickname || '체험시청자';
  toast('체험 모드를 시작했어요. 참가자 8명으로 바로 추첨해 보세요.');
}

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  currentTab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((tab) => { tab.classList.toggle('active', tab === button); if (tab === button) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
  document.querySelectorAll('.tool-view').forEach((view) => { view.hidden = view.id !== `${currentTab}-view`; });
}));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
on('guide-open', 'click', () => $('guide-dialog').showModal());
on('connect', 'click', () => { if (configured) location.assign('/auth/chzzk'); else $('setup-dialog').showModal(); });
on('demo-start', 'click', demo);
on('setup-demo', 'click', demo);
on('disconnect', 'click', async () => { disableAudio(); source?.close(); await api('/api/logout'); location.assign('/'); });
on('reconnect', 'click', () => api('/api/reconnect'));
on('collect', 'click', () => api('/api/participants/collect', { active: !state.collecting }));
on('exclude-winners', 'change', async () => { try { await api('/api/participants/exclude', { active: $('exclude-winners').checked }); } catch (error) { $('exclude-winners').checked = state?.excludeWinners ?? true; throw error; } });
on('reset-participants', 'click', () => $('reset-dialog').showModal());
on('confirm-reset', 'click', async () => { stopSpeech(); await api('/api/participants/reset'); $('reset-dialog').close(); });
on('draw-viewer', 'click', async () => {
  $('draw-viewer').disabled = true;
  try { await api('/api/viewer/draw'); }
  finally { $('draw-viewer').disabled = !state || !!state.speaker || !state.participants.some((p) => !state.excludeWinners || !p.won); }
});
on('stop-speaker', 'click', async () => { stopSpeech(); await api('/api/viewer/stop'); });
on('poll-form', 'submit', async (event) => { event.preventDefault(); await api('/api/poll/start', { question: $('poll-question').value, options: $('poll-options').value.split('\n').map((s) => s.trim()).filter(Boolean) }); });
on('poll-stop', 'click', () => api('/api/poll/stop'));
on('add-weight', 'click', () => { if (weights.length < 30) { weights.push({ label: '', weight: 10 }); renderWeightEditor(); } });
on('draw-weighted', 'click', async () => {
  $('draw-weighted').disabled = true;
  try { await api('/api/roulette/draw', { items: weights }); }
  finally { $('draw-weighted').disabled = !state; }
});
on('demo-chat', 'submit', async (event) => { event.preventDefault(); await api('/api/demo/chat', { nickname: $('demo-nickname').value, text: $('demo-text').value }); $('demo-text').value = ''; $('demo-text').focus(); });
on('audio-enabled', 'change', async () => {
  if (!$('audio-enabled').checked) { disableAudio(); if (state) await api('/api/audio/release'); return; }
  if (!supported || !state) { audioUi(); return toast('채널을 연결하거나 체험 모드를 먼저 시작해 주세요.'); }
  if (!await claimLocalAudio()) { audioUi(); return toast('다른 탭에서 TTS가 켜져 있어요. 먼저 그 탭에서 꺼 주세요.'); }
  try {
    await api('/api/audio/claim');
    audioEnabled = true;
    audioUi();
    testVoice();
  } catch (error) { disableAudio(); throw error; }
});
on('test-voice', 'click', async () => { if (await claimLocalAudio()) testVoice(); else toast('다른 탭에서 음성이 재생 중이에요.'); });
on('stop-audio', 'click', () => { stopSpeech(); toast('현재 음성과 대기열을 비웠어요.'); });
on('rate', 'input', () => { $('rate-value').textContent = Number($('rate').value).toFixed(1) + '×'; });
on('volume', 'input', () => { $('volume-value').textContent = Math.round(Number($('volume').value) * 100) + '%'; });
window.addEventListener('pagehide', () => { disableAudio(); source?.close(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
setInterval(tick, 100);
drawWheel('viewer-wheel', []);
renderWeightEditor();
populateVoices();
if (supported) synth.addEventListener('voiceschanged', populateVoices);
else { $('audio-enabled').disabled = true; $('test-voice').disabled = true; $('audio-status').textContent = '이 브라우저는 TTS를 지원하지 않아요.'; }

try {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('서버를 확인해 주세요.');
  const data = await response.json();
  csrf = data.csrf; audioId = data.audioId; configured = data.configured;
  $('redirect-uri').textContent = data.redirectUri;
  if (data.state) { applyState(data.state); connectEvents(); }
  const auth = new URLSearchParams(location.search).get('auth');
  if (auth) {
    history.replaceState(null, '', '/');
    if (auth === 'setup') $('setup-dialog').showModal();
    else toast({ invalid_state: '로그인 요청이 만료됐어요. 치지직 연결을 다시 눌러 주세요.', cancelled: '치지직 로그인이 취소됐어요.', failed: '치지직 로그인에 실패했어요. 앱 설정과 조회 권한을 확인해 주세요.' }[auth] || '로그인을 다시 시도해 주세요.');
  }
} catch (error) { $('connection-message').textContent = '서버 연결에 실패했어요. 페이지를 새로고침해 주세요.'; toast(error.message); }
