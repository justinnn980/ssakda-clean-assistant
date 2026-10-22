// 휴대폰·컴퓨터 브라우저에서 돌아가는 화면 코드. 서버(/api/...)에서 자료를 받아 화면을 그린다
// 금액 계산은 서버와 같은 파일(pricing.js)을 쓴다
import { calc, won, rangeText, customerPrice } from '/pricing.js';

// 화면 내용을 그려 넣을 자리와, 아래쪽에 잠깐 뜨는 알림 자리
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
// 서버에서 받은 단가 설정
let config = null;
// 카카오톡 알림 연결 상태
let kakaoState = null;
// 화면을 주기적으로 새로 고치는 타이머
let pollTimer = null;
let focusCard = null; // 설정 화면을 열 때 바로 보여줄 칸
// 견적 기능(숨고 받은 요청 확인, 예상 금액, 견적 보내기)을 보여줄지. 서버가 알려준다 (지금은 꺼 두고 숨겼다)
let quoteFeatures = true;
// 서버(사무실 맥북)에서 도는지. 서버에서는 노트북 전용 기능(밖에서 접속하기, 카톡 일감 잡기, 프로그램 끄기)을 숨기고,
// 숨고 채팅은 PC 크롬의 '싹다클린 AI 비서' 확장이 맡는다
let serverMode = false;
// 서버에 있는 확장의 버전 (이 브라우저의 확장이 그와 다르면 업데이트하라고 알린다), 크롬 웹스토어 주소(올렸을 때만)
let extLatest = '';
let extStore = '';
// 이 브라우저에 설치된 확장의 버전. 없으면 빈 글 (확장의 site.js가 표시해 둔다)
const extVersion = () => document.documentElement.dataset.ssakdaExt || '';
// 확장에 일을 시킨다: start(켜기, 숨고 창을 띄움), stop(끄기), open(창 열기), show(그 채팅방 탭 보기)
const extSend = (cmd, extra = {}) => window.postMessage({ source: 'ssakda-site', cmd, ...extra }, location.origin);
// 서버와 노트북에서 다른 안내: 숨고에 로그인하는 곳, 숨고 확인이 멈췄을 때 볼 곳
const loginWhere = () => (serverMode ? 'PC 크롬에 열린 숨고 창에서 로그인하면 바로 시작합니다.' : '노트북에 열린 크롬 창에서 로그인하면 바로 시작합니다.');
const stallHint = () => (serverMode ? 'PC가 켜져 있는지, 크롬과 숨고 창이 열려 있는지 확인해 주세요. <a href="#/guide">사용 안내</a>' : '노트북이 켜져 있는지, 숨고 크롬 창이 열려 있는지 확인해 주세요.');

// 서버가 쓰는 영어 값을 화면에 보여줄 한글로 바꾸는 표: 문의 상태, 위험도, 필요 여부
const STATUS = { analyzing: '분석 중', awaiting_owner: '승인 대기', sent: '전송 완료', on_hold: '보류', rejected: '거절', booked: '예약 확정', error: '분석 실패' };
const RISK = { low: '일반', review: '확인 필요', high: '사장님 검토 필수' };
const YN = { yes: '필요', no: '불필요', unknown: '현장 확인 필요' };

// 고객이 쓴 글에 든 < > 같은 기호가 화면 코드로 읽히지 않도록 안전한 글자로 바꾼다
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// 시각을 "10. 13. 오후 03:30"처럼 짧게 적는다
const when = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 화면 아래에 알림 글을 2.5초 동안 띄운다
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 2500);
}

// 서버에 요청을 보낸다. body가 있으면 보내기(POST), 없으면 가져오기(GET). 로그인이 풀렸으면 로그인 화면을 띄우고, 서버가 오류를 알려주면 그 문구를 오류로 넘긴다
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401 && path !== '/api/login') {
    renderLogin();
    throw new Error('로그인이 필요합니다.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || '요청을 처리하지 못했습니다.');
  return json;
}

// https가 아닌 주소(집 와이파이, Tailscale)에서도 복사가 되도록 예비 방법을 둔다
async function copyText(text) {
  // 먼저 브라우저의 복사 기능을 써 본다
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 안 되면 보이지 않는 글 칸을 만들어 거기에 글을 넣고 선택해서 복사한다
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// 휴대폰 사진은 크기가 커서 올리기 전에 줄인다
async function shrink(file) {
  // 긴 쪽이 1800픽셀을 넘으면 그 크기로 줄이고, JPG(품질 85%)로 바꿔 글자 형태로 돌려준다
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}
// 고른 사진들을 모두 줄여서 돌려준다
const readImages = (input) => Promise.all([...input.files].map(shrink));

// ---------- 로그인 ----------
// 접속 비밀번호를 넣는 화면을 그린다
function renderLogin() {
  // 다른 화면에서 돌던 새로 고침을 멈춘다
  clearInterval(pollTimer);
  app.innerHTML = `<div class="card"><h2>접속 비밀번호</h2>
    <p class="muted">사장님이 받은 접속 비밀번호(숫자)를 넣어 주세요.</p>
    <input id="pin" type="password" inputmode="numeric" autocomplete="current-password">
    <p><button class="btn primary block" id="go">들어가기</button></p></div>`;
  // 비밀번호를 서버에 보내고, 맞으면 처음부터 다시 시작한다. 틀리면 알림을 띄운다
  const go = async () => {
    try {
      await api('/api/login', { pin: document.getElementById('pin').value });
      await boot();
    } catch (e) {
      toast(e.message);
    }
  };
  // 버튼을 누르거나 Enter를 치면 들어간다
  document.getElementById('go').onclick = go;
  // false를 돌려주면 키 입력이 취소되어 키보드로 숫자가 들어가지 않는다
  document.getElementById('pin').onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
}

// ---------- 목록 ----------
// 숨고 자동 확인이 잘 되고 있을 때, 마지막으로 언제 확인했고 새 문의가 없으면 왜 없는지 알려준다
function soomgoOkText(sg) {
  // 아직 한 번도 확인하지 않았을 때
  if (!sg.lastCheck) return '<span class="dot wait"></span>숨고 확인을 시작하는 중입니다.';
  // 마지막 확인이 8분 넘게 지났으면 멈춘 것으로 보고 알린다
  if (Date.now() - new Date(sg.lastCheck) > 8 * 60 * 1000)
    return `<span class="dot bad"></span><span class="err">숨고 확인이 ${when(sg.lastCheck)} 이후 멈춰 있습니다. ${stallHint()}</span>`;
  // 방금 확인에서 새 요청을 등록했는지에 따라 문구를 고른다
  const gotNew = sg.lastNew && sg.lastNew >= sg.lastCheck;
  const result = gotNew
    ? '새 요청을 등록했습니다.'
    : `${esc(sg.message)}${sg.message.includes('건 확인') ? ' · 모두 이미 등록한 요청이라 새로 등록할 것이 없습니다.' : ''}`;
  return `<span class="dot on"></span>숨고 자동 확인 · 마지막 확인 ${when(sg.lastCheck)}<br>${result}${!gotNew && sg.lastNew ? ` 마지막 새 요청 ${when(sg.lastNew)}` : ''}`;
}

// 자동 발송 결과를 한 줄로 적는다: 보냈음 / 발송 직전까지 준비 / 보내지 않은 사유. kind가 chat이면 채팅 첫 응대의 결과다
const autoSendText = (a, kind) =>
  kind === 'chat'
    ? a.sent ? `숨고 채팅에 첫 응대를 보냄 (${when(a.at)})` : a.prepared ? esc(a.reason) : `자동 응대 안 함: ${esc(a.reason)}`
    : a.sent ? `숨고에 자동 발송함 (${when(a.at)})` : a.prepared ? `발송 직전: ${esc(a.reason)}` : `자동 발송 안 함: ${esc(a.reason)}`;
// 숨고 채팅 첫 응대 방식의 화면 이름
const CHAT_MODE = { send: '자동으로 보내기', fill: '채팅창에 써 두고 멈춤 (전송은 직접)' };

// 숨고 채팅 자동 응대의 상태 한 줄: 꺼짐 / 잘 됨(마지막 확인) / 멈춤 / 로그인 필요 / 문제 / 여는 중
function chatLine(st) {
  const c = st.chat;
  if (!st.settings.chat) return '<span class="dot"></span>꺼져 있습니다. 숨고 채팅을 확인하지 않고 답장도 보내지 않습니다.';
  // 서버에서는 PC 크롬 확장이 1분마다 연락한다. 3분 넘게 연락이 없으면 PC나 크롬이 꺼진 것이다
  if (serverMode && !(c.seenAt && Date.now() - new Date(c.seenAt) < 3 * 60 * 1000))
    return '<span class="dot bad"></span><span class="err">PC 크롬에서 비서가 동작하지 않고 있습니다.</span> 확장을 설치한 PC에서 크롬을 켜 두세요. <a href="#/guide">사용 안내</a>';
  if (c.state === 'login') return `<span class="dot wait"></span>숨고 로그인이 필요합니다. ${loginWhere()}`;
  if (c.state === 'error') return `<span class="dot bad"></span><span class="err">${esc(c.message)}</span>`;
  if (c.state !== 'ok' || !c.lastCheck) return '<span class="dot wait"></span>숨고 창을 여는 중입니다.';
  // 마지막 확인이 5분 넘게 지났으면 멈춘 것으로 보고 알린다
  if (Date.now() - new Date(c.lastCheck) > 5 * 60 * 1000)
    return `<span class="dot bad"></span><span class="err">숨고 채팅 확인이 ${when(c.lastCheck)} 이후 멈춰 있습니다. ${stallHint()}</span>`;
  return `<span class="dot on"></span>${serverMode ? 'PC 크롬에서 ' : ''}숨고 채팅 확인 중 · 마지막 확인 ${when(c.lastCheck)}<br>${esc(c.work || c.message)}${c.lastNew ? ` · 마지막 새 채팅방 ${when(c.lastNew)}` : ''}`;
}
// 숨고 답변 보내는 방식의 화면 이름
const QUOTE_MODE = { off: '직접 보내기 (승인 후 복사)', fill: '발송 직전까지 자동 (숨고 창에 써 두고 멈춤)', send: '자동 발송 (확인 없이 보냄)' };

// 지금 고른 탭. 처음에는 '처리할 문의'
let listFilter = 'todo';
// 첫 화면(문의 목록)을 그린다
async function renderList() {
  // 서버에서 문의 목록을 받는다
  const items = await api('/api/inquiries');
  // 탭 이름과, 탭마다 보여줄 문의 상태
  const filters = { todo: '처리할 문의', sent: '전송 완료', booked: '예약', etc: '보류·거절' };
  const match = { todo: ['analyzing', 'awaiting_owner', 'error'], sent: ['sent'], booked: ['booked'], etc: ['on_hold', 'rejected'] };
  // 고른 탭에 해당하는 문의만 남긴다
  const shown = items.filter((i) => match[listFilter].includes(i.status));
  // 카카오톡 알림 안내: 준비가 안 됐으면 숨기고, 연결됐으면 '연결됨', 아니면 연결 버튼
  const kakaoNote = !kakaoState.configured
    ? ''
    : kakaoState.connected
      ? '<p class="muted">카카오톡 알림 연결됨</p>'
      : '<p><a class="btn small" href="/kakao/login">카카오톡 알림 연결하기</a></p>';
  // 스위치 상태와 숨고·카톡의 지금 상태를 받는다
  const st = await api('/api/state');
  const sg = st.soomgo;
  const on = st.settings.soomgo;
  // 첫 화면에서 비서를 켜고 끈다. 켜면 노트북에 숨고 창이 열리고, 로그인돼 있으면 바로 확인을 시작한다.
  const soomgoLine = !on
    ? '<span class="dot"></span>꺼져 있습니다. 숨고를 확인하지 않고 답변도 보내지 않습니다.'
    : sg.state === 'ok'
      ? soomgoOkText(sg)
      : sg.state === 'login'
        ? `<span class="dot wait"></span>숨고 로그인이 필요합니다. ${loginWhere()}`
        : sg.state === 'error'
          ? `<span class="dot bad"></span><span class="err">${esc(sg.message)}</span>`
          : '<span class="dot wait"></span>숨고 창을 여는 중입니다.';
  // 숨고 채팅 자동 응대 칸: 상태 한 줄, 답장 방식, 켜기·끄기 버튼
  const chatOn = st.settings.chat;
  // 서버에서는 켜져 있고 이 브라우저에 확장이 있으면 '창 열기'로 PC 크롬의 숨고 창을 앞에 띄운다. 확장이 없거나 옛 버전이면 알려 준다
  const ext = extVersion();
  const extNote = !serverMode
    ? ''
    : !ext
      ? '<div class="muted">이 브라우저에는 비서 확장이 없습니다. 실제 응대는 확장을 설치한 PC 크롬에서 합니다. <a href="#/guide">사용 안내</a></div>'
      : extLatest && ext !== extLatest
        ? '<div class="err">확장 새 버전이 있습니다. <a href="#/guide">사용 안내</a>의 "확장 업데이트"를 따라 해 주세요.</div>'
        : '';
  const chatNote = `<div class="card"><div class="setting"><div><h2>숨고 채팅 자동 응대</h2>
      <div class="muted">${chatLine(st)}</div>
      ${chatOn ? `<div class="muted">새 채팅방이 생기면: ${CHAT_MODE[st.settings.chatMode]} <a href="#/settings" id="chatEdit">바꾸기</a></div>` : ''}${extNote}</div>
      <div class="btns">${serverMode && chatOn && ext ? '<button class="btn primary" id="chatWin">창 열기</button>' : ''}<button class="btn ${chatOn ? 'danger' : 'primary'}" id="chatPower">${chatOn ? '끄기' : '켜기'}</button></div></div></div>`;
  // 숨고 비서 칸: 상태 한 줄, 답변 보내는 방식, 켜기·끄기 버튼
  const soomgoNote = `<div class="card"><div class="setting"><div><h2>숨고 비서</h2>
      <div class="muted">${soomgoLine}</div>
      ${on ? `<div class="muted">답변: ${QUOTE_MODE[st.settings.quoteMode]}</div>` : ''}</div>
      <button class="btn ${on ? 'danger' : 'primary'}" id="power">${on ? '끄기' : '켜기'}</button></div></div>`;
  // 카카오톡 채팅방을 지켜보다가 일감 글이 올라오면 바로 답하는 기능의 켜기·끄기와 최근 기록
  const tk = st.talk;
  const talkOn = st.settings.kakaoWatch;
  // 서버에서는 카카오톡이 있는 PC의 '카톡 일감 도우미'가 몇 초마다 연락한다. 30초 넘게 연락이 없으면 도우미나 PC가 꺼진 것이다
  const agentLive = !serverMode || Boolean(tk.seenAt && Date.now() - new Date(tk.seenAt) < 30 * 1000);
  const agentOff = '<span class="err">PC의 카톡 일감 도우미가 꺼져 있습니다.</span> 카카오톡이 있는 PC에서 바탕화면의 "카톡 일감 도우미"를 켜 주세요. <a href="#/guide/talk">사용 안내</a>';
  const talkLine = !talkOn
    ? `<span class="dot"></span>꺼져 있습니다. 카카오톡을 건드리지 않습니다.${agentLive ? '' : `<br>${agentOff}`}`
    : !agentLive
      ? `<span class="dot bad"></span>${agentOff}`
      : tk.state === 'ok'
        ? `<span class="dot on"></span>${serverMode ? (tk.pc ? `PC(${esc(tk.pc)})에서 ` : 'PC에서 ') : ''}${esc(tk.message)} · "${esc(st.settings.talk.keyword)}" 글이 오면 ${st.settings.talk.target === 'direct' ? '올린 사람에게 바로 개인톡을 보냅니다.' : '같은 방에 바로 답합니다.'}`
        : tk.state === 'error'
          ? `<span class="dot bad"></span><span class="err">${esc(tk.message)}</span>`
          : '<span class="dot wait"></span>카카오톡 창을 확인하는 중입니다.';
  // 지금 설정을 한 줄로 요약한다
  const tset = st.settings.talk;
  const talkSummary = tset.room
    ? `방 "${esc(tset.room)}" · 찾을 말 "${esc(tset.keyword)}" · ${tset.target === 'direct' ? '올린 사람에게 개인톡' : '같은 방에 답하기'}`
    : '지켜볼 채팅방이 아직 정해지지 않았습니다.';
  // 카톡 일감 잡기 칸: 상태, 설정 요약, 최근에 반응한 기록, 켜기·끄기 버튼
  const talkNote = `<div class="card"><div class="setting"><div><h2>카톡 일감 잡기</h2>
      <div class="muted">${talkLine}</div>
      <div class="muted">${talkSummary} <a href="#/settings" id="talkEdit">바꾸기</a></div>
      ${tk.events.map((ev) => `<div class="muted">${when(ev.at)} · ${esc(ev.text)} → ${ev.sent ? `${ev.to ? `${esc(ev.to)}님에게 개인톡 보냄` : '같은 방에 답장 보냄'} (${(ev.ms / 1000).toFixed(1)}초)` : `<span class="err">못 보냄: ${esc(ev.note)}</span>`}</div>`).join('')}</div>
      <button class="btn ${talkOn ? 'danger' : 'primary'}" id="talkPower">${talkOn ? '끄기' : '켜기'}</button></div></div>`;
  // 화면에 그린다: 숨고 칸, 카톡 칸, 탭(탭마다 문의 수), 문의 카드들(제목·상태·위험도·지역·시각), 카카오 알림 안내
  app.innerHTML = `${chatNote}${quoteFeatures ? soomgoNote : ''}${talkNote}<div class="tabs">${Object.entries(filters)
    .map(([k, v]) => `<button class="tab ${k === listFilter ? 'on' : ''}" data-f="${k}">${v} ${items.filter((i) => match[k].includes(i.status)).length}</button>`)
    .join('')}</div>
    ${shown.length ? '' : `<div class="card muted">해당하는 문의가 없습니다.${quoteFeatures ? ' 오른쪽 위 "새 문의"로 숨고 캡처를 올려주세요.' : ''}</div>`}
    ${shown
      .map(
        (i) => `<a class="card item" href="#/i/${i.id}">
        <div class="item-title">${esc(i.title)}</div>
        <div><span class="badge ${i.status === 'error' ? 'error' : 'state'}">${i.status === 'error' && i.autoSend ? '확인 필요' : STATUS[i.status]}</span>${i.risk ? `<span class="badge ${i.risk}">${RISK[i.risk]}</span>` : ''}</div>
        <div class="muted">${[esc(i.region || ''), when(i.updatedAt)].filter(Boolean).join(' · ')}</div>
        ${i.autoSend ? `<div class="muted">${autoSendText(i.autoSend, i.kind)}</div>` : ''}</a>`,
      )
      .join('')}${kakaoNote}`;
  // 탭을 누르면 그 탭으로 바꿔 다시 그린다
  app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => ((listFilter = b.dataset.f), renderList())));
  // '바꾸기'를 누르면 설정 화면의 카톡 칸으로 바로 가게 표시해 둔다
  document.getElementById('talkEdit').onclick = () => (focusCard = 'talkCard');
  // 카톡 일감 잡기 켜기·끄기 버튼. 서버에서는 PC 도우미가 몇 초 안에 받아 간다
  document.getElementById('talkPower').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/settings', { kakaoWatch: !talkOn });
      toast(talkOn ? '카톡 지켜보기를 껐습니다.' : serverMode ? '켰습니다. PC의 카톡 일감 도우미가 몇 초 안에 시작합니다.' : '카톡 지켜보기를 켰습니다.');
    } catch (err) {
      toast(err.message);
    }
    renderList();
  };
  // 숨고 채팅 자동 응대 켜기·끄기 버튼과, 답장 방식 '바꾸기'. 서버에서는 이 브라우저의 확장에도 알려, 켜면 숨고 창을 바로 띄운다
  document.getElementById('chatPower').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/settings', { chat: !chatOn });
      // 확장이 있는지는 누른 순간에 다시 본다 (확장이 화면보다 늦게 표시했을 수 있다)
      if (serverMode && extVersion()) extSend(chatOn ? 'stop' : 'start');
      toast(
        chatOn ? '채팅 자동 응대를 껐습니다.'
        : !serverMode ? '채팅 자동 응대를 켰습니다. 노트북의 크롬 창을 확인해 주세요.'
        : extVersion() ? '켰습니다. 숨고 창이 열립니다. 로그인 화면이면 로그인해 주세요.'
        : '켰습니다. 확장을 설치한 PC 크롬에서 1분 안에 시작합니다.',
      );
    } catch (err) {
      toast(err.message);
    }
    renderList();
  };
  const chatEdit = document.getElementById('chatEdit');
  if (chatEdit) chatEdit.onclick = () => (focusCard = 'chatCard');
  const chatWin = document.getElementById('chatWin');
  if (chatWin) chatWin.onclick = () => extSend('open');
  // 숨고 비서 켜기·끄기 버튼 (견적 기능을 숨기면 없다)
  if (quoteFeatures) document.getElementById('power').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/settings', { soomgo: !on });
      toast(on ? '비서를 껐습니다.' : '비서를 켰습니다.');
    } catch (err) {
      toast(err.message);
    }
    renderList();
  };
  // 얼마나 자주 새로 고칠지 정한다: 분석 중인 문의가 있거나 카톡을 지켜보는 중이면 5초, 숨고(채팅·받은 요청)가 잘 돌고 있으면 30초, 여는 중이면 5초, 다 꺼져 있으면 새로 고치지 않는다
  clearInterval(pollTimer);
  const soomgoOn = chatOn || (quoteFeatures && on);
  const soomgoOk = (!chatOn || st.chat.state === 'ok') && (!(quoteFeatures && on) || sg.state === 'ok');
  const every = items.some((i) => i.status === 'analyzing') || talkOn ? 5000 : !soomgoOn ? 0 : soomgoOk ? 30000 : 5000;
  // 첫 화면에 머물러 있을 때만 새로 고친다
  if (every) pollTimer = setInterval(() => location.hash.length <= 2 && renderList(), every);
}

// ---------- 새 문의 ----------
// 새 문의를 올리는 화면을 그린다
function renderNew() {
  clearInterval(pollTimer);
  app.innerHTML = `<div class="card"><h2>새 문의 등록</h2>
    <label>숨고 요청서 캡처·현장 사진 (여러 장 가능)</label>
    <input id="files" type="file" accept="image/*" multiple>
    <p></p>
    <label>문의 내용이나 메모 (선택)</label>
    <textarea id="text" placeholder="캡처만 올려도 됩니다. 고객이 채팅으로 보낸 글이 있으면 붙여넣으세요."></textarea>
    <p class="muted">고객 전화번호나 상세 주소는 넣지 않아도 됩니다.</p>
    <button class="btn primary block" id="submit">AI 분석 시작</button></div>`;
  // 'AI 분석 시작'을 누르면 버튼을 잠그고, 사진을 줄여서 서버에 올린 뒤, 그 문의 화면으로 간다. 실패하면 버튼을 되돌린다
  document.getElementById('submit').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = '올리는 중…';
    try {
      const images = await readImages(document.getElementById('files'));
      const { id } = await api('/api/inquiries', { text: document.getElementById('text').value, images });
      location.hash = `#/i/${id}`;
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
      e.target.textContent = 'AI 분석 시작';
    }
  };
}

// ---------- 문의 상세 (승인 화면) ----------
async function renderDetail(id) {
  clearInterval(pollTimer);
  // 서버에서 이 문의의 전체 내용을 받는다. a는 AI 분석 결과(아직 없을 수 있다)
  const inq = await api(`/api/inquiries/${id}`);
  const a = inq.analysis;

  // 문의·대화 기록 칸: 누가 언제 쓴 글인지와 사진들. 분석 결과가 없으면 펼쳐서 보여준다
  const thread = `<details class="card" ${a ? '' : 'open'}><summary>문의·대화 기록 (${inq.messages.length})</summary><p></p>
    ${inq.messages
      .map(
        (m) => `<div class="msg ${m.from}"><div class="muted">${{ owner: '사장님', room: '숨고 채팅방 화면' }[m.from] || '고객'} · ${when(m.at)}</div>${esc(m.text)}
        <div class="thumbs">${(m.images || []).map((f) => `<a href="/api/inquiries/${id}/photo/${f}" target="_blank"><img src="/api/inquiries/${id}/photo/${f}" alt="첨부 사진"></a>`).join('')}</div></div>`,
      )
      .join('')}</details>`;

  // 분석 중이면 돌아가는 표시를 보여주고, 3초마다 끝났는지 확인해 끝나면 다시 그린다
  if (inq.status === 'analyzing') {
    app.innerHTML = `<div class="card"><h2>${esc(inq.title)}</h2><div class="spinner"></div><p class="muted" style="text-align:center">AI가 분석하고 있습니다. 보통 1분 안에 끝납니다.</p></div>${thread}`;
    pollTimer = setInterval(async () => {
      const cur = await api(`/api/inquiries/${id}`).catch(() => null);
      if (cur && cur.status !== 'analyzing' && location.hash === `#/i/${id}`) renderDetail(id);
    }, 3000);
    return;
  }

  // 분석 결과가 없으면(분석 실패) 사유와 '다시 분석' 버튼을 보여준다
  // 결과가 이미 정해진 문의(읽지 못한 채팅방 등)는 다시 분석할 것이 없어 사유만 보여준다
  if (!a) {
    app.innerHTML = `<div class="card"><h2>${esc(inq.title)}</h2>${
      inq.autoSend
        ? `<p class="${inq.status === 'error' ? 'err' : 'muted'}">${esc(inq.error || inq.autoSend.reason)}</p>`
        : `<p class="err">분석에 실패했습니다: ${esc(inq.error)}</p><button class="btn primary block" id="retry">다시 분석</button>`
    }</div>${thread}${inq.autoSend ? statusCard(inq) : ''}`;
    document.getElementById('retry')?.addEventListener('click', async () => (await api(`/api/inquiries/${id}/reanalyze`, {}), renderDetail(id)));
    if (inq.autoSend) bindStatus(id);
    return;
  }

  // 숨고 채팅방에서 온 것이면 채팅 첫 응대 화면을 그린다
  if (inq.kind === 'chat') return renderChatDetail(inq, thread);

  // 금액 계산에 넣을 값들(화면에서 고칠 수 있게 복사해 둔다)과 고른 금액
  const inputs = { ...inq.estimateInputs };
  let chosenPrice = inq.finalPrice;
  // 숫자를 넣는 칸 하나를 만드는 작은 함수. 값이 없으면 '미정'으로 보인다
  const field = (key, label, step = 1) => `<div><label>${label}</label><input type="number" inputmode="decimal" min="0" step="${step}" data-k="${key}" value="${inputs[key] ?? ''}" placeholder="미정"></div>`;
  // 목록을 점 찍은 줄로 만든다. 없으면 '없음'
  const li = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '없음');
  // 청소 문의인지
  const isCleaning = a.job_category === 'cleaning';

  // 화면에 그린다: 제목과 상태 / 숨고에 보낼 답변 / 예상 견적 입력 칸 / 분석 결과 / 추가 사진 등록 / 대화 기록 / 처리 상태
  app.innerHTML = `
  <div class="card">
    <h2>${esc(inq.title)}</h2>
    <div><span class="badge state">${STATUS[inq.status]}</span><span class="badge ${a.risk_level}">${RISK[a.risk_level]}</span></div>
    ${inq.autoSend ? `<p class="${inq.autoSend.sent || inq.autoSend.prepared ? 'muted' : 'err'}">${autoSendText(inq.autoSend)}</p>` : ''}
    ${inq.error ? `<p class="err">최근 재분석 실패: ${esc(inq.error)}</p>` : ''}
    ${a.review_reasons?.length ? `<p class="muted">검토 사유: ${esc(a.review_reasons.join(' / '))}</p>` : ''}
  </div>

  <div class="card">
    <h2>⑪ 숨고에 보낼 답변</h2>
    <textarea class="reply" id="reply">${esc(inq.draftReply)}</textarea>
    <p class="row">
      <button class="btn small" id="useInfo">정보 요청 답변</button>
      <button class="btn small" id="useEst" ${quoteFeatures ? '' : 'hidden'}>견적 안내 답변</button>
    </p>
    <button class="btn primary block" id="approve">승인하고 복사</button>
    <p class="muted">복사된 글을 숨고 앱에 붙여넣어 직접 보내주세요.</p>
  </div>

  <div class="card" ${quoteFeatures ? '' : 'hidden'}>
    <h2>⑩ 예상 견적</h2>
    ${isCleaning ? '<p class="muted">청소 문의는 아직 견적 기준이 없어 자동 계산하지 않습니다. 금액을 정하셨으면 아래 "직접 입력"을 쓰세요.</p>' : ''}
    ${a.estimate_ready ? '' : '<p class="err">현장 확인 필요 — 아직 확정할 정보가 부족합니다.</p>'}
    <div class="grid2">
      ${field('vehicles', '⑥ 1톤 차량 (대)')}
      ${field('workers', '⑤ 작업 인원 (명)')}
      ${field('ladderHours', '⑦ 사다리차 (시간, 없으면 0)', 0.5)}
      ${field('hiredWorkers', '고용 인원 (명)')}
      ${field('disposalCost', '폐기물 처리비 (원)', 10000)}
      ${field('fuel', '기름값 (원)', 10000)}
      ${field('meal', '식대 (원)', 10000)}
      ${field('otherCost', '기타 원가 (원)', 10000)}
    </div>
    <p></p>
    <label>이익률 기준</label>
    <select data-k="marginType"><option value="small">소형 수거 (25~30%)</option><option value="general">일반 작업 (40%)</option></select>
    <div id="prices"></div>
    <div class="price"><label>직접 입력 (원)</label>
      <div class="row"><input id="manual" type="number" inputmode="numeric" step="10000" placeholder="예: 500000"><button class="btn small" id="useManual">이 금액으로 답변 만들기</button></div>
    </div>
    <p class="muted">${a.night === 'yes' ? '야간 작업: 추가 금액은 사장님이 정해 직접 입력해 주세요. ' : ''}금액은 모두 사장님 승인 전 '예상 견적'입니다.</p>
  </div>

  <div class="card">
    <h2>분석 결과</h2>
    <dl>
      <dt>① 요청 요약</dt><dd>${esc(a.summary)}</dd>
      <dt>② 지역</dt><dd>${esc(a.region)}</dd>
      <dt>③ 작업 종류</dt><dd>${esc(a.job_type)}</dd>
      <dt>④ 폐기물 양</dt><dd>${esc(a.volume_text)}</dd>
      <dt>⑤ 인원</dt><dd>${a.workers ?? '현장 확인 필요'}</dd>
      <dt>⑥ 차량</dt><dd>${a.vehicles ?? '현장 확인 필요'}</dd>
      <dt>⑦ 사다리차</dt><dd>${YN[a.ladder_needed]}</dd>
      <dt>⑧ 야간</dt><dd>${{ yes: '야간 작업', no: '주간', unknown: '확인 필요' }[a.night]}</dd>
      <dt>⑨ 확인할 것</dt><dd>${li(a.unknowns)}</dd>
      <dt>사진에서 본 것</dt><dd>${li(a.photo_observations)}</dd>
    </dl>
  </div>

  <div class="card">
    <h2>고객 답장·추가 사진 등록</h2>
    <p class="muted">고객이 사진이나 답을 보내면 여기에 올려주세요. 이전 내용과 합쳐 다시 분석합니다.</p>
    <input id="moreFiles" type="file" accept="image/*" multiple>
    <p></p>
    <textarea id="moreText" placeholder="고객이 보낸 글 (선택)"></textarea>
    <p></p>
    <button class="btn block" id="addMore">추가하고 재분석</button>
  </div>

  ${thread}

  ${statusCard(inq)}`;

  // 방금 그린 화면에서 답변 칸과 금액 표시 자리를 찾아 두고, 이익률 기준을 저장된 값으로 맞춘다
  const replyEl = document.getElementById('reply');
  const pricesEl = document.getElementById('prices');
  app.querySelector('[data-k="marginType"]').value = inputs.marginType || 'general';

  // 고친 내용을 서버에 저장한다. 글자를 칠 때마다 보내지 않도록 0.8초 동안 더 고치지 않으면 보낸다
  let saveTimer;
  const saveDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api(`/api/inquiries/${id}/draft`, { estimateInputs: inputs, draftReply: replyEl.value }).catch(() => {}), 800);
  };
  // 고른 금액으로 견적 안내 답변을 만든다: {{견적}} 자리에 금액을 넣고, 답변 칸으로 화면을 옮긴다
  const makeEstimateReply = (priceText) => {
    replyEl.value = a.reply_with_estimate.replaceAll('{{견적}}', priceText);
    chosenPrice = priceText;
    saveDraft();
    replyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('견적 안내 답변으로 바꿨습니다. 내용을 확인해 주세요.');
  };

  // 두 가지 금액을 다시 계산해 보여준다. 계산된 쪽에는 '이 금액으로 답변 만들기' 버튼이 붙는다
  const drawPrices = () => {
    const { table, cost } = calc(config, inputs);
    // 금액 칸 하나를 만드는 작은 함수
    const box = (key, title, r, detail) => `<div class="price"><div class="muted">${title}</div><b>${rangeText(r)}</b>
      ${r ? `<div class="muted">${detail}</div><p><button class="btn small" data-use="${key}">이 금액으로 답변 만들기</button></p>` : '<div class="muted">위 칸을 채우면 계산됩니다.</div>'}</div>`;
    pricesEl.innerHTML =
      box('table', '단가표 기준 (차량 35~40만 + 인원 15~20만)', table, table ? `사다리차 ${won(table.ladder)} 포함` : '') +
      box('cost', '원가 기준 (원가 ÷ (1 − 이익률))', cost, cost ? `총원가 ${won(cost.total)} · 이익률 ${Math.round(cost.marginMin * 100)}${cost.marginMax !== cost.marginMin ? `~${Math.round(cost.marginMax * 100)}` : ''}%` : '');
    // 버튼을 누르면 그 방식의 금액으로 답변을 만든다
    pricesEl.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => makeEstimateReply(customerPrice(b.dataset.use === 'table' ? table : cost))));
  };
  // 화면을 열자마자 한 번 계산해 보여준다
  drawPrices();

  // 견적 입력 칸을 고칠 때마다 값을 반영하고(비우면 '모름'), 금액을 다시 계산하고, 저장한다
  app.querySelectorAll('[data-k]').forEach((el) => {
    el.oninput = () => {
      const k = el.dataset.k;
      inputs[k] = k === 'marginType' ? el.value : el.value === '' ? null : Number(el.value);
      drawPrices();
      saveDraft();
    };
  });
  // 답변을 고쳐도 저장한다
  replyEl.oninput = saveDraft;

  // '정보 요청 답변'·'견적 안내 답변' 버튼: 답변 칸을 그 답변으로 바꾼다
  document.getElementById('useInfo').onclick = () => ((replyEl.value = a.reply_need_info), (chosenPrice = null), saveDraft());
  document.getElementById('useEst').onclick = () => ((replyEl.value = a.reply_with_estimate), saveDraft(), toast('{{견적}} 자리에 금액을 넣어주세요.'));
  // '직접 입력' 금액으로 답변 만들기
  document.getElementById('useManual').onclick = () => {
    const v = Number(document.getElementById('manual').value);
    if (!v) return toast('금액을 입력해 주세요.');
    makeEstimateReply(customerPrice({ min: v, max: v }));
  };

  // '승인하고 복사' 버튼: 답변이 비었거나 {{견적}} 자리가 남아 있으면 막는다
  document.getElementById('approve').onclick = async () => {
    const reply = replyEl.value.trim();
    if (!reply) return toast('보낼 답변이 비어 있습니다.');
    if (reply.includes('{{견적}}')) return toast('답변에 {{견적}} 자리가 남아 있습니다. 금액을 넣어주세요.');
    try {
      // 밀려 있던 자동 저장을 취소하고, 답변을 복사한 뒤, 서버에 승인을 기록하고 화면을 다시 그린다
      clearTimeout(saveTimer);
      // 버튼을 누른 직후에 복사해야 휴대폰 브라우저가 허용한다
      const copied = await copyText(reply);
      await api(`/api/inquiries/${id}/approve`, { reply, price: chosenPrice, estimateInputs: inputs });
      await renderDetail(id);
      toast(copied ? '복사했습니다. 숨고에 붙여넣어 보내주세요.' : '자동 복사가 안 됩니다. 글을 길게 눌러 복사해 주세요.');
    } catch (e) {
      toast(e.message);
    }
  };

  // '추가하고 재분석' 버튼: 고객이 더 보낸 글과 사진을 올리고 다시 분석한다
  document.getElementById('addMore').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const images = await readImages(document.getElementById('moreFiles'));
      await api(`/api/inquiries/${id}/messages`, { text: document.getElementById('moreText').value, images });
      renderDetail(id);
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  };

  bindStatus(id);
}

// 처리 상태 칸: 예약일, 예약 확정·보류·거절 버튼, 처리 기록
const statusCard = (inq) => `<div class="card">
    <h2>처리 상태</h2>
    <label>예약일 (예약 확정 시)</label>
    <input id="bookDate" type="date" value="${esc(inq.booking?.date || '')}">
    <p class="row">
      <button class="btn" data-s="booked">예약 확정</button>
      <button class="btn" data-s="on_hold">보류</button>
      <button class="btn danger" data-s="rejected">거절</button>
    </p>
    <details><summary class="muted">처리 기록</summary>${inq.log.map((l) => `<div class="muted">${when(l.at)} · ${esc(l.action)}${l.detail ? ` — ${esc(l.detail)}` : ''}</div>`).join('')}</details>
  </div>`;

// 처리 상태 버튼(예약 확정·보류·거절): 예약 확정은 예약일을 골라야 한다
function bindStatus(id) {
  app.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = async () => {
      const status = b.dataset.s;
      const date = document.getElementById('bookDate').value;
      if (status === 'booked' && !date) return toast('예약일을 선택해 주세요.');
      try {
        await api(`/api/inquiries/${id}/status`, { status, date });
        toast(`${STATUS[status]}(으)로 바꿨습니다.`);
        renderDetail(id);
      } catch (e) {
        toast(e.message);
      }
    };
  });
}

// ---------- 숨고 채팅 첫 응대 한 건 ----------
function renderChatDetail(inq, thread) {
  const id = inq.id;
  const a = inq.analysis;
  const sent = inq.status === 'sent';
  // 화면에 그린다: 제목과 결과 / 보낸(보낼) 첫 응대 / 요청 내용 / 채팅방 화면 글 / 처리 상태
  app.innerHTML = `
  <div class="card">
    <h2>${esc(inq.title)}</h2>
    <div><span class="badge state">${STATUS[inq.status]}</span></div>
    ${inq.autoSend ? `<p class="${inq.autoSend.sent || inq.autoSend.prepared ? 'muted' : 'err'}">${autoSendText(inq.autoSend, 'chat')}</p>` : ''}
    ${serverMode && extVersion() && inq.autoSend?.prepared && !sent ? '<button class="btn small" id="showRoom">숨고 창에서 보기</button>' : ''}
    ${inq.extTask && !inq.autoSend ? '<p class="muted">PC 크롬이 이 답장을 숨고 채팅창에 써 넣는 중입니다.</p>' : ''}
    ${inq.error ? `<p class="err">최근 재작성 실패: ${esc(inq.error)}</p>` : ''}
  </div>

  <div class="card">
    <h2>${sent ? '고객에게 보낸 첫 응대' : '고객에게 보낼 첫 응대'}</h2>
    <textarea class="reply" id="reply" ${sent ? 'readonly' : ''}>${esc(sent ? inq.finalReply : inq.draftReply)}</textarea>
    ${sent ? '' : '<button class="btn primary block" id="approve">복사하고 보낸 것으로 표시</button><p class="muted">복사된 글을 숨고 채팅방에 붙여넣어 직접 보내주세요.</p>'}
  </div>

  <div class="card">
    <h2>요청 내용</h2>
    <dl>
      <dt>서비스</dt><dd>${esc(a.service)}</dd>
      <dt>지역</dt><dd>${esc(a.region)}</dd>
      <dt>요약</dt><dd>${esc(a.summary)}</dd>
      ${a.send ? '' : `<dt>AI가 보내지 않은 이유</dt><dd>${esc(a.skip_reason)}</dd>`}
    </dl>
  </div>

  ${thread}

  ${statusCard(inq)}`;

  // 써 둔 채팅방 탭을 PC 크롬에서 앞에 띄운다 (서버에서, 확장이 있을 때)
  const showRoom = document.getElementById('showRoom');
  if (showRoom) showRoom.onclick = () => extSend('show', { chatId: inq.chatId });
  // 아직 보내지 않았으면 답장을 고칠 수 있고, 고친 내용은 0.8초 뒤 저장한다. '복사하고 보낸 것으로 표시'로 직접 보낸 것을 기록한다
  if (!sent) {
    const replyEl = document.getElementById('reply');
    let saveTimer;
    replyEl.oninput = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api(`/api/inquiries/${id}/draft`, { draftReply: replyEl.value }).catch(() => {}), 800);
    };
    document.getElementById('approve').onclick = async () => {
      const reply = replyEl.value.trim();
      if (!reply) return toast('보낼 답장이 비어 있습니다.');
      try {
        clearTimeout(saveTimer);
        // 버튼을 누른 직후에 복사해야 휴대폰 브라우저가 허용한다
        const copied = await copyText(reply);
        await api(`/api/inquiries/${id}/approve`, { reply });
        await renderDetail(id);
        toast(copied ? '복사했습니다. 숨고 채팅방에 붙여넣어 보내주세요.' : '자동 복사가 안 됩니다. 글을 길게 눌러 복사해 주세요.');
      } catch (e) {
        toast(e.message);
      }
    };
  }
  bindStatus(id);
}

// ---------- 설정 (켜고 끄기) ----------
async function renderSettings() {
  clearInterval(pollTimer);
  // 서버에서 지금 설정과 상태를 받는다
  const st = await api('/api/state');
  const sg = st.soomgo;
  // 노트북에서 직접 보고 있는지, 외부 접속 주소로 보고 있는지
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const viaTunnel = Boolean(st.tunnelUrl) && location.origin === st.tunnelUrl;

  // 숨고 자동 확인의 상태 한 줄
  const soomgoLine = !st.settings.soomgo
    ? '<span class="dot"></span>꺼져 있습니다. 새 요청서는 캡처해서 직접 올립니다.'
    : sg.state === 'ok'
      ? `<span class="dot on"></span>잘 되고 있습니다. ${esc(sg.message)}${sg.lastCheck ? ` · 마지막 확인 ${when(sg.lastCheck)}` : ''}`
      : sg.state === 'login'
        ? `<span class="dot wait"></span>숨고 로그인이 필요합니다. ${loginWhere()}`
        : sg.state === 'error'
          ? `<span class="dot bad"></span>${esc(sg.message)}`
          : '<span class="dot wait"></span>시작하는 중입니다.';

  // 밖에서 접속하기의 상태 한 줄: 꺼짐 / 주소와 복사 버튼 / 문제 안내 / 주소 만드는 중
  const tunnelLine = !st.settings.tunnel
    ? '<span class="dot"></span>꺼져 있습니다. 집 와이파이 안에서만 접속됩니다.'
    : st.tunnelUrl
      ? `<span class="dot on"></span>켜져 있습니다. 밖에서는 아래 주소로 접속하세요.<br><b>${esc(st.tunnelUrl)}</b>
         <p><button class="btn small" id="copyUrl">주소 복사</button></p>
         <span class="muted">${st.tunnelUrl.endsWith('trycloudflare.com') ? '이 주소는 프로그램을 껐다 켜면 바뀝니다. 도메인을 연결하거나 Tailscale을 설치하면 바뀌지 않는 주소를 씁니다.' : '이 주소는 바뀌지 않습니다.'}</span>`
      : st.tunnelNote
        ? `<span class="dot bad"></span><span class="err">${esc(st.tunnelNote).replace(/https:\/\/\S+/, (u) => `<a href="${u}" target="_blank">${u}</a>`)}</span>`
        : '<span class="dot wait"></span>주소를 만드는 중입니다. 잠시만 기다려 주세요.';

  // 켜고 끄는 스위치 하나를 만드는 작은 함수
  const sw = (id, on) => `<label class="switch" aria-label="켜기 끄기"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;

  // 화면에 그린다: 프로그램 상태와 버전 / 숨고 자동 확인 / 분석할 AI / 숨고 답변 보내는 방식 / 밖에서 접속하기 / 카톡 일감 잡기 / 카카오톡 알림 / 프로그램 끄기
  app.innerHTML = `
  <div class="card"><span class="dot on"></span><b>프로그램이 켜져 있습니다</b>
    <p class="muted">${serverMode ? '비서 사이트와 AI는 사무실 서버에서 늘 켜져 있습니다. 숨고 채팅 응대는 확장을 설치한 PC의 크롬이 켜져 있을 때 합니다.' : '노트북이 켜져 있는 동안 계속 동작합니다. 노트북 덮개를 닫으면 멈춥니다.'}${st.version ? `<br>버전 ${esc(st.version)}` : ''}</p></div>

  <div class="card" id="chatCard">
    <div class="setting"><div><h2>숨고 채팅 자동 응대</h2>
      <div class="muted">1분마다 숨고 채팅 목록을 확인합니다. 스마트견적 등으로 새 채팅방이 생기면, 고객이 요청서에 남긴 내용을 바탕으로 확인할 것과 필요한 사진을 묻는 첫 응대를 한 번 보냅니다. 답장은 채팅방에 보이는 요청서와 견적 메시지만 보고 씁니다. 첫 화면의 "켜기·끄기"와 같은 스위치입니다.</div></div>
      ${sw('swChat', st.settings.chat)}</div>
    <div class="state-line">${chatLine(st)}</div>
    <label>새 채팅방에 답장하는 방식</label>
    <select id="chatMode">${Object.entries(CHAT_MODE).map(([k, v]) => `<option value="${k}" ${k === st.settings.chatMode ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <p class="muted">"자동으로 보내기"는 확인 없이 고객에게 바로 보냅니다. 채팅방마다 한 번만 보내고, 이미 직접 대화 중인 채팅방, 업무와 관계없는 요청, 연락처나 금액이 들어간 답장은 보내지 않고 사유를 남깁니다. 켜기 전에 있던 채팅방에는 보내지 않습니다.<br>
    ${serverMode ? '"채팅창에 써 두고 멈춤"은 PC 크롬에 그 채팅방을 새 탭으로 열어 답장을 써 두기만 합니다. 확인하고 전송을 눌러 주세요.' : '"채팅창에 써 두고 멈춤"은 노트북의 숨고 창에 새 탭을 열어 답장을 써 두기만 합니다.'}</p>
  </div>

  <div class="card" ${quoteFeatures ? '' : 'hidden'}>
    <div class="setting"><div><h2>숨고 새 요청 자동으로 가져오기</h2>
      <div class="muted">3분마다 숨고 "받은 요청"을 확인해서 새 요청서를 알아서 등록합니다. 첫 화면의 "켜기·끄기"와 같은 스위치입니다.</div></div>
      ${sw('swSoomgo', st.settings.soomgo)}</div>
    <div class="state-line">${soomgoLine}</div>
  </div>

  <div class="card">
    <h2>문의를 분석할 AI</h2>
    <select id="aiProvider"><option value="codex" ${st.settings.ai === 'codex' ? 'selected' : ''}>ChatGPT (Codex)</option><option value="claude" ${st.settings.ai === 'claude' ? 'selected' : ''}>Claude</option></select>
    <p class="muted">고른 쪽의 프로그램이 ${serverMode ? '서버' : '노트북'}에 설치되어 있고 유료 구독 계정으로 로그인되어 있어야 합니다. ChatGPT는 Codex, Claude는 Claude Code를 씁니다.</p>
  </div>

  <div class="card" ${quoteFeatures ? '' : 'hidden'}>
    <h2>숨고 답변 보내는 방식</h2>
    <select id="quoteMode">${Object.entries(QUOTE_MODE).map(([k, v]) => `<option value="${k}" ${k === st.settings.quoteMode ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <p class="muted">"발송 직전까지 자동"은 숨고에서 가져온 요청의 분석이 끝나면 노트북의 숨고 창에 답변과 금액(계산된 경우)을 써 두고 멈춥니다. 캐시가 나가는 "견적 보내기"는 그 창에서 직접 누릅니다.<br>
    "자동 발송"은 확인 없이 보내며 보낼 때마다 숨고캐시가 나갑니다. 금액을 계산할 수 없는 문의와 업무가 아닌 요청은 보내지 않습니다.</p>
  </div>

  <div class="card" ${serverMode ? 'hidden' : ''}>
    <div class="setting"><div><h2>밖에서도 접속하기</h2>
      <div class="muted">집 밖에서 휴대폰으로 볼 수 있는 주소를 만듭니다. 주소와 비밀번호는 다른 사람에게 알려주지 마세요.</div></div>
      ${sw('swTunnel', st.settings.tunnel)}</div>
    <div class="state-line">${tunnelLine}</div>
  </div>

  <div class="card" id="talkCard">
    <h2>카톡 일감 잡기</h2>
    <p class="muted">첫 화면에서 켜 두면, 아래 방에 "찾을 말"이 든 새 글이 올라오는 즉시 "보낼 글"을 보냅니다. ${serverMode ? '카카오톡이 있는 PC에서 "카톡 일감 도우미"가 켜져 있어야 합니다(<a href="#/guide/talk">사용 안내</a>).' : '노트북의 카카오톡이 켜져 있어야 합니다.'} 보내는 몇 초 동안은 카카오톡 창이 앞으로 나오고 마우스가 저절로 움직일 수 있습니다. 개인톡은 글 올린 사람의 프로필에서 1:1 채팅을 열어 보냅니다. 오픈채팅방에서는 프로필로 대화를 걸 수 없어서, 그 사람과 이미 만들어 둔 1:1 채팅방이 있을 때만 그 방으로 보냅니다. 윈도우 PC는 지켜볼 방 창을 열어 두어야 합니다(최소화하지 말고). 저장하면 바로 적용됩니다.</p>
    <label>지켜볼 채팅방</label>
    <input id="talkRoom" list="talkRooms" value="${esc(st.settings.talk.room)}" placeholder="카카오톡에 보이는 방 이름 그대로" autocomplete="off">
    <datalist id="talkRooms"></datalist>
    <p class="muted" id="talkRoomsNote">카카오톡에서 방 목록을 불러오는 중입니다.</p>
    <label>찾을 말</label>
    <input id="talkKeyword" value="${esc(st.settings.talk.keyword)}">
    <label>보낼 글</label>
    <textarea id="talkMessage">${esc(st.settings.talk.message)}</textarea>
    <label>보낼 곳</label>
    <select id="talkTarget"><option value="direct" ${st.settings.talk.target === 'direct' ? 'selected' : ''}>글 올린 사람에게 개인톡</option><option value="room" ${st.settings.talk.target === 'room' ? 'selected' : ''}>같은 방에 답하기 (시험용)</option></select>
    <p><button class="btn small" id="talkSave">저장</button></p>
  </div>

  <div class="card">
    <h2>카카오톡 알림</h2>
    <div class="state-line">${
      st.kakao.connected
        ? '<span class="dot on"></span>연결되어 있습니다. 새 문의 분석이 끝나면 카톡으로 알려드립니다.'
        : st.kakao.configured
          ? '<span class="dot wait"></span>아직 연결되지 않았습니다.<p><a class="btn small" href="/kakao/login">카카오톡 연결하기</a></p>'
          : '<span class="dot"></span>아직 준비되지 않았습니다. 연결하려면 도움이 필요합니다.'
    }</div>
  </div>

  <div class="card" ${serverMode ? 'hidden' : ''}>
    <h2>프로그램 끄기</h2>
    <p class="muted">끄면 문의 분석과 숨고 확인이 모두 멈춥니다. 다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 누르세요.</p>
    <button class="btn danger block" id="off">프로그램 끄기</button>
  </div>`;

  // 스위치를 바꿨을 때: 확인 문구가 있으면 먼저 묻고(취소하면 스위치를 되돌린다), 서버에 저장한 뒤 다시 그린다
  const change = async (key, el, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return (el.checked = !el.checked);
    el.disabled = true;
    try {
      await api('/api/settings', { [key]: el.checked });
      toast(el.checked ? '켰습니다.' : '껐습니다.');
    } catch (e) {
      toast(e.message);
    }
    renderSettings();
  };
  // 숨고 채팅 자동 응대 스위치. 노트북이 아닌 곳에서 켜면 크롬 창이 열린다는 것을 먼저 알린다
  document.getElementById('swChat').onchange = (e) => {
    const on = e.target.checked;
    change('chat', e.target, on && !local && !serverMode ? '켜면 노트북에 크롬 창이 열립니다. 처음에는 노트북 앞에서 숨고에 로그인해야 합니다. 켤까요?' : '');
    // 서버에서는 이 브라우저의 확장에도 알린다 (켜면 숨고 창이 뜬다)
    if (serverMode && extVersion()) extSend(on ? 'start' : 'stop');
  };
  // 새 채팅방에 답장하는 방식을 바꿨을 때. '자동으로 보내기'는 확인 없이 고객에게 나간다는 것을 한 번 더 확인한다
  document.getElementById('chatMode').onchange = async (e) => {
    const mode = e.target.value;
    if (mode === 'send' && !confirm('확인 없이 고객에게 첫 응대가 바로 나갑니다. 이 방식으로 바꿀까요?')) return renderSettings();
    try {
      await api('/api/settings', { chatMode: mode });
      toast('바꿨습니다.');
    } catch (err) {
      toast(err.message);
    }
    renderSettings();
  };
  // 숨고 스위치. 노트북이 아닌 곳에서 켜면 크롬 창이 열린다는 것을 먼저 알린다
  document.getElementById('swSoomgo').onchange = (e) =>
    change('soomgo', e.target, e.target.checked && !local && !serverMode ? '켜면 노트북에 크롬 창이 열립니다. 처음에는 노트북 앞에서 숨고에 로그인해야 합니다. 켤까요?' : '');
  // 분석할 AI를 바꿨을 때
  document.getElementById('aiProvider').onchange = async (e) => {
    try {
      await api('/api/settings', { ai: e.target.value });
      toast('바꿨습니다. 다음 분석부터 적용됩니다.');
    } catch (err) {
      toast(err.message);
    }
    renderSettings();
  };
  // 숨고 답변 보내는 방식을 바꿨을 때. '자동 발송'은 숨고캐시가 나간다는 것을 한 번 더 확인한다
  document.getElementById('quoteMode').onchange = async (e) => {
    const mode = e.target.value;
    if (mode === 'send' && !confirm('사장님 확인 없이 숨고에 견적이 발송되고, 보낼 때마다 숨고캐시가 나갑니다. 이 방식으로 바꿀까요?')) return renderSettings();
    try {
      await api('/api/settings', { quoteMode: mode });
      toast('바꿨습니다.');
    } catch (err) {
      toast(err.message);
    }
    renderSettings();
  };
  // 밖에서 접속하기 스위치. 밖에서 접속한 채로 끄면 바로 끊긴다는 것을 먼저 알린다
  document.getElementById('swTunnel').onchange = (e) =>
    change('tunnel', e.target, !e.target.checked && viaTunnel ? '지금 밖에서 접속 중입니다. 끄면 이 화면이 바로 끊기고, 집에 가서 다시 켜야 합니다. 끌까요?' : '');
  // 방 이름을 직접 치다 틀리지 않게, 카카오톡의 방 목록에서 고를 수 있게 한다 (서버에서는 PC 도우미가 알려 준 목록. 윈도우는 열려 있는 채팅방 창만 나온다)
  api('/api/talk/rooms')
    .then(({ rooms, note }) => {
      const list = document.getElementById('talkRooms');
      const hint = document.getElementById('talkRoomsNote');
      if (!list || !hint) return;
      list.innerHTML = rooms.map((r) => `<option value="${esc(r.name)}">${r.open ? '오픈채팅 · ' : ''}${r.members == null ? '' : r.members ? `${r.members}명` : '1:1'}</option>`).join('');
      hint.textContent = rooms.length ? `방 ${rooms.length}개를 불러왔습니다. 위 칸을 비우고 누르면 목록에서 고를 수 있습니다.` : note || '방 목록을 불러오지 못했습니다. 방 이름을 직접 입력해 주세요.';
    })
    .catch(() => {});
  // 카톡 일감 잡기 '저장' 버튼: 방 이름, 찾을 말, 보낼 글, 보낼 곳을 서버에 저장한다
  document.getElementById('talkSave').onclick = async () => {
    try {
      await api('/api/settings', { talk: { room: document.getElementById('talkRoom').value, keyword: document.getElementById('talkKeyword').value, message: document.getElementById('talkMessage').value, target: document.getElementById('talkTarget').value } });
      toast('저장했습니다.');
    } catch (err) {
      toast(err.message);
    }
  };
  // 외부 접속 주소 복사 버튼 (주소가 있을 때만 있다)
  const copyBtn = document.getElementById('copyUrl');
  if (copyBtn) copyBtn.onclick = async () => toast((await copyText(st.tunnelUrl)) ? '주소를 복사했습니다.' : '복사가 안 됩니다. 주소를 길게 눌러 복사해 주세요.');
  // '프로그램 끄기' 버튼: 한 번 더 묻고, 서버에 끄라고 한 뒤 안내를 보여준다
  document.getElementById('off').onclick = async () => {
    if (!confirm('프로그램을 끌까요?\n다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 눌러야 합니다.')) return;
    await api('/api/shutdown', {}).catch(() => {});
    app.innerHTML = '<div class="card"><span class="dot"></span><b>프로그램을 껐습니다</b><p class="muted">다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 누르세요.</p></div>';
  };

  // 상태가 바뀌는 중이면 자동으로 새로 고친다
  const waiting = (st.settings.chat && st.chat.state !== 'ok') || (quoteFeatures && st.settings.soomgo && sg.state !== 'ok') || (st.settings.tunnel && !st.tunnelUrl);
  if (waiting) pollTimer = setInterval(() => location.hash === '#/settings' && !document.querySelector('.switch input:disabled') && renderSettings(), 4000);
}

// 카톡 일감 도우미 설치 파일이 안 될 때 쓰는 PowerShell 명령 한 줄(설치 파일과 같은 일을 한다)
const AGENT_INSTALL =
  "winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); cd ~; if (Test-Path ssakda-clean-assistant) { git -C ssakda-clean-assistant pull --ff-only } else { git clone https://github.com/justinnn980/ssakda-clean-assistant.git }; powershell -ExecutionPolicy Bypass -File ssakda-clean-assistant/scripts/install-kakaotalk-agent.ps1";

// ---------- 사용 안내 (서버에서 돌 때) ----------
// 두 가지를 안내한다: 숨고 채팅 자동 응대(PC 크롬 확장)와 카톡 일감 잡기(카카오톡 PC의 도우미). 맨 위에서 하나를 골라 그 안내만 보여 준다.
// 숨고: 영상 두 편과 단계마다 실제 화면 사진. 웹스토어 주소(extStore)가 있으면 설치는 '웹스토어에서 추가하기' 한 번으로 바뀐다.
// 카톡: 설치 파일 받기(/api/talk/setup.cmd) → 두 번 누르기 → 비밀번호. 맨 위에 도우미가 지금 연결돼 있는지와 PC 이름을 보여 준다
let guideTab = 'soomgo';
async function renderGuide() {
  clearInterval(pollTimer);
  const st = await api('/api/state');
  // 단계 하나: 번호, 제목, 설명, 사진(누르면 크게)
  const step = (n, title, text, shot) => `<li class="step"><span class="num">${n}</span><div><b>${title}</b>${text ? `<p>${text}</p>` : ''}${
    shot ? `<a href="/guide/${shot}" target="_blank"><img class="shot" src="/guide/${shot}" alt="${title}" loading="lazy"></a>` : ''}</div></li>`;
  const video = (name, title) => `<div class="video"><b>${title}</b><video controls preload="none" playsinline poster="/guide/${name}-poster.jpg" src="/guide/${name}.mp4"></video></div>`;
  const tabs = `<div class="tabs">${[['soomgo', '숨고 채팅 자동 응대'], ['talk', '카톡 일감 잡기']]
    .map(([k, v]) => `<button class="tab ${k === guideTab ? 'on' : ''}" data-g="${k}">${v}</button>`)
    .join('')}</div>`;

  let body;
  if (guideTab === 'talk') {
    // 도우미가 30초 안에 연락했으면 연결된 것이다
    const tk = st.talk;
    const live = tk.seenAt && Date.now() - new Date(tk.seenAt) < 30 * 1000;
    const agentState = live
      ? `<span class="dot on"></span>카톡 일감 도우미가 연결되어 있습니다${tk.pc ? ` (PC 이름: ${esc(tk.pc)})` : ''}. 설치는 끝났으니 아래 "쓰는 법"으로 가세요.`
      : '<span class="dot wait"></span>카톡 일감 도우미가 연결되어 있지 않습니다. 처음이면 아래 "처음 한 번: 도우미 설치"를, 설치했다면 그 PC의 바탕화면에서 <b>카톡 일감 도우미</b>를 두 번 눌러 주세요.';
    body = `
  <div class="card guide">
    <h2>카톡 일감 잡기</h2>
    <div class="state-line">${agentState}</div>
    <ul>
      <li>업무 단체방에 <b>찾을 말</b>(예: [방문견적])이 든 글이 올라오면, <b>글 올린 사람에게 개인톡</b>으로 정해 둔 글을 몇 초 안에 보냅니다.</li>
      <li>이 사이트(서버)에는 카카오톡이 없어서, <b>사장님 카카오톡이 로그인된 윈도우 PC</b>에 <b>카톡 일감 도우미</b>를 한 번 설치해 둡니다. 그 뒤로는 휴대폰에서도 이 사이트로 켜고 끕니다.</li>
      <li>그 PC와 카카오톡이 켜져 있어야 동작합니다. 도우미는 PC를 켤 때 저절로 켜집니다.</li>
    </ul>
  </div>

  <div class="card guide">
    <h2>처음 한 번: 도우미 설치</h2>
    <p class="muted">반드시 <b>사장님 카카오톡이 로그인된 윈도우 PC</b>에서 합니다. 도우미는 한 PC에만 설치하세요(두 PC에 있으면 먼저 켜진 PC만 일합니다).</p>
    <ol class="steps">
      ${step(1, '그 PC의 크롬에서 이 사이트 열기', '카카오톡이 있는 PC에서 크롬을 열고 이 사이트에 접속해, 지금 보고 있는 <b>안내 → 카톡 일감 잡기</b>를 엽니다.')}
      ${step(2, '설치 파일 받기', '아래 버튼을 누르면 <b>kakaotalk-setup.cmd</b> 파일이 받아집니다. 크롬이 "흔하지 않은 파일" 같은 경고를 띄우면 <b>계속</b>(또는 <b>유지</b>)을 누릅니다.<p><a class="btn primary" href="/api/talk/setup.cmd">설치 파일 받기</a></p>')}
      ${step(3, '받은 파일 두 번 누르기', '크롬 오른쪽 위의 다운로드 표시(↓)를 누르고 <b>kakaotalk-setup.cmd</b>를 누릅니다. 다운로드 폴더에서 두 번 눌러도 됩니다.')}
      ${step(4, '파란 "Windows의 PC 보호" 창이 뜨면', '<b>추가 정보</b>를 누른 뒤 아래에 생기는 <b>실행</b>을 누릅니다. (인터넷에서 받은 파일이라 처음 한 번 묻는 것입니다.)')}
      ${step(5, '검은 창에서 설치가 진행됩니다', '몇 분 걸립니다. 중간에 <b>"이 앱이 디바이스를 변경할 수 있도록 허용하시겠어요?"</b> 창이 뜨면 <b>예</b>를 누릅니다(한두 번). 창은 닫지 말고 기다려 주세요.')}
      ${step(6, '접속 비밀번호 넣기', '작은 창이 뜨면 <b>이 사이트의 접속 비밀번호</b>를 넣고 확인을 누릅니다. "켜졌습니다"가 뜨면 확인을 누르고, 검은 창은 아무 키나 눌러 닫습니다.')}
      ${step(7, '연결 확인', '이 화면을 새로고침해서 맨 위에 <b>"카톡 일감 도우미가 연결되어 있습니다"</b>가 보이면 설치 끝입니다. 바탕화면에 <b>카톡 일감 도우미</b> 아이콘이 생깁니다.')}
    </ol>
    <details><summary class="muted">설치 파일이 안 될 때 (도와줄 분께 보여 주세요)</summary>
      <p class="muted">윈도우 키 → <b>powershell</b> 입력 → Enter로 창을 연 뒤, 아래 명령을 붙여넣고 Enter를 누릅니다. 설치 파일과 같은 일을 합니다.</p>
      <p><code>${esc(AGENT_INSTALL)}</code></p>
      <p><button class="btn small" id="copyAgent">명령 복사</button></p>
    </details>
  </div>

  <div class="card guide">
    <h2>쓰는 법</h2>
    <ol class="steps">
      ${step(1, '지켜볼 방 창 열어 두기', 'PC 카카오톡에서 업무 단체방을 두 번 눌러 <b>채팅방 창</b>을 엽니다. 이 창은 <b>닫거나 최소화하지 말고</b> 다른 창 뒤에 두세요. 세로로 길게 키워 두면 더 정확합니다.')}
      ${step(2, '설정 정하기', '이 사이트 <b>설정 → 카톡 일감 잡기</b>에서 <b>지켜볼 채팅방</b>(칸을 누르면 PC에 열린 방이 나옵니다), <b>찾을 말</b>, <b>보낼 글</b>을 정하고, <b>보낼 곳</b>은 <b>글 올린 사람에게 개인톡</b>으로 두고 <b>저장</b>을 누릅니다.')}
      ${step(3, '켜기', '첫 화면의 <b>카톡 일감 잡기</b>에서 <b>켜기</b>를 누릅니다. 몇 초 뒤 <b>PC(이름)에서 "방 이름" 방을 지켜보는 중</b>이 보이면 됩니다.')}
      ${step(4, '보낸 기록 보기', '일감 글이 올라와 개인톡을 보내면 첫 화면 카톡 칸에 시각과 받은 사람이 남습니다. 못 보냈으면 이유가 빨간 글씨로 남습니다.')}
      ${step(5, '끄기', '첫 화면에서 <b>끄기</b>를 누르면 바로 멈춥니다. 도우미는 켜 둔 채로 두어도 됩니다.')}
    </ol>
    <p class="muted">처음 한 번은 보낼 곳을 <b>같은 방에 답하기 (시험용)</b>로 두고, 카카오톡의 <b>나와의 채팅</b> 방을 지켜볼 방으로 정해 찾을 말이 든 글을 직접 써 보면 안전하게 시험할 수 있습니다.</p>
  </div>

  <div class="card guide">
    <h2>이렇게 보냅니다</h2>
    <ul>
      <li>글 옆의 <b>프로필 사진을 눌러 1:1 채팅</b>을 열고 보냅니다. 처음 대화하는 사람에게도 보냅니다.</li>
      <li><b>오픈채팅방</b>은 카카오톡이 프로필로 대화를 걸지 못하게 해서, 그 사람과 <b>이미 대화한 1:1 채팅방</b>이 있을 때만 보냅니다.</li>
      <li>보내는 몇 초 동안 카카오톡 창이 앞으로 나오고 마우스가 저절로 움직입니다. 그동안 PC를 만지지 않는 것이 좋습니다.</li>
      <li>내가 쓴 글에는 보내지 않고, 같은 사람의 같은 글에는 10분 안에 두 번 보내지 않습니다.</li>
    </ul>
  </div>

  <div class="card guide">
    <h2>문제가 생기면</h2>
    <dl>
      <dt>PC의 카톡 일감 도우미가 꺼져 있습니다</dt><dd>카카오톡 PC가 켜져 있는지 보고, 그 PC 바탕화면의 <b>카톡 일감 도우미</b>를 두 번 눌러 주세요. "지금 켜져 있습니다"가 뜨면 이미 켜져 있는 것입니다.</dd>
      <dt>채팅방 창이 열려 있지 않습니다</dt><dd>PC 카카오톡에서 그 방을 두 번 눌러 창을 열어 두세요. 최소화돼 있으면 안 됩니다.</dd>
      <dt>프로필 창에 "1:1 채팅" 버튼이 없습니다 / 1:1 채팅방을 찾지 못했습니다</dt><dd>오픈채팅방이라 프로필로 대화를 걸 수 없고, 그 사람과 대화한 1:1 채팅방도 없는 것입니다. 카카오톡 메인 창은 왼쪽 말풍선(채팅) 탭으로 두세요.</dd>
      <dt>화면 밖에 있어 프로필을 누르지 못했습니다 / 이름을 읽지 못했습니다</dt><dd>글이 한꺼번에 많이 올라와 위로 밀린 것입니다. 채팅방 창을 세로로 길게 키워 두세요.</dd>
      <dt>창을 앞으로 가져오지 못해 보내지 않았습니다</dt><dd>PC가 잠겨 있었던 것입니다. 잠금을 풀어 두세요. 도우미가 지켜보는 동안에는 화면이 저절로 꺼지지 않습니다.</dd>
      <dt>다른 PC에서 도우미가 이미 일하고 있습니다</dt><dd>도우미가 두 PC에 설치되어 있습니다. 쓰지 않을 PC에서 바탕화면 아이콘을 두 번 눌러 <b>아니요(도우미 끄기)</b>를 누르고, 바탕화면과 시작 프로그램의 <b>카톡 일감 도우미</b>를 지워 주세요.</dd>
      <dt>도우미를 끄거나 다시 켜려면</dt><dd>바탕화면 <b>카톡 일감 도우미</b>를 두 번 누릅니다. 켜져 있으면 [예] 사이트 열기 · [아니요] 끄기를 고를 수 있습니다. 켤 때마다 저절로 최신 버전을 받아 옵니다.</dd>
    </dl>
  </div>`;
  } else {
    const ext = extVersion();
    const extState = !ext
      ? '<span class="dot wait"></span>이 브라우저에는 확장이 아직 없습니다. 아래 "처음 한 번: 확장 설치"를 따라 해 주세요.'
      : extLatest && ext !== extLatest
        ? `<span class="dot bad"></span>확장이 설치되어 있지만 옛 버전(${esc(ext)})입니다. 아래 "확장 업데이트"를 따라 해 주세요.`
        : `<span class="dot on"></span>이 브라우저에 확장이 설치되어 있습니다(버전 ${esc(ext)}).`;
    const install = extStore
      ? `<ol class="steps">
        ${step(1, '아래 버튼을 누릅니다', '크롬 웹스토어의 싹다클린 AI 비서 페이지가 열립니다. 예전에 파일로 설치한 확장이 있으면 chrome://extensions 에서 먼저 <b>삭제</b>해 주세요.<p><a class="btn primary" href="${esc(extStore)}" target="_blank">크롬 웹스토어에서 확장 추가하기</a></p>')}
        ${step(2, '"Chrome에 추가"를 누릅니다', '확인 창이 뜨면 "확장 프로그램 추가"를 누릅니다. 끝입니다. 다음부터는 저절로 업데이트됩니다.')}
        ${step(3, '이 사이트를 새로고침합니다', '맨 위에 "설치되어 있습니다"가 보이면 됩니다.', '7-site-ok.jpg')}
      </ol>`
      : `<ol class="steps">
        ${step(1, '확장 파일 받기', '아래 버튼을 누르면 <b>ssakda-extension.zip</b> 파일이 다운로드 폴더에 받아집니다.<p><a class="btn primary" href="/api/extension.zip">확장 파일 받기</a></p>', '1-download.jpg')}
        ${step(2, '압축 풀기', '받은 파일을 <b>마우스 오른쪽 버튼</b>으로 누르고 <b>모두 압축 풀기...</b> → <b>압축 풀기</b>를 누릅니다. 같은 이름의 폴더가 생깁니다. 이 폴더는 <b>지우지 마세요</b>.', '2-unzip.jpg')}
        ${step(3, '크롬 확장 화면을 열고 개발자 모드 켜기', `크롬 주소창에 아래 주소를 붙여넣고 Enter를 누른 뒤, 오른쪽 위의 <b>개발자 모드</b>를 켭니다.<p><code>chrome://extensions</code> <button class="btn small" id="copyExt">주소 복사</button></p>`, '3-devmode.jpg')}
        ${step(4, '"압축해제된 확장 프로그램 로드" 누르기', '개발자 모드를 켜면 왼쪽 위에 나타납니다.', '4-load.jpg')}
        ${step(5, '폴더 고르기', '2번에서 생긴 <b>ssakda-extension</b> 폴더를 한 번 누르고 <b>폴더 선택</b>을 누릅니다.', '5-pick-folder.jpg')}
        ${step(6, '설치 끝', '싹다클린 AI 비서가 보이면 설치된 것입니다. 크롬 오른쪽 위 퍼즐 모양을 눌러 핀을 꽂아 두면 아이콘이 늘 보입니다.', '6-installed.jpg')}
        ${step(7, '이 사이트를 새로고침', '맨 위에 "설치되어 있습니다"가 보이면 됩니다.', '7-site-ok.jpg')}
      </ol>
      <p class="muted">어려우면 이 화면을 설치를 도와줄 분께 보여 주세요. 처음 한 번만 하면 됩니다.</p>`;
    body = `
  <div class="card guide">
    <h2>숨고 채팅 자동 응대</h2>
    <div class="state-line">${extState}</div>
  </div>

  <div class="card guide">
    <h2>영상으로 보기</h2>
    <div class="videos">${extStore ? '' : video('install', '처음 설치하기 (1분)')}${video('daily', '매일 쓰는 법 (1분)')}</div>
  </div>

  <div class="card guide">
    <h2>이렇게 동작합니다</h2>
    <ul>
      <li>사장님 PC 크롬에 <b>싹다클린 AI 비서 확장</b>을 한 번 설치해 둡니다.</li>
      <li>이 사이트 첫 화면에서 <b>켜기</b>를 누르면 PC 크롬에 숨고 창이 열립니다. 숨고 로그인은 평소처럼 그 창에서 직접 합니다.</li>
      <li>1분마다 숨고 채팅 목록을 확인하고, 새 채팅방이 생기면 그 방을 새 탭으로 열어 AI가 첫 응대(확인할 것과 필요한 사진 요청)를 씁니다.</li>
      <li>"채팅창에 써 두고 멈춤"이면 채팅창에 써 두기만 하고, 사장님이 읽어 보고 전송을 누릅니다. "자동으로 보내기"면 바로 보냅니다. 방식은 설정에서 바꿉니다.</li>
      <li>켜기 전에 있던 채팅방, 이미 대화 중인 방, 업무와 관계없는 요청, 연락처나 금액이 들어간 답장은 보내지 않고 이유를 남깁니다.</li>
      <li>PC와 크롬이 켜져 있어야 동작합니다. 휴대폰에서는 이 사이트로 상태를 보고 켜고 끌 수 있습니다.</li>
    </ul>
  </div>

  <div class="card guide">
    <h2>처음 한 번: 확장 설치 (PC 크롬에서)</h2>
    ${install}
  </div>

  <div class="card guide">
    <h2>매일 쓰는 법</h2>
    <ol class="steps">
      ${step(1, '켜기', 'PC 크롬에서 이 사이트를 열고, 첫 화면의 <b>숨고 채팅 자동 응대</b>에서 <b>켜기</b>를 누릅니다. 이미 켜져 있으면 <b>창 열기</b>를 누릅니다.', '8-turn-on.jpg')}
      ${step(2, '숨고 로그인', '숨고 창이 뜹니다. 로그인 화면이면 평소처럼 로그인합니다. 아래쪽에 <b>싹다클린 AI 비서</b> 표시가 보입니다.', '9-soomgo-login.jpg')}
      ${step(3, '잘 되는지 확인', '이 사이트에 <b>PC 크롬에서 숨고 채팅 확인 중</b>이 보이면 잘 되고 있는 것입니다. 숨고 창은 닫지 말고 아래로 내려 두세요. 닫아도 1분 안에 작게 다시 열립니다.', '10-running.jpg')}
      ${step(4, '새 채팅방이 생기면', '그 방이 새 탭으로 열리고, 잠시 뒤 채팅창에 답장이 써집니다. 읽어 보고 괜찮으면 <b>전송</b>을 누릅니다.', '11-draft.jpg')}
    </ol>
  </div>

  <div class="card guide">
    <h2>문제가 생기면</h2>
    <dl>
      <dt>PC 크롬에서 비서가 동작하지 않고 있습니다</dt><dd>PC와 크롬이 켜져 있는지, chrome://extensions 에서 싹다클린 AI 비서가 켜져 있는지 확인해 주세요.</dd>
      <dt>확장 아이콘에 빨간 느낌표</dt><dd>아이콘을 눌러 이유를 봅니다. "접속 비밀번호를 넣어 주세요"면 PC 크롬에서 이 사이트에 접속해 비밀번호를 한 번 넣어 주세요.</dd>
      <dt>숨고 로그인이 필요합니다</dt><dd>숨고 창에서 로그인해 주세요. 창이 안 보이면 첫 화면의 창 열기를 누릅니다.</dd>
      <dt>처리할 문의에 "읽지 못함"</dt><dd>새 채팅방을 열었지만 읽지 못한 것입니다. 숨고에서 그 채팅방을 직접 확인해 주세요.</dd>
      <dt>답장이 써지지 않았습니다</dt><dd>그 문의를 열면 보내지 않은 이유가 적혀 있습니다. 문의 화면의 답장을 복사해 직접 보내도 됩니다.</dd>
    </dl>
  </div>

  <div class="card guide">
    <h2>확장 업데이트</h2>
    ${extStore
      ? '<p class="muted">웹스토어에서 설치한 확장은 저절로 업데이트됩니다.</p>'
      : `<p class="muted">비서가 바뀌어 확장도 새로 받아야 할 때는 첫 화면에 "확장 새 버전이 있습니다"가 뜹니다.</p>
    <ol class="steps">
      ${step(1, '새 파일 받기', '아래 버튼을 누르면 새 <b>ssakda-extension.zip</b> 파일이 다운로드 폴더에 받아집니다.<p><a class="btn primary" href="/api/extension.zip">확장 파일 받기</a></p>', '1-download.jpg')}
      ${step(2, '같은 폴더에 압축 풀기', '받은 파일을 <b>마우스 오른쪽 버튼</b>으로 누르고 <b>모두 압축 풀기...</b>를 누릅니다. 폴더 이름이 처음 설치한 폴더와 같은 <b>ssakda-extension</b>인지 보고, 끝에 <b>(1)</b> 같은 숫자가 붙어 있으면 지운 뒤 <b>압축 풀기</b>를 누릅니다.', 'u2-unzip-same.jpg')}
      ${step(3, '덮어쓰기', '"파일 바꾸기 또는 건너뛰기" 창이 뜨면 <b>대상 폴더의 파일 덮어쓰기</b>를 누릅니다. 이 창이 안 뜨면 폴더 이름이 달랐던 것이니 2번을 다시 확인해 주세요.', 'u3-replace.jpg')}
      ${step(4, '확장 새로고침', `크롬 주소창에 아래 주소를 붙여넣고 Enter를 누른 뒤, 싹다클린 AI 비서의 <b>동그란 화살표</b> 버튼을 누릅니다.<p><code>chrome://extensions</code> <button class="btn small" id="copyExt2">주소 복사</button></p>`, 'u4-reload.jpg')}
      ${step(5, '이 사이트를 새로고침', '맨 위에 "설치되어 있습니다"가 보이면 끝입니다.', '7-site-ok.jpg')}
    </ol>`}
    <p class="muted"><a href="/privacy.html" target="_blank">개인정보 처리방침</a></p>
  </div>`;
  }

  app.innerHTML = `
  <div class="card guide">
    <h2>사용 안내</h2>
    <p class="muted">무엇을 볼지 고르세요.</p>
    ${tabs}
  </div>${body}`;
  // 위의 탭을 누르면 그 안내로 바꿔 다시 그린다
  app.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => ((guideTab = b.dataset.g), renderGuide())));
  for (const id of ['copyExt', 'copyExt2']) document.getElementById(id)?.addEventListener('click', async () => toast((await copyText('chrome://extensions')) ? '복사했습니다. 크롬 주소창에 붙여넣어 주세요.' : '복사가 안 됩니다. 직접 입력해 주세요.'));
  document.getElementById('copyAgent')?.addEventListener('click', async () => toast((await copyText(AGENT_INSTALL)) ? '복사했습니다. PowerShell 창에 붙여넣어 주세요.' : '복사가 안 됩니다. 명령을 길게 눌러 복사해 주세요.'));
}

// ---------- 시작 ----------
// 주소 뒤의 # 부분을 보고 알맞은 화면을 그린다: #/i/번호는 문의 한 건, #/new는 새 문의, #/settings는 설정, 그 밖에는 목록
async function route() {
  // 아직 서버에서 설정을 받기 전(로그인 전)이면 아무것도 그리지 않는다
  if (!config) return;
  const h = location.hash;
  try {
    if (h.startsWith('#/i/')) await renderDetail(h.slice(4));
    else if (h === '#/new') renderNew();
    else if (h === '#/settings') await renderSettings();
    else if (h.startsWith('#/guide')) {
      // #/guide/talk로 오면 카톡 일감 잡기 안내를 연다
      if (h === '#/guide/talk') guideTab = 'talk';
      await renderGuide();
    }
    else await renderList();
    // 화면 맨 위로 올리고, 바로 보여줄 칸이 정해져 있으면 그 칸으로 내려간다
    window.scrollTo(0, 0);
    if (focusCard) document.getElementById(focusCard)?.scrollIntoView();
    focusCard = null;
  } catch (e) {
    // 그리다가 오류가 나면 그 문구를 보여준다 (로그인 화면이 뜬 경우는 빼고)
    if (e.message !== '로그인이 필요합니다.') app.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

// 처음 시작: 서버에서 설정을 받아 오고 화면을 그린다. 로그인이 안 돼 있으면 api가 로그인 화면을 띄운다
async function boot() {
  try {
    const state = await api('/api/state');
    config = state.config;
    kakaoState = state.kakao;
    // 견적 기능을 숨겼으면 맨 위의 '새 문의' 버튼도 숨긴다
    quoteFeatures = state.quoteFeatures !== false;
    document.getElementById('newBtn').hidden = !quoteFeatures;
    serverMode = Boolean(state.serverMode);
    extLatest = state.extLatest || '';
    extStore = state.extStore || '';
    // 서버에서 돌면 맨 위에 '안내' 버튼을 보여준다
    document.getElementById('guideBtn').hidden = !serverMode;
    route();
  } catch {
    // 로그인 화면이 이미 표시됨
  }
}

// 주소의 # 부분이 바뀔 때마다 화면을 다시 그리고, 지금 바로 한 번 시작한다
window.addEventListener('hashchange', route);
boot();
