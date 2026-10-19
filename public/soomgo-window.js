// '숨고 창': 서버에서 도는 숨고 크롬 탭을 이 창에 실시간으로 보여주고, 이 창에서 누르고 밀고 키보드로 친 것을 그 탭에 그대로 넣는다.
// 서버는 탭 크기를 이 창 크기에 맞추고, 화면이 바뀔 때마다 그림을 보낸다(/api/soomgo/stream). 동작은 /api/soomgo/input으로 보낸다.
const cv = document.getElementById('cv');
const g = cv.getContext('2d');
const bar = document.getElementById('bar');
const msg = document.getElementById('msg');
const addr = document.getElementById('addr');
const tabsSel = document.getElementById('tabs');
const toastEl = document.getElementById('toast');
const aiBar = document.getElementById('ai');
// 키보드 입력을 받는 숨은 칸: 보통 칸용, 비밀번호 칸용(휴대폰 키보드가 비밀번호를 배우거나 추천하지 않게)
const kb = document.getElementById('kb');
const kbpw = document.getElementById('kbpw');

// 서버에서 그림을 받는 연결, 서버 탭의 크기, 서버 탭의 입력칸 자리 [왼쪽, 위, 폭, 높이, 비밀번호 칸이면 1]
let es = null;
let size = null;
let fields = [];
// 문의 화면에서 '숨고 창에서 보기'로 왔으면 그 채팅방 탭을 먼저 보여준다 (처음 한 번만)
let chat = new URLSearchParams(location.hash.slice(1)).get('chat') || '';

// 가운데 안내를 보여주거나(글이 있으면) 숨긴다
function show(html) {
  msg.innerHTML = html;
  msg.hidden = !html;
}
// 아래쪽에 알림을 2.5초 동안 띄운다
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 2500);
}

// 숨고를 보여줄 자리의 크기(위쪽 줄과 아래쪽 AI 비서 줄을 뺀 나머지)와 선명도
const area = () => ({ w: Math.round(innerWidth), h: Math.round(innerHeight - bar.offsetHeight - aiBar.offsetHeight), dpr: Math.min(2, Math.max(1, devicePixelRatio || 1)) });
// 서버 탭을 그림판 어디에 얼마나 줄여 그리는지. 창에 맞춘 탭이면 꽉 차고, AI가 일하는 큰 탭이면 비율을 지켜 줄인다
let box = { s: 1, x: 0, y: 0 };
function layout() {
  const a = area();
  const v = size || a;
  const s = Math.min(a.w / v.w, a.h / v.h);
  box = { s, x: (a.w - v.w * s) / 2, y: 0 };
}
// 마지막으로 받은 그림. 그림판 크기가 바뀌면 새 그림이 올 때까지 이것을 늘려 그려 둔다
let lastImg = null;
// 그림판 크기를 맞춘다. 선명하게 보이도록 실제 점 수는 선명도만큼 키운다
function fitCanvas(a) {
  cv.width = a.w * a.dpr;
  cv.height = a.h * a.dpr;
  cv.style.width = `${a.w}px`;
  cv.style.height = `${a.h}px`;
  layout();
  if (lastImg) paint(lastImg);
}
// 그림을 그림판에 그린다. 남는 자리는 회색으로 둔다
function paint(im) {
  const d = cv.width / parseFloat(cv.style.width);
  g.fillStyle = '#e9eceb';
  g.fillRect(0, 0, cv.width, cv.height);
  const v = size || area();
  g.drawImage(im, box.x * d, box.y * d, v.w * box.s * d, v.h * box.s * d);
}

// ---------- 서버에서 받기 ----------
// 연결한다. 창 크기와 먼저 볼 채팅방을 알려준다.
// 서버의 숨고 창이 막 뜨는 중이거나(켜기, 숨고 계정 바꾸기, 비서 재시작) 잠깐 닫힌 것일 수 있어, 닫혀 있다고 하면 2초 간격으로 5번까지 다시 해 본다
let retries = 5;
function connect() {
  es?.close();
  const a = area();
  fitCanvas(a);
  size = a;
  es = new EventSource(`/api/soomgo/stream?w=${a.w}&h=${a.h}&dpr=${a.dpr}&chat=${encodeURIComponent(chat)}`);
  chat = '';
  es.addEventListener('frame', (e) => draw(e.data));
  es.addEventListener('info', (e) => info(JSON.parse(e.data)));
  es.addEventListener('fields', (e) => (fields = JSON.parse(e.data)));
  es.addEventListener('status', (e) => aiStatus(JSON.parse(e.data)));
  es.addEventListener('closed', (e) => {
    es.close();
    es = null;
    const { reason } = JSON.parse(e.data);
    if (reason === 'off' && retries-- > 0) return setTimeout(connect, 2000);
    show(
      reason === 'replaced'
        ? '다른 곳에서 숨고 창을 열어서 여기는 멈췄습니다.<br>다시 보려면 위쪽 ⟳ 를 누르세요.'
        : '숨고 창이 닫혀 있습니다.<br>비서 화면에서 "숨고 채팅 자동 응대"를 켜면 열립니다.<br><br><a href="/">비서 화면으로</a>',
    );
  });
  // 끊기면 브라우저가 알아서 다시 연결한다. 접속 비밀번호가 풀린 것이면 비서 첫 화면으로 보낸다
  es.onerror = async () => {
    const r = await fetch('/api/state').catch(() => null);
    if (r?.status === 401) location.href = '/';
  };
}

// 받은 그림을 그린다. 늦게 도착한 옛 그림이 새 그림을 덮지 않게 순서를 센다
let seq = 0;
let drawn = 0;
function draw(b64) {
  const n = ++seq;
  const im = new Image();
  im.onload = () => {
    if (n < drawn) return;
    drawn = n;
    lastImg = im;
    paint(im);
    show('');
    retries = 5;
  };
  im.src = `data:image/jpeg;base64,${b64}`;
}

// 탭 정보: 주소 줄과, 탭이 둘 이상이면 탭 고르는 칸
function info(d) {
  size = d.size;
  layout();
  try {
    const u = new URL(d.url);
    addr.textContent = u.protocol.startsWith('http') ? `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}` : '숨고';
  } catch {
    addr.textContent = '숨고';
  }
  tabsSel.innerHTML = d.tabs
    .map((t, i) => `<option value="${t.id}" ${t.id === d.id ? 'selected' : ''}>${i + 1}. ${t.auto ? '채팅 확인용' : (t.title || '탭').replace(/[<>&"]/g, '').slice(0, 20)}</option>`)
    .join('');
  tabsSel.hidden = d.tabs.length < 2;
}

// ---------- 서버로 보내기 ----------
// 보낼 동작을 차례로 하나씩 보낸다. 앞의 것을 보내는 동안 쌓인 밀기·글자는 하나로 합친다
const queue = [];
let sending = false;
function push(a) {
  const t = queue.at(-1);
  if (t?.type === 'scroll' && a.type === 'scroll') Object.assign(t, { x: a.x, y: a.y, dx: t.dx + a.dx, dy: t.dy + a.dy });
  else if (t?.type === 'move' && a.type === 'move') Object.assign(t, { x: a.x, y: a.y });
  else if (t?.type === 'edit' && a.type === 'edit') {
    // 앞의 글자 고치기에 이어 붙인다: 지울 글자가 앞에서 넣을 글자 안이면 거기서 지우고, 넘치면 더 지운다
    if (a.del <= t.text.length) t.text = t.text.slice(0, t.text.length - a.del) + a.text;
    else Object.assign(t, { del: t.del + a.del - t.text.length, text: a.text });
  } else queue.push(a);
  pump();
}
async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const a = queue.shift();
    try {
      const r = await fetch('/api/soomgo/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
      if (r.status === 401) return (location.href = '/');
      if (!r.ok) toast((await r.json().catch(() => ({}))).error || '숨고 창에 전하지 못했습니다.');
    } catch {
      toast('연결이 끊겼습니다. 잠시 뒤 다시 해 주세요.');
    }
  }
  sending = false;
}

// 이 창에서의 자리를 숨고 탭의 자리로 바꾼다
function toPage(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left - box.x) / box.s, (e.clientY - r.top - box.y) / box.s];
}

// 아래쪽 줄: AI 비서가 지금 하는 일. 하는 일이 없으면 마지막 확인 시각과 최근에 끝낸 일을 보여준다
const hhmm = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
function aiStatus(c) {
  const [cls, text] =
    c.state === 'off' ? ['', '꺼져 있습니다.']
    : c.state === 'login' ? ['wait', '숨고 로그인이 필요합니다. 이 창에서 로그인해 주세요.']
    : c.state === 'error' ? ['bad', c.message]
    : c.work ? ['work', c.work]
    : c.checking ? ['work', '채팅 목록을 확인하는 중입니다.']
    : c.state === 'ok' ? ['on', `새 채팅방을 기다리는 중${c.lastCheck ? ` · 마지막 확인 ${hhmm(c.lastCheck)}` : ''}${c.done ? ` · 최근 ${hhmm(c.done.at)} ${c.done.text}` : ''}`]
    : ['wait', '숨고 창을 여는 중입니다.'];
  document.getElementById('aiDot').className = `dot ${cls}`;
  document.getElementById('aiText').textContent = text;
}

// ---------- 누르기와 밀기 ----------
// 손가락을 대고 8픽셀 넘게 움직이면 밀기, 아니면 누르기로 본다
let touch = null;
cv.addEventListener('pointerdown', (e) => {
  // 기본 동작을 막아야 키보드 칸에서 초점이 빠지지 않는다
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  touch = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
});
cv.addEventListener('pointermove', (e) => {
  if (!touch) {
    // 마우스는 올려 두기만 해도 숨고에 전한다. 마우스를 올리면 열리는 메뉴(프로필 메뉴 등)가 열리게
    if (e.pointerType === 'mouse') {
      const [x, y] = toPage(e);
      push({ type: 'move', x, y });
    }
    return;
  }
  if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) touch.moved = true;
  if (!touch.moved) return;
  // 손가락을 위로 올리면 화면이 아래로 내려간다
  const [x, y] = toPage(e);
  push({ type: 'scroll', x, y, dx: touch.lx - e.clientX, dy: touch.ly - e.clientY });
  touch.lx = e.clientX;
  touch.ly = e.clientY;
});
cv.addEventListener('pointerup', (e) => {
  const t = touch;
  touch = null;
  if (!t || t.moved) return;
  const [x, y] = toPage(e);
  push({ type: 'tap', x, y });
  // 입력칸을 눌렀으면 휴대폰 키보드를 띄우고, 아니면 내린다. 누른 그 순간에 해야 휴대폰이 키보드를 띄워 준다
  const f = fields.find(([fx, fy, fw, fh]) => x >= fx && x <= fx + fw && y >= fy && y <= fy + fh);
  if (f) startTyping(f[4] ? kbpw : kb, e.clientY);
  else stopTyping();
});
cv.addEventListener('pointercancel', () => (touch = null));
// 컴퓨터에서는 마우스 휠로 민다
cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const [x, y] = toPage(e);
    push({ type: 'scroll', x, y, dx: e.deltaX, dy: e.deltaY });
  },
  { passive: false },
);

// ---------- 키보드 ----------
// 숨은 칸에 친 글자를 바로 전과 비교해, 지운 만큼과 새로 넣은 글자를 숨고 탭에 보낸다.
// 한글처럼 조합 중인 글자는 바뀔 때마다 '한 글자 지우고 새 글자 넣기'로 보내서 최종 글자가 남는다.
// 칸이 비어 있으면 지우기 키를 눌러도 아무 일이 일어나지 않으므로 빈칸 8개를 미리 넣어 둔다
const PAD = '        ';
let typing = null;
let last = '';
let composing = false;
function startTyping(el, y) {
  if (typing && typing !== el) typing.blur();
  typing = el;
  // 누른 높이에 두어 휴대폰이 엉뚱한 곳으로 화면을 옮기지 않게 한다
  el.style.top = `${Math.max(0, Math.min(innerHeight - 30, y - 12))}px`;
  el.value = last = PAD;
  el.focus({ preventScroll: true });
  el.setSelectionRange(PAD.length, PAD.length);
}
function stopTyping() {
  typing?.blur();
  typing = null;
}
function sync(el) {
  const v = el.value;
  let i = 0;
  while (i < last.length && i < v.length && last[i] === v[i]) i++;
  const del = last.length - i;
  const text = v.slice(i);
  last = v;
  if (del || text) push({ type: 'edit', del, text });
  // 칸이 거의 비었거나 너무 길어지면 조합 중이 아닐 때 다시 채워 둔다
  if (!composing && (v.length < 3 || v.length > 400)) {
    el.value = last = PAD;
    el.setSelectionRange(PAD.length, PAD.length);
  }
}
for (const el of [kb, kbpw]) {
  el.addEventListener('compositionstart', () => (composing = true));
  el.addEventListener('compositionend', () => ((composing = false), sync(el)));
  el.addEventListener('input', () => sync(el));
  el.addEventListener('blur', () => typing === el && (typing = null));
}
// 비밀번호 칸은 한 줄 칸이라 Enter가 글자로 들어오지 않으므로 따로 보낸다 (보통 칸은 줄바꿈 글자가 Enter로 바뀌어 간다)
kbpw.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  push({ type: 'key', key: 'Enter' });
});

// ---------- 위쪽 줄 ----------
document.getElementById('back').onclick = () => push({ type: 'back' });
// 새로고침: 연결이 끊겨 있으면 다시 연결하고, 아니면 숨고 탭을 새로고침한다
document.getElementById('reload').onclick = () => (es ? push({ type: 'reload' }) : connect());
// 닫기: 이 창을 닫는다. 직접 연 창이라 닫히지 않으면 비서 화면으로 간다
document.getElementById('close').onclick = () => {
  window.close();
  setTimeout(() => (location.href = '/'), 300);
};
tabsSel.onchange = () => push({ type: 'tab', id: Number(tabsSel.value) });

// ---------- 창 크기와 숨김 ----------
// 키보드가 올라오거나 화면을 돌려 창 크기가 바뀌면 숨고 탭 크기도 맞춘다
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const a = area();
    fitCanvas(a);
    if (es) push({ type: 'resize', ...a });
  }, 150);
});
// 다른 앱이나 탭으로 가면 연결을 끊어(숨고 탭은 원래 크기로 돌아간다) 데이터를 아끼고, 돌아오면 다시 연결한다
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    es?.close();
    es = null;
  } else if (!es) connect();
});

// 시작: 비서에 접속돼 있는지 먼저 보고, 아니면 접속 비밀번호를 넣는 첫 화면으로 보낸다
const r = await fetch('/api/state').catch(() => null);
if (r?.status === 401) show('먼저 비서 화면에서 접속 비밀번호를 넣어 주세요.<br><br><a href="/">비서 화면으로</a>');
else connect();
