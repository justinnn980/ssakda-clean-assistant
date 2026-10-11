import { calc, won, rangeText } from '/pricing.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let config = null;
let kakaoState = null;
let pollTimer = null;

const STATUS = { analyzing: '분석 중', awaiting_owner: '승인 대기', sent: '전송 완료', on_hold: '보류', rejected: '거절', booked: '예약 확정', error: '분석 실패' };
const RISK = { low: '일반', review: '확인 필요', high: '사장님 검토 필수' };
const YN = { yes: '필요', no: '불필요', unknown: '현장 확인 필요' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 2500);
}

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
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
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
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}
const readImages = (input) => Promise.all([...input.files].map(shrink));

const manText = (n) => (n % 10000 === 0 ? `${(n / 10000).toLocaleString('ko-KR')}만` : n.toLocaleString('ko-KR'));
const customerPrice = (r) => (r.min === r.max ? `${manText(r.min)} 원` : `${manText(r.min)}~${manText(r.max)} 원`);

// ---------- 로그인 ----------
function renderLogin() {
  clearInterval(pollTimer);
  app.innerHTML = `<div class="card"><h2>접속 비밀번호</h2>
    <p class="muted">노트북에서 프로그램을 켤 때 화면에 표시된 숫자입니다.</p>
    <input id="pin" type="password" inputmode="numeric" autocomplete="current-password">
    <p><button class="btn primary block" id="go">들어가기</button></p></div>`;
  const go = async () => {
    try {
      await api('/api/login', { pin: document.getElementById('pin').value });
      await boot();
    } catch (e) {
      toast(e.message);
    }
  };
  document.getElementById('go').onclick = go;
  document.getElementById('pin').onkeydown = (e) => e.key === 'Enter' && go();
}

// ---------- 목록 ----------
let listFilter = 'todo';
async function renderList() {
  const items = await api('/api/inquiries');
  const filters = { todo: '처리할 문의', sent: '전송 완료', booked: '예약', etc: '보류·거절' };
  const match = { todo: ['analyzing', 'awaiting_owner', 'error'], sent: ['sent'], booked: ['booked'], etc: ['on_hold', 'rejected'] };
  const shown = items.filter((i) => match[listFilter].includes(i.status));
  const kakaoNote = !kakaoState.configured
    ? ''
    : kakaoState.connected
      ? '<p class="muted">카카오톡 알림 연결됨</p>'
      : '<p><a class="btn small" href="/kakao/login">카카오톡 알림 연결하기</a></p>';
  const sg = (await api('/api/state')).soomgo;
  const soomgoNote =
    sg.state === 'off' || sg.state === 'ok'
      ? ''
      : `<a class="card item err" href="#/settings">${sg.state === 'login' ? '숨고 로그인이 필요합니다. 노트북의 크롬 창에서 로그인해 주세요.' : esc(sg.message || '숨고 확인을 시작하는 중입니다.')}</a>`;
  app.innerHTML = `${soomgoNote}<div class="tabs">${Object.entries(filters)
    .map(([k, v]) => `<button class="tab ${k === listFilter ? 'on' : ''}" data-f="${k}">${v} ${items.filter((i) => match[k].includes(i.status)).length}</button>`)
    .join('')}</div>
    ${shown.length ? '' : '<div class="card muted">해당하는 문의가 없습니다. 오른쪽 위 "새 문의"로 숨고 캡처를 올려주세요.</div>'}
    ${shown
      .map(
        (i) => `<a class="card item" href="#/i/${i.id}">
        <div class="item-title">${esc(i.title)}</div>
        <div><span class="badge ${i.status === 'error' ? 'error' : 'state'}">${STATUS[i.status]}</span>${i.risk ? `<span class="badge ${i.risk}">${RISK[i.risk]}</span>` : ''}</div>
        <div class="muted">${esc(i.region || '')} · ${when(i.updatedAt)}</div></a>`,
      )
      .join('')}${kakaoNote}`;
  app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => ((listFilter = b.dataset.f), renderList())));
  clearInterval(pollTimer);
  const every = items.some((i) => i.status === 'analyzing') ? 5000 : sg.state === 'off' ? 0 : 60000;
  if (every) pollTimer = setInterval(() => location.hash.length <= 2 && renderList(), every);
}

// ---------- 새 문의 ----------
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
  const inq = await api(`/api/inquiries/${id}`);
  const a = inq.analysis;

  const thread = `<details class="card" ${a ? '' : 'open'}><summary>문의·대화 기록 (${inq.messages.length})</summary><p></p>
    ${inq.messages
      .map(
        (m) => `<div class="msg ${m.from}"><div class="muted">${m.from === 'owner' ? '사장님' : '고객'} · ${when(m.at)}</div>${esc(m.text)}
        <div class="thumbs">${(m.images || []).map((f) => `<a href="/api/inquiries/${id}/photo/${f}" target="_blank"><img src="/api/inquiries/${id}/photo/${f}" alt="첨부 사진"></a>`).join('')}</div></div>`,
      )
      .join('')}</details>`;

  if (inq.status === 'analyzing') {
    app.innerHTML = `<div class="card"><h2>${esc(inq.title)}</h2><div class="spinner"></div><p class="muted" style="text-align:center">AI가 분석하고 있습니다. 보통 1분 안에 끝납니다.</p></div>${thread}`;
    pollTimer = setInterval(async () => {
      const cur = await api(`/api/inquiries/${id}`).catch(() => null);
      if (cur && cur.status !== 'analyzing' && location.hash === `#/i/${id}`) renderDetail(id);
    }, 3000);
    return;
  }

  if (!a) {
    app.innerHTML = `<div class="card"><h2>${esc(inq.title)}</h2><p class="err">분석에 실패했습니다: ${esc(inq.error)}</p>
      <button class="btn primary block" id="retry">다시 분석</button></div>${thread}`;
    document.getElementById('retry').onclick = async () => (await api(`/api/inquiries/${id}/reanalyze`, {}), renderDetail(id));
    return;
  }

  const inputs = { ...inq.estimateInputs };
  let chosenPrice = inq.finalPrice;
  const field = (key, label, step = 1) => `<div><label>${label}</label><input type="number" inputmode="decimal" min="0" step="${step}" data-k="${key}" value="${inputs[key] ?? ''}" placeholder="미정"></div>`;
  const li = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '없음');
  const isCleaning = a.job_category === 'cleaning';

  app.innerHTML = `
  <div class="card">
    <h2>${esc(inq.title)}</h2>
    <div><span class="badge state">${STATUS[inq.status]}</span><span class="badge ${a.risk_level}">${RISK[a.risk_level]}</span></div>
    ${inq.error ? `<p class="err">최근 재분석 실패: ${esc(inq.error)}</p>` : ''}
    ${a.review_reasons?.length ? `<p class="muted">검토 사유: ${esc(a.review_reasons.join(' / '))}</p>` : ''}
  </div>

  <div class="card">
    <h2>⑪ 숨고에 보낼 답변</h2>
    <textarea class="reply" id="reply">${esc(inq.draftReply)}</textarea>
    <p class="row">
      <button class="btn small" id="useInfo">정보 요청 답변</button>
      <button class="btn small" id="useEst">견적 안내 답변</button>
    </p>
    <button class="btn primary block" id="approve">승인하고 복사</button>
    <p class="muted">복사된 글을 숨고 앱에 붙여넣어 직접 보내주세요. 이 프로그램은 숨고에 접속하지 않습니다.</p>
  </div>

  <div class="card">
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

  <div class="card">
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

  const replyEl = document.getElementById('reply');
  const pricesEl = document.getElementById('prices');
  app.querySelector('[data-k="marginType"]').value = inputs.marginType || 'general';

  let saveTimer;
  const saveDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api(`/api/inquiries/${id}/draft`, { estimateInputs: inputs, draftReply: replyEl.value }).catch(() => {}), 800);
  };
  const makeEstimateReply = (priceText) => {
    replyEl.value = a.reply_with_estimate.replaceAll('{{견적}}', priceText);
    chosenPrice = priceText;
    saveDraft();
    replyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('견적 안내 답변으로 바꿨습니다. 내용을 확인해 주세요.');
  };

  const drawPrices = () => {
    const { table, cost } = calc(config, inputs);
    const box = (key, title, r, detail) => `<div class="price"><div class="muted">${title}</div><b>${rangeText(r)}</b>
      ${r ? `<div class="muted">${detail}</div><p><button class="btn small" data-use="${key}">이 금액으로 답변 만들기</button></p>` : '<div class="muted">위 칸을 채우면 계산됩니다.</div>'}</div>`;
    pricesEl.innerHTML =
      box('table', '단가표 기준 (차량 35~40만 + 인원 15~20만)', table, table ? `사다리차 ${won(table.ladder)} 포함` : '') +
      box('cost', '원가 기준 (원가 ÷ (1 − 이익률))', cost, cost ? `총원가 ${won(cost.total)} · 이익률 ${Math.round(cost.marginMin * 100)}${cost.marginMax !== cost.marginMin ? `~${Math.round(cost.marginMax * 100)}` : ''}%` : '');
    pricesEl.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => makeEstimateReply(customerPrice(b.dataset.use === 'table' ? table : cost))));
  };
  drawPrices();

  app.querySelectorAll('[data-k]').forEach((el) => {
    el.oninput = () => {
      const k = el.dataset.k;
      inputs[k] = k === 'marginType' ? el.value : el.value === '' ? null : Number(el.value);
      drawPrices();
      saveDraft();
    };
  });
  replyEl.oninput = saveDraft;

  document.getElementById('useInfo').onclick = () => ((replyEl.value = a.reply_need_info), (chosenPrice = null), saveDraft());
  document.getElementById('useEst').onclick = () => ((replyEl.value = a.reply_with_estimate), saveDraft(), toast('{{견적}} 자리에 금액을 넣어주세요.'));
  document.getElementById('useManual').onclick = () => {
    const v = Number(document.getElementById('manual').value);
    if (!v) return toast('금액을 입력해 주세요.');
    makeEstimateReply(customerPrice({ min: v, max: v }));
  };

  document.getElementById('approve').onclick = async () => {
    const reply = replyEl.value.trim();
    if (!reply) return toast('보낼 답변이 비어 있습니다.');
    if (reply.includes('{{견적}}')) return toast('답변에 {{견적}} 자리가 남아 있습니다. 금액을 넣어주세요.');
    try {
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

// ---------- 설정 (켜고 끄기) ----------
async function renderSettings() {
  clearInterval(pollTimer);
  const st = await api('/api/state');
  const sg = st.soomgo;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const viaTunnel = location.hostname.endsWith('trycloudflare.com');

  const soomgoLine = !st.settings.soomgo
    ? '<span class="dot"></span>꺼져 있습니다. 새 요청서는 캡처해서 직접 올립니다.'
    : sg.state === 'ok'
      ? `<span class="dot on"></span>잘 되고 있습니다. ${esc(sg.message)}${sg.lastCheck ? ` · 마지막 확인 ${when(sg.lastCheck)}` : ''}`
      : sg.state === 'login'
        ? '<span class="dot wait"></span>노트북에 열린 크롬 창에서 숨고에 로그인해 주세요. 로그인하면 자동으로 시작됩니다.'
        : sg.state === 'error'
          ? `<span class="dot bad"></span>${esc(sg.message)}`
          : '<span class="dot wait"></span>시작하는 중입니다.';

  const tunnelLine = !st.settings.tunnel
    ? '<span class="dot"></span>꺼져 있습니다. 집 와이파이 안에서만 접속됩니다.'
    : st.tunnelUrl
      ? `<span class="dot on"></span>켜져 있습니다. 밖에서는 아래 주소로 접속하세요.<br><b>${esc(st.tunnelUrl)}</b>
         <p><button class="btn small" id="copyUrl">주소 복사</button></p>
         <span class="muted">이 주소는 프로그램을 껐다 켜면 바뀝니다.</span>`
      : '<span class="dot wait"></span>주소를 만드는 중입니다. 잠시만 기다려 주세요.';

  const sw = (id, on) => `<label class="switch" aria-label="켜기 끄기"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;

  app.innerHTML = `
  <div class="card"><span class="dot on"></span><b>프로그램이 켜져 있습니다</b>
    <p class="muted">노트북이 켜져 있는 동안 계속 동작합니다. 노트북 덮개를 닫으면 멈춥니다.</p></div>

  <div class="card">
    <div class="setting"><div><h2>숨고 새 요청 자동으로 가져오기</h2>
      <div class="muted">3분마다 숨고 "받은 요청"을 확인해서 새 요청서를 알아서 등록합니다. 읽기만 하고, 답장은 보내지 않습니다.</div></div>
      ${sw('swSoomgo', st.settings.soomgo)}</div>
    <div class="state-line">${soomgoLine}</div>
  </div>

  <div class="card">
    <div class="setting"><div><h2>밖에서도 접속하기</h2>
      <div class="muted">집 밖에서 휴대폰으로 볼 수 있는 주소를 만듭니다. 주소와 비밀번호는 다른 사람에게 알려주지 마세요.</div></div>
      ${sw('swTunnel', st.settings.tunnel)}</div>
    <div class="state-line">${tunnelLine}</div>
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

  <div class="card">
    <h2>프로그램 끄기</h2>
    <p class="muted">끄면 문의 분석과 숨고 확인이 모두 멈춥니다. 다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 누르세요.</p>
    <button class="btn danger block" id="off">프로그램 끄기</button>
  </div>`;

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
  document.getElementById('swSoomgo').onchange = (e) =>
    change('soomgo', e.target, e.target.checked && !local ? '켜면 노트북에 크롬 창이 열립니다. 처음에는 노트북 앞에서 숨고에 로그인해야 합니다. 켤까요?' : '');
  document.getElementById('swTunnel').onchange = (e) =>
    change('tunnel', e.target, !e.target.checked && viaTunnel ? '지금 밖에서 접속 중입니다. 끄면 이 화면이 바로 끊기고, 집에 가서 다시 켜야 합니다. 끌까요?' : '');
  const copyBtn = document.getElementById('copyUrl');
  if (copyBtn) copyBtn.onclick = async () => toast((await copyText(st.tunnelUrl)) ? '주소를 복사했습니다.' : '복사가 안 됩니다. 주소를 길게 눌러 복사해 주세요.');
  document.getElementById('off').onclick = async () => {
    if (!confirm('프로그램을 끌까요?\n다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 눌러야 합니다.')) return;
    await api('/api/shutdown', {}).catch(() => {});
    app.innerHTML = '<div class="card"><span class="dot"></span><b>프로그램을 껐습니다</b><p class="muted">다시 켜려면 노트북 바탕화면의 "싹다클린 AI 비서"를 두 번 누르세요.</p></div>';
  };

  // 상태가 바뀌는 중이면 자동으로 새로 고친다
  const waiting = (st.settings.soomgo && sg.state !== 'ok') || (st.settings.tunnel && !st.tunnelUrl);
  if (waiting) pollTimer = setInterval(() => location.hash === '#/settings' && !document.querySelector('.switch input:disabled') && renderSettings(), 4000);
}

// ---------- 시작 ----------
async function route() {
  if (!config) return;
  const h = location.hash;
  try {
    if (h.startsWith('#/i/')) await renderDetail(h.slice(4));
    else if (h === '#/new') renderNew();
    else if (h === '#/settings') await renderSettings();
    else await renderList();
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.message !== '로그인이 필요합니다.') app.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

async function boot() {
  try {
    const state = await api('/api/state');
    config = state.config;
    kakaoState = state.kakao;
    route();
  } catch {
    // 로그인 화면이 이미 표시됨
  }
}

window.addEventListener('hashchange', route);
boot();
