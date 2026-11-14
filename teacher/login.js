// login.js : 교사 비밀코드 로그인
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const form = document.getElementById('login-form');
const submitBtn = document.getElementById('submit-btn');
const msg = document.getElementById('msg');
const pins = [...document.querySelectorAll('.pin-input')];

let locked = false;
let lockTimer = null;

function setMessage(text, isError = true) {
  msg.textContent = text;
  msg.className = text ? (isError ? 'msg-error' : 'msg-ok') : '';
}

function getCode() {
  return pins.map(p => p.value).join('');
}

function clearPins() {
  pins.forEach(p => { p.value = ''; });
  pins[0].focus();
}

function setInputsDisabled(disabled) {
  submitBtn.disabled = disabled;
  pins.forEach(p => { p.disabled = disabled; });
}

// 칸 이동: 숫자 한 자리 입력 후 다음 칸으로, 빈 칸에서 Backspace는 이전 칸으로
pins.forEach((el, i) => {
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(0, 1);
    if (el.value && i < pins.length - 1) pins[i + 1].focus();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !el.value && i > 0) pins[i - 1].focus();
  });
  el.addEventListener('paste', e => {
    e.preventDefault();
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
    digits.split('').forEach((d, j) => { pins[j].value = d; });
    pins[Math.min(digits.length, 3)].focus();
  });
});

// 서버가 알려 준 잠금 시간만큼 카운트다운
function startLock(seconds) {
  locked = true;
  setInputsDisabled(true);
  let left = seconds;

  const tick = () => {
    if (left <= 0) {
      clearInterval(lockTimer);
      locked = false;
      setInputsDisabled(false);
      setMessage('');
      clearPins();
      return;
    }
    setMessage(`5회 틀렸어요. ${left}초 후에 다시 입력할 수 있어요.`);
    left -= 1;
  };

  tick();
  lockTimer = setInterval(tick, 1000);
}

// 익명 세션이 없으면 먼저 만든다 (교사 권한은 비밀코드 검증 후 부여)
async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) return;
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw error;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (locked) return;

  const code = getCode();
  if (!/^\d{4}$/.test(code)) {
    setMessage('비밀코드 4자리를 모두 입력하세요.');
    return;
  }

  submitBtn.disabled = true;
  try {
    await ensureSession();
    const { data, error } = await sb.rpc('teacher_login', { p_secret: code });
    if (error) throw error;

    if (data.ok) {
      location.href = './dashboard.html';
      return;
    }
    if (data.error === 'LOCKED') {
      startLock(data.retry_after ?? 30);
      return;
    }
    setMessage(`비밀코드가 맞지 않아요. (남은 기회 ${data.remaining}회)`);
    clearPins();
  } catch (err) {
    console.error(err);
    setMessage('연결에 문제가 있어요. 잠시 후 다시 시도하세요.');
  } finally {
    if (!locked) submitBtn.disabled = false;
  }
});

// 페이지 진입 시 익명 세션을 미리 준비
ensureSession().catch(err => console.error(err));
