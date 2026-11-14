// student.js : 학생 입장, 문제 풀이, 결과 확인
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);

const KEY = 'quizStudent';
const VIEWS = ['view-join', 'view-profile', 'view-wait', 'view-play', 'view-feedback', 'view-end'];
const CHARACTERS = [
  { id: 'bear',   name: '곰' },
  { id: 'rabbit', name: '토끼' },
  { id: 'cat',    name: '고양이' },
  { id: 'fox',    name: '여우' },
  { id: 'panda',  name: '판다' },
];
const ERRORS = {
  ROOM_NOT_FOUND: '방을 찾을 수 없어요. 선생님께 코드를 다시 확인하세요.',
  ROOM_ALREADY_STARTED: '이미 시작된 게임이에요.',
  INVALID_NICKNAME: '별명은 한글, 영문, 숫자 1~8자로 입력하세요.',
  BANNED_NICKNAME: '사용할 수 없는 별명이에요. 다른 별명을 입력하세요.',
  NICKNAME_TAKEN: '같은 별명이 있어요. 다른 별명을 입력하세요.',
  CHARACTER_TAKEN: '이미 선택된 캐릭터예요. 다른 캐릭터를 고르세요.',
  NICKNAME_OR_CHARACTER_TAKEN: '같은 별명이나 캐릭터가 있어요. 다시 골라 주세요.',
  ROOM_NOT_RUNNING: '아직 문제를 풀 수 없어요.',
  NOT_CURRENT_QUESTION: '문제 정보가 바뀌었어요. 화면을 다시 불러옵니다.',
  NOT_PLAYER: '방에 다시 입장해 주세요.',
};

let pendingCode = null;   // 입장 화면에서 확인한 방 코드
let me = null;            // { roomId, playerId, nickname, characterId, code }
let selectedChar = null;  // 선택한 캐릭터 번호 (1~5)
let myCorrectCount = 0;   // 현재까지 맞힌 문제 수 (표정 변화용)
let question = null;      // get_current_question 결과
let selected = null;      // 객관식 선택 번호 ('1'~'4')
let answering = false;    // 제출 중 여부
let offset = 0;           // 서버 시각 - 기기 시각 (ms)
let timerId = null;       // 문항 제한시간 타이머
let waitTimer = null;     // 시작 대기 타이머
let channel = null;       // Realtime 구독

function getCharacterImage(characterId, correctCount) {
  const char = CHARACTERS[characterId - 1] || CHARACTERS[0];
  let stage = 1;
  if (correctCount >= 20) stage = 3;
  else if (correctCount >= 10) stage = 2;
  return `./images/${char.id}_${stage}.png`;
}

function errText(err) {
  return ERRORS[err && err.message] || '문제가 생겼어요. 잠시 후 다시 시도하세요.';
}

function setMessage(text) {
  $('msg').textContent = text;
  $('msg').className = text ? 'msg-error' : '';
}

function showView(id) {
  VIEWS.forEach(v => $(v).classList.toggle('hidden', v !== id));
}

// ---- 시작 ---------------------------------------------------------------
async function init() {
  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) await sb.auth.signInAnonymously();
  } catch (e) {
    setMessage('연결에 문제가 있어요. 잠시 후 다시 시도하세요.');
    return;
  }

  buildCharGrid();
  const qCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');

  // 같은 방에 이미 입장한 기록이 있으면 자동 복구 (S-12)
  if (saved && (!qCode || qCode === saved.code)) {
    try {
      await joinRoom(saved.code, saved.nickname, saved.characterId);
      route();
      return;
    } catch (e) {
      localStorage.removeItem(KEY);
      setMessage(errText(e));
    }
  }

  $('code-input').value = qCode.slice(0, 6);
  showView('view-join');
  $('code-input').focus();
}

// join_room: 처음 입장과 재접속을 모두 처리
async function joinRoom(code, nickname, characterId) {
  const { data, error } = await sb.rpc('join_room', {
    p_code: code,
    p_nickname: nickname,
    p_character_id: characterId,
  });
  if (error) throw error;
  me = {
    roomId: data.room_id,
    playerId: data.player_id,
    nickname: data.nickname,
    characterId: data.character_id,
    code,
  };
  localStorage.setItem(KEY, JSON.stringify({
    code, nickname: data.nickname, characterId: data.character_id,
  }));
  return data;
}

// ---- 입장 화면 ----------------------------------------------------------
$('join-btn').onclick = () => {
  const code = $('code-input').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setMessage('방 코드 6자리를 입력하세요.');
    return;
  }
  pendingCode = code;
  setMessage('');
  showView('view-profile');
  $('nick-input').focus();
};

$('profile-back').onclick = () => {
  setMessage('');
  showView('view-join');
};

function buildCharGrid() {
  const grid = $('char-grid');
  grid.innerHTML = '';
  CHARACTERS.forEach((char, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'choice char-btn';
    b.style.display = 'flex';
    b.style.flexDirection = 'column';
    b.style.alignItems = 'center';
    b.style.gap = '6px';
    b.innerHTML = `
      <img src="./images/${char.id}_1.png" alt="${char.name}" style="width: 56px; height: 56px; object-fit: contain;">
      <span>${char.name}</span>
    `;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      selectedChar = i + 1;
      [...grid.children].forEach((c, j) => {
        c.setAttribute('aria-pressed', j === i ? 'true' : 'false');
      });
    };
    grid.append(b);
  });
}

$('enter-btn').onclick = async () => {
  const nickname = $('nick-input').value.trim();
  if (!/^[가-힣A-Za-z0-9]{1,8}$/.test(nickname)) {
    setMessage('별명은 한글, 영문, 숫자 1~8자로 입력하세요.');
    return;
  }
  if (!selectedChar) {
    setMessage('캐릭터를 골라 주세요.');
    return;
  }

  $('enter-btn').disabled = true;
  try {
    await joinRoom(pendingCode, nickname, selectedChar);
    setMessage('');
    route();
  } catch (e) {
    setMessage(errText(e));
  } finally {
    $('enter-btn').disabled = false;
  }
};

// ---- 상태에 따라 화면 전환 ---------------------------------------------
async function route() {
  clearTimeout(waitTimer);
  if (!me) { showView('view-join'); return; }
  watchRoom();

  const { data, error } = await sb.rpc('get_current_question', { p_room_id: me.roomId });
  if (error) { setMessage(errText(error)); return; }
  if (data.server_now) offset = new Date(data.server_now).getTime() - Date.now();

  if (data.state === 'waiting') return showWait('선생님이 시작할 때까지 기다려요.');
  if (data.state === 'running') return startQuestion(data);
  return showEnd();
}

// 방 상태 변화(시작, 종료, 순위 공개)를 받으면 다시 확인
function watchRoom() {
  if (channel || !me) return;
  channel = sb.channel(`student-${me.roomId}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${me.roomId}` },
      () => route())
    .subscribe();
}

function showWait(text) {
  clearInterval(timerId);
  const char = CHARACTERS[me.characterId - 1] || CHARACTERS[0];
  $('wait-text').textContent = text;
  $('me-line').textContent = `${char.name} · ${me.nickname}`;
  showView('view-wait');
}

// ---- 문제 풀이 ----------------------------------------------------------
function startQuestion(data) {
  const startAt = new Date(data.question_started_at).getTime();
  const wait = startAt - (Date.now() + offset);
  if (wait > 0) {
    showWait(`${Math.ceil(wait / 1000)}초 후에 시작해요.`);
    waitTimer = setTimeout(route, wait + 50);
    return;
  }

  question = data;
  selected = null;
  answering = false;
  renderQuestion();
  showView('view-play');
  startTimer();
}

function renderQuestion() {
  $('my-char-img').src = getCharacterImage(me.characterId, myCorrectCount);
  $('q-index').textContent = `${question.index} / ${question.total}`;
  $('q-type').textContent = question.type === 'mc' ? '객관식' : '초성 서답형';
  $('q-body').textContent = question.body;

  const hint = $('q-hint');
  hint.textContent = question.hint ? `힌트: ${question.hint}` : '';
  hint.classList.toggle('hidden', !question.hint);

  const wrap = $('q-options');
  const input = $('q-input');
  wrap.innerHTML = '';

  if (question.type === 'mc') {
    input.classList.add('hidden');
    question.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.textContent = `${i + 1}. ${opt}`;
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        selected = String(i + 1);
        [...wrap.children].forEach(c => {
          c.setAttribute('aria-pressed', c === b ? 'true' : 'false');
        });
      };
      wrap.append(b);
    });
  } else {
    input.value = '';
    input.classList.remove('hidden');
    input.focus();
  }

  $('play-msg').textContent = '';
  $('submit-btn').disabled = false;
}

// 서버 시각 기준으로 남은 시간을 계산하고, 0이 되면 자동 제출
function startTimer() {
  clearInterval(timerId);
  const deadline = new Date(question.question_started_at).getTime() + question.time_limit_sec * 1000;

  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000));
    $('q-timer').textContent = `${left}초`;
    $('q-bar').style.width = `${(left / question.time_limit_sec) * 100}%`;
    if (left === 0) {
      clearInterval(timerId);
      submit(true);
    }
  };

  tick();
  timerId = setInterval(tick, 250);
}

async function submit(timedOut = false) {
  if (answering || !question) return;

  const value = question.type === 'mc'
    ? (selected || '')
    : $('q-input').value.trim();

  if (!value && !timedOut) {
    $('play-msg').textContent = question.type === 'mc' ? '보기를 하나 골라 주세요.' : '답을 입력해 주세요.';
    return;
  }

  answering = true;
  $('submit-btn').disabled = true;
  clearInterval(timerId);

  const { data, error } = await sb.rpc('submit_answer', {
    p_room_id: me.roomId,
    p_question_id: question.question_id,
    p_value: value,
  });
  answering = false;

  if (error) {
    if (error.message === 'NOT_CURRENT_QUESTION' || error.message === 'ROOM_NOT_RUNNING') {
      route();
      return;
    }
    $('play-msg').textContent = errText(error);
    $('submit-btn').disabled = false;
    if (!timedOut) startTimer();
    return;
  }

  showFeedback(data);
}

function showFeedback(d) {
  clearInterval(timerId);
  myCorrectCount = d.correct_count || 0;
  const mark = $('fb-mark');
  mark.textContent = d.is_timeout ? '시간이 지났어요' : (d.is_correct ? '정답입니다' : '틀렸어요');
  mark.className = `fb-mark ${d.is_correct ? 'msg-ok' : 'msg-error'}`;
  $('fb-answer').textContent = d.is_correct ? '' : `정답: ${d.correct_answer}`;
  $('fb-score').textContent = `이번 점수 ${d.score}점 · 총점 ${d.total_score}점 · 맞힌 개수 ${d.correct_count}개`;
  showView('view-feedback');
}

// ---- 결과 -----------------------------------------------------------------
async function showEnd() {
  clearInterval(timerId);
  showView('view-end');

  const [{ data: room }, { data: rows, error }] = await Promise.all([
    sb.from('rooms').select('status, results_revealed').eq('id', me.roomId).single(),
    sb.rpc('get_leaderboard', { p_room_id: me.roomId }),
  ]);
  if (error) { setMessage(errText(error)); return; }

  const mine = rows.find(r => r.is_me);
  $('my-score').textContent = mine ? `${mine.score}점` : '-';
  $('my-rank').textContent = mine ? `${mine.rank}위` : '-';
  $('my-correct').textContent = mine ? `${mine.correct_count}개` : '-';

  const ended = room && room.status === 'ended';
  let note = '';
  if (!ended) {
    note = '모든 문제를 풀었어요. 선생님이 게임을 끝내면 최종 순위가 확정돼요.';
  } else if (!room.results_revealed) {
    note = '선생님이 순위를 공개하면 전체 순위를 볼 수 있어요.';
  }
  $('end-note').textContent = note;

  const revealed = !!(room && room.results_revealed);
  $('all-table').classList.toggle('hidden', !revealed);
  const body = $('all-body');
  body.innerHTML = '';
  if (revealed) {
    rows.forEach(r => {
      const tr = document.createElement('tr');
      if (r.is_me) tr.className = 'me-row';
      [r.rank, r.nickname, r.score, r.correct_count].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i !== 1) td.className = 'num';
        tr.append(td);
      });
      body.append(tr);
    });
  }
}

$('submit-btn').onclick = () => submit(false);
$('q-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submit(false);
});
$('next-btn').onclick = () => route();

init();
