// 숨고 페이지 안(숨고 화면과 같은 자리, MAIN)에서 확장의 손발 노릇을 한다. background.js가 시키는 일을 한다:
// list(채팅 목록과 로그인한 계정 번호), read(채팅방 화면의 글과 사진 주소), fill(채팅창에 답장 써 두기), send(써 넣고 전송).
// 채팅방 화면 말고 다른 화면(프로필 등)은 열지 않는다.
// background.js는 일할 때마다 이 파일의 최신본을 비서 서버(/api/ext/page.js)에서 받아 쓴다. 그래서 숨고 화면이 바뀌어 여기를 고치면
// 서버에 올리기만 해도 사장님 PC에 바로 적용된다. 서버에서 받지 못하면 확장에 든 이 파일을 쓴다.
window.__ssakdaPage = (() => {
  // hook.js가 모아 둔 것: 화면이 받은 채팅방 목록 데이터(chats), 실시간 연결 표의 답(token)
  const hooked = () => window.__ssakdaHook || {};

  // 실시간 연결 표(JWT)의 가운데 부분을 풀어 'private-userid-123' 같은 채널 이름에서 계정 번호를 꺼낸다. 없으면 null
  function accountFromSocketToken(body) {
    try {
      const part = String(body?.response?.token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(part + '==='.slice((part.length + 3) % 4)));
      for (const ch of payload.channels || []) {
        const m = /^private-userid-(\d+)$/.exec(ch);
        if (m) return m[1];
      }
    } catch {
      // 모양이 다르면 계정을 모르는 것으로 친다
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 조건이 맞을 때까지 기다린다(ms까지). 맞으면 그 값을, 끝내 안 맞으면 마지막 값을 돌려준다
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return fn();
  }
  // 지금 주소가 로그인 화면이면 로그인이 풀린 것으로 본다
  const loggedOut = () => /\/(login|sign-?in|auth)/i.test(location.pathname);
  // 화면에 보이는지
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  // 본문 칸(없으면 화면 전체)
  const mainEl = () => document.querySelector('main') || document.body;

  // 채팅 목록 화면에서: 로그인한 계정 번호, 채팅방 번호들(위가 최근), 목록 데이터의 채팅방 수(못 받았으면 null)
  async function list() {
    if (loggedOut()) return { loggedOut: true };
    const account = () => accountFromSocketToken(hooked().token);
    await waitFor(() => hooked().chats && account(), 20000);
    if (loggedOut()) return { loggedOut: true };
    // 채팅방 링크가 그려질 시간을 준다
    await sleep(1500);
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    let ids = [...new Set(hrefs.map((h) => /^(?:https:\/\/soomgo\.com)?\/pro\/chats\/([\w-]+)/.exec(h || '')?.[1]).filter(Boolean))];
    const results = hooked().chats?.results || null;
    // 화면에 링크가 없으면 목록 데이터의 번호를 쓴다
    if (!ids.length && results) ids = results.map((r) => r?.id).filter((v) => v != null).map(String);
    return { account: account(), ids, count: results ? results.length : null };
  }

  // 채팅방 화면에서: 본문 글(요청서와 지금까지의 대화)과 고객이 올린 사진 주소(6장까지)
  async function read() {
    if (loggedOut()) return { loggedOut: true };
    // 본문 글자 수가 1.5초 동안 그대로면 다 나온 것으로 본다 (15초까지)
    let last = -1;
    let still = 0;
    for (let i = 0; i < 60 && still < 6; i++) {
      await sleep(250);
      const n = mainEl().innerText.length;
      still = n > 0 && n === last ? still + 1 : 0;
      last = n;
    }
    const text = mainEl().innerText.trim();
    // 숨고에 올라간 사진 가운데 프로필 사진이 아니고 충분히 큰 것
    const images = [...document.images]
      .filter((i) => i.naturalWidth >= 200 && i.naturalHeight >= 200)
      .map((i) => i.currentSrc || i.src)
      .filter((u) => /^https:\/\/[\w.-]+\.soomgo\.com\//.test(u) && /\/upload\//.test(u) && !/\/profile\//.test(u));
    return { text: text.slice(0, 11000), images: [...new Set(images)].slice(0, 6) };
  }

  // 채팅 입력칸: 화면 아래쪽의 글 칸(textarea). 없으면 글을 쓸 수 있는 칸(contenteditable)
  const findBox = () => [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible).at(-1) || null;
  const boxText = (box) => ('value' in box ? box.value : box.innerText);
  // 입력칸에 글을 넣는다. 숨고 화면(React)이 알아채도록 사람이 친 것과 같은 알림(input)을 보낸다
  // 먼저 사람이 친 것처럼 넣고(insertText: 숨고 화면이 글자가 들어온 것을 확실히 알아채 전송 버튼을 켠다), 안 되면 값을 직접 넣는다
  function setText(box, text) {
    box.focus();
    if (box instanceof HTMLTextAreaElement) box.select();
    else document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
    if (box instanceof HTMLTextAreaElement && box.value !== text) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // 채팅창에 답장을 써 두고 멈춘다. 전송은 사장님이 누른다
  async function fill({ text }) {
    if (loggedOut()) return { error: '숨고 로그인이 풀려 있습니다.' };
    const box = await waitFor(findBox, 20000);
    if (!box) return { error: '채팅 입력칸을 찾지 못했습니다.' };
    if (box.disabled || box.readOnly) return { error: '채팅 입력칸이 막혀 있습니다. 숨고가 아직 메시지를 보낼 수 없게 해 둔 채팅방일 수 있습니다.' };
    setText(box, String(text).slice(0, 1000));
    await sleep(300);
    if (!boxText(box).trim()) return { error: '채팅 입력칸에 글을 넣지 못했습니다.' };
    box.scrollIntoView({ block: 'center' });
    return { prepared: true };
  }

  // 전송 버튼: '전송'이나 '보내기'라고 적힌(또는 그런 이름표가 붙은) 버튼.
  // 없으면 입력칸 바로 오른쪽, 같은 높이에 있는 가장 가까운 버튼(숨고 웹은 글자 없는 동그란 ↑ 아이콘 버튼이다)
  // 누를 수 있는 것들: 버튼, 그리고 아이콘(svg)이 든 손가락 모양 칸(버튼이 아닌 칸으로 만든 화면도 있다)
  function clickables() {
    const set = new Set(document.querySelectorAll('button, [role="button"]'));
    for (const svg of document.querySelectorAll('svg')) {
      let el = svg.parentElement;
      for (let i = 0; el && i < 3; i++, el = el.parentElement) if (getComputedStyle(el).cursor === 'pointer') { set.add(el); break; }
    }
    return [...set].filter(visible);
  }
  // 입력칸 오른쪽(120픽셀 안), 같은 높이이거나 입력칸 아래쪽 끝 근처에 있는 것
  const besideBox = (r, q) => q.left >= r.right - 8 && q.left - r.right < 120 && q.top + q.height / 2 > r.top - 10 && q.top + q.height / 2 < r.bottom + 60;
  function findSendButton(box) {
    const buttons = clickables();
    const named = buttons.filter((b) => /^\s*(전송|보내기)\s*$/.test(b.innerText) || /전송|보내|send/i.test(b.getAttribute('aria-label') || '')).at(-1);
    if (named) return named;
    const r = box.getBoundingClientRect();
    const near = buttons
      .map((b) => ({ b, q: b.getBoundingClientRect() }))
      .filter(({ b }) => !b.contains(box) && !box.contains(b) && !b.innerText.trim())
      .filter(({ q }) => besideBox(r, q))
      .sort((x, y) => x.q.left - y.q.left);
    return near[0]?.b || null;
  }
  // 전송 버튼을 못 찾았을 때 고치는 데 쓸 기록: 입력칸 자리와 그 주변(입력칸 아래쪽 200픽셀 안)의 누를 수 있는 것들
  function sendDiag(box) {
    const rect = (q) => `${Math.round(q.left)},${Math.round(q.top)} ${Math.round(q.width)}x${Math.round(q.height)}`;
    const r = box.getBoundingClientRect();
    const near = [...document.querySelectorAll('button, [role="button"], svg')]
      .map((el) => ({ el, q: el.getBoundingClientRect() }))
      .filter(({ q }) => q.width && Math.abs(q.top + q.height / 2 - (r.top + r.height / 2)) < r.height / 2 + 200)
      .slice(-15)
      .map(({ el, q }) => `${el.tagName.toLowerCase()}${el.disabled ? '[disabled]' : ''}${el.getAttribute('aria-disabled') === 'true' ? '[aria-disabled]' : ''} ${rect(q)} cls=${String(el.getAttribute('class') || '').slice(0, 60)} label=${el.getAttribute('aria-label') || ''} text=${(el.innerText || '').trim().slice(0, 10)}`);
    return `창 ${innerWidth}x${innerHeight}, 입력칸 ${box.tagName.toLowerCase()} ${rect(r)}\n${near.join('\n')}`;
  }

  // 채팅창에 답장을 써 넣고 전송한다. 한 번만 누르고, 보내졌는지 확인되지 않으면 더 누르지 않는다
  async function send({ text }) {
    const r = await fill({ text });
    if (!r.prepared) return r;
    const box = findBox();
    // 글을 넣은 뒤 버튼이 눌릴 수 있게 바뀔 때까지 잠깐 기다린다 (3초까지)
    const btn = await waitFor(() => {
      const b = findSendButton(box);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 3000);
    if (!btn) return { prepared: true, note: '전송 버튼을 찾지 못해 채팅창에 써 두기만 했습니다. 확인하고 전송을 눌러주세요.', diag: sendDiag(box) };
    btn.click();
    // 보내졌다는 표시: 입력칸이 비워지고 보낸 글이 화면에 나타났다 (15초까지)
    const head = String(text).trim().split('\n')[0].slice(0, 20);
    const ok = await waitFor(() => !boxText(box).trim() && document.body.innerText.includes(head), 15000);
    return ok ? { sent: true } : { error: '전송을 눌렀지만 보내졌는지 확인되지 않았습니다. 숨고에서 직접 확인해 주세요.' };
  }

  return { list, read, fill, send };
})();
