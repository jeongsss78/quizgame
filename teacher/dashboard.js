// dashboard.js : 교사 방 만들기, 대기실, 진행, 결과
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);

const ROOM_KEY = 'teacherRoomId';
const STUDENT_URL = new URL('../student/index.html', location.href).href;
const VIEWS = ['view-home', 'view-lobby', 'view-play', 'view-result'];
const STATUS_TEXT = { waiting: '대기 중', running: '진행 중', ended: '종료' };
const CHAR_NAMES = ['곰', '토끼', '고양이', '펭귄', '여우', '사자', '개구리', '부엉이'];
const ERRORS = {
  FORBIDDEN: '교사 권한이 없어요. 다시 로그인해 주세요.',
  ROOM_NOT_FOUND: '방을 찾을 수 없어요.',
  INVALID_STATUS: '지금 상태에서는 할 수 없는 작업이에요.',
  ROOM_NOT_ENDED: '게임이 끝난 뒤에 결과를 공개할 수 있어요.',
};

let room = null;        // 현재 방 (rooms 행)
let channel = null;     // Realtime 구독
let clockTimer = null;  // 화면 시계 갱신
let autoEnding = false; // 시간 만료 자동 종료 중복 방지

function showView(id) {
  VIEWS.forEach(v => $(v).classList.toggle('hidden', v !== id));
}

function setMessage(text, isError = true) {
  $('msg').textContent = text;
  $('msg').className = text ? (isError ? 'msg-error' : 'msg-ok') : '';
}

function errText(err) {
  return ERRORS[err && err.message] || '문제가 생겼어요. 잠시 후 다시 시도하세요.';
}

function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

// 교사 권한 확인: 아니면 로그인 화면으로
async function guard() {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) { location.href = './index.html'; return false; }
  const { data, error } = await sb.rpc('is_teacher');
  if (error || !data) { location.href = './index.html'; return false; }
  return true;
}

// ---- 홈: 방 목록 ------------------------------------------------------
async function loadRooms() {
  const { data, error } = await sb.from('rooms')
    .select('id, code, duration_min, status, created_at')
    .order('created_at', { ascending: false });
  if (error) { setMessage(errText(error)); return; }

  const list = $('room-list');
  list.innerHTML = '';
  if (!data.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '아직 만든 방이 없어요.';
    list.append(li);
    return;
  }
  data.forEach(r => {
    const li = document.createElement('li');
    li.className = 'rec-item';
    const label = document.createElement('span');
    label.textContent = `${r.code} · ${r.duration_min}분 · ${STATUS_TEXT[r.status]} · ${fmtDate(r.created_at)}`;
    li.append(label);
    li.append(mkBtn('열기', 'btn', () => openRoom(r.id)));
    li.append(mkBtn('삭제', 'btn btn-danger', () => deleteRoom(r.id, r.code)));
    list.append(li);
  });
}

async function createRoom() {
  $('create-btn').disabled = true;
  const { data, error } = await sb.rpc('create_room', {
    p_duration_min: Number($('duration').value),
  });
  $('create-btn').disabled = false;
  if (error) { setMessage(errText(error)); return; }
  await openRoom(data.room_id);
}

async function deleteRoom(id, code) {
  if (!confirm(`방 ${code}을(를) 삭제할까요? 참가자와 답안 기록이 모두 지워집니다.`)) return;
  if (!confirm('정말 삭제합니다. 되돌릴 수 없어요.')) return;
  const { error } = await sb.rpc('delete_room', { p_room_id: id });
  if (error) { setMessage(errText(error)); return; }
  setMessage('방을 삭제했어요.', false);
  loadRooms();
}

async function deleteAll() {
  const word = prompt('모든 방 기록을 지웁니다. 확인하려면 "삭제"를 입력하세요.');
  if (word !== '삭제') return;
  const { data, error } = await sb.rpc('delete_all_my_rooms');
  if (error) { setMessage(errText(error)); return; }
  setMessage(`방 ${data}개를 삭제했어요.`, false);
  loadRooms();
}

function goHome() {
  room = null;
  autoEnding = false;
  unsubscribe();
  clearInterval(clockTimer);
  localStorage.removeItem(ROOM_KEY);
  showView('view-home');
  loadRooms();
}

async function logout() {
  await sb.auth.signOut();
  location.href = './index.html';
}

// ---- 방 열기: 상태에 따라 대기실, 진행, 결과 중 하나로 ---------------
async function openRoom(id) {
  setMessage('');
  const { data, error } = await sb.from('rooms').select('*').eq('id', id).single();
  if (error) { setMessage(errText(error)); return; }
  room = data;
  localStorage.setItem(ROOM_KEY, room.id);
  if (room.status === 'waiting') return enterLobby();
  if (room.status === 'running') return enterPlay();
  return enterResult();
}

// ---- 대기실 -------------------------------------------------------------
function enterLobby() {
  showView('view-lobby');
  $('room-code').textContent = room.code;
  QRCode.toCanvas($('qr'), `${STUDENT_URL}?code=${room.code}`, { width: 360, margin: 2 }, err => {
    if (err) setMessage('QR 코드를 만들 수 없어요.');
  });
  loadPlayers();
  subscribe();
}

async function loadPlayers() {
  const { data, error } = await sb.from('players')
    .select('nickname, character_id, joined_at')
    .eq('room_id', room.id)
    .order('joined_at');
  if (error) return;
  $('player-count').textContent = `(${data.length}명)`;
  const ul = $('player-list');
  ul.innerHTML = '';
  data.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${CHAR_NAMES[p.character_id - 1]} · ${p.nickname}`;
    ul.append(li);
  });
}

async function startRoom() {
  $('start-btn').disabled = true;
  const { data, error } = await sb.rpc('start_room', { p_room_id: room.id });
  $('start-btn').disabled = false;
  if (error) { setMessage(errText(error)); return; }
  room = { ...room, ...data };
  enterPlay();
}

// ---- 진행 화면 ----------------------------------------------------------
function enterPlay() {
  showView('view-play');
  autoEnding = false;
  subscribe();
  loadProgress();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 250);
  tick();
}

// 시작 전에는 카운트다운, 시작 후에는 남은 시간을 표시
function tick() {
  const now = Date.now();
  const start = new Date(room.started_at).getTime();
  const end = new Date(room.ends_at).getTime();

  if (now < start) {
    $('phase-label').textContent = `${Math.ceil((start - now) / 1000)}초 후 시작`;
    $('timer').textContent = fmtTime(room.duration_min * 60);
    return;
  }

  const left = Math.max(0, Math.floor((end - now) / 1000));
  $('phase-label').textContent = '남은 시간';
  $('timer').textContent = fmtTime(left);
  if (left === 0 && !autoEnding) {
    autoEnding = true;
    endRoom();
  }
}

async function loadProgress() {
  const [{ data: players }, { data: answers }] = await Promise.all([
    sb.from('players').select('id, nickname').eq('room_id', room.id).order('joined_at'),
    sb.from('answers').select('player_id').eq('room_id', room.id),
  ]);
  if (!players || !answers) return;

  const total = room.question_order.length;
  const counts = {};
  answers.forEach(a => { counts[a.player_id] = (counts[a.player_id] || 0) + 1; });

  const body = $('progress-body');
  body.innerHTML = '';
  players.forEach(p => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = p.nickname;
    const num = document.createElement('td');
    num.className = 'num';
    num.textContent = `${counts[p.id] || 0} / ${total}`;
    tr.append(name, num);
    body.append(tr);
  });

  const done = answers.length;
  const all = players.length * total;
  $('progress-text').textContent = `${done} / ${all}`;
  $('progress-bar').style.width = all ? `${(done / all) * 100}%` : '0%';
}

async function endRoom() {
  const { error } = await sb.rpc('end_room', { p_room_id: room.id });
  if (error) {
    autoEnding = false;
    setMessage(errText(error));
    return;
  }
  room.status = 'ended';
  enterResult();
}

// ---- 결과 화면 ----------------------------------------------------------
async function enterResult() {
  showView('view-result');
  clearInterval(clockTimer);
  unsubscribe();

  $('reveal-btn').disabled = room.results_revealed;
  $('reveal-btn').textContent = room.results_revealed ? '순위 공개됨' : '학생에게 순위 공개';
  $('reveal-state').textContent = room.results_revealed
    ? '학생 화면에 전체 순위가 공개되었어요.'
    : '아직 학생 화면에는 순위가 나오지 않아요.';

  const { data, error } = await sb.rpc('get_leaderboard', { p_room_id: room.id });
  if (error) { setMessage(errText(error)); return; }
  renderRank(data);
}

async function revealResults() {
  const { error } = await sb.rpc('reveal_results', { p_room_id: room.id });
  if (error) { setMessage(errText(error)); return; }
  room.results_revealed = true;
  enterResult();
}

function renderRank(rows) {
  const podium = $('podium');
  podium.innerHTML = '';
  rows.slice(0, 3).forEach(r => {
    const box = document.createElement('div');
    box.className = 'podium-item';
    const rank = document.createElement('p');
    rank.className = 'rank';
    rank.textContent = `${r.rank}위 · ${r.nickname}`;
    const score = document.createElement('p');
    score.className = 'score';
    score.textContent = `${r.score}점`;
    box.append(rank, score);
    podium.append(box);
  });

  const body = $('rank-body');
  body.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    [r.rank, r.nickname, r.score, r.correct_count].forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i !== 1) td.className = 'num';
      tr.append(td);
    });
    body.append(tr);
  });
}

// ---- Realtime -----------------------------------------------------------
function subscribe() {
  unsubscribe();
  channel = sb.channel(`teacher-${room.id}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'players', filter: `room_id=eq.${room.id}` },
      () => loadPlayers())
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'answers', filter: `room_id=eq.${room.id}` },
      () => loadProgress())
    .subscribe();
}

function unsubscribe() {
  if (channel) {
    sb.removeChannel(channel);
    channel = null;
  }
}

// ---- 시작 ---------------------------------------------------------------
(async function init() {
  const ok = await guard();
  if (!ok) return;

  $('create-btn').onclick = createRoom;
  $('delete-all-btn').onclick = deleteAll;
  $('logout-btn').onclick = logout;
  $('start-btn').onclick = startRoom;
  $('lobby-back').onclick = goHome;
  $('end-btn').onclick = () => endRoom();
  $('reveal-btn').onclick = revealResults;
  $('result-home').onclick = goHome;

  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) await openRoom(saved);
  if (!room) goHome();
})();
