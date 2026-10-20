// 싹다클린 AI 비서 확장의 본체. 사장님 PC 크롬에서 돈다.
// 1분마다(크롬 알람) 숨고 창의 채팅 목록을 새로 불러와 읽고, 서버가 처음 보는 채팅방이라고 하면 그 방을 새 탭에서 열어
// 글과 사진을 서버로 보낸다. 서버의 AI가 첫 응대를 쓰면 그 탭의 채팅창에 써 넣는다(서버 설정이 '자동으로 보내기'면 전송까지).
// 켜짐·꺼짐과 답장 방식은 서버(비서 사이트)의 설정을 따르고, 지금 상태를 서버에 알린다. 서버 주소는 비서 사이트를 열 때 site.js가 알려 준다.
const CHATS_URL = 'https://soomgo.com/pro/chats';
// 받아들이는 비서 사이트 주소 (이 PC의 다른 프로그램이 비서 서버 행세를 하지 못하게 정해 둔다)
const SERVER_RE = /^https:\/\/ssakda\.sect\.kr$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 지금 상태: off 꺼짐, starting 여는 중, login 숨고 로그인 필요, ok 정상, error 문제. work는 AI 비서가 지금 하는 일
const status = { state: 'off', message: '', lastCheck: null, lastNew: null, account: null, work: '' };
// 확인이 돌고 있는지 (앞의 확인이 끝나기 전에 또 시작하지 않게)
let busy = false;
// 지금 답장을 쓰고 있는 채팅방 탭 (AI 비서가 하는 일을 그 탭에도 보여준다)
let roomTabId = null;
// 크롬이 이 확장을 잠시 쉬게 했다가 다시 깨우면, 마지막 상태를 이어받는다. 다 읽기 전에는 확인을 시작하지 않는다
const restored = chrome.storage.local.get('status').then(({ status: saved }) => saved && Object.assign(status, saved, { work: '' }));

// ---------- 서버 ----------
const serverUrl = async () => (await chrome.storage.local.get('server')).server || 'https://ssakda.sect.kr';
// 서버에 묻는다. body가 있으면 보내기(POST). 비서 사이트의 접속 비밀번호 표(쿠키)를 함께 보낸다
async function api(path, body) {
  const res = await fetch(`${await serverUrl()}${path}`, {
    credentials: 'include',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (res.status === 401) throw new Error('PC 크롬에서 비서 사이트에 접속해 접속 비밀번호를 넣어 주세요.');
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `비서 서버 오류 (${res.status})`);
  return json;
}
// 상태를 바꾸고 서버에 알린다. 서버는 채팅 자동 응대를 켜 두었는지(chat)와 답장 방식(chatMode)을 돌려준다
async function report(patch = {}) {
  Object.assign(status, patch);
  await chrome.storage.local.set({ status });
  showWork();
  return api('/api/ext/status', status);
}

// ---------- 숨고 창 ----------
// AI 비서가 쓰는 숨고 탭. 없으면 새 창으로 연다(open이면 앞에 띄우고, 아니면 작게 내려 둔 채로)
async function aiTab(open = false) {
  const { aiTabId } = await chrome.storage.session.get('aiTabId');
  let tab = aiTabId && (await chrome.tabs.get(aiTabId).catch(() => null));
  if (!tab) {
    const win = await chrome.windows.create({ url: CHATS_URL, ...(open ? { focused: true } : { state: 'minimized' }) });
    tab = win.tabs[0];
    await chrome.storage.session.set({ aiTabId: tab.id });
    await waitLoaded(tab.id);
  } else if (open) {
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
  }
  return tab;
}
// 탭이 다 열릴 때까지 기다린다 (45초까지)
function waitLoaded(tabId, ms = 45000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(on);
      clearTimeout(timer);
      resolve();
    };
    const on = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done);
  });
}
// 탭을 그 주소로 다시 불러오고, 새로 다 열릴 때까지 기다린다 (45초까지).
// 이미 열려 있던 화면의 '다 열림'에 속지 않도록, 불러오기를 시킨 뒤에 오는 '다 열림'만 기다린다
function navigate(tabId, url, ms = 45000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(on);
      clearTimeout(timer);
      resolve();
    };
    const on = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.update(tabId, { url }).catch(done);
  });
}
// 숨고 화면에서 하는 일(list·read·fill·send)은 page.js가 한다. 일할 때마다 서버에서 최신본을 받아 쓰므로,
// 숨고 화면이 바뀌어 page.js를 고쳐도 서버에 올리기만 하면 되고 확장을 다시 깔지 않는다. 서버에서 못 받으면 null(확장에 든 것을 쓴다)
async function pageCode() {
  try {
    const res = await fetch(`${await serverUrl()}/api/ext/page.js`, { credentials: 'include', cache: 'no-store' });
    if (res.ok) return await res.text();
  } catch {
    // 아래에서 확장에 든 page.js를 쓴다
  }
  return null;
}
// page.js를 숨고 탭(숨고 화면과 같은 자리)에 넣는다. 서버에서 받은 것이 들어가지 않으면 확장에 든 것을 넣는다
async function loadPage(tabId, code) {
  const target = { tabId };
  if (code) {
    try {
      await chrome.scripting.executeScript({ target, world: 'MAIN', func: (c) => new Function(c)(), args: [code] });
      return;
    } catch (e) {
      console.log('[비서] 서버의 page.js를 넣지 못해 확장에 든 것을 씀', e.message);
    }
  }
  await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['page.js'] });
}
// 숨고 탭에 일을 시키고 결과를 받는다. 막 열린 탭이면 준비될 때까지 몇 번 더 해 본다 (10초까지).
// 다시 해 보는 것은 준비 단계뿐이다. 일(특히 전송)은 한 번만 시킨다
async function ask(tabId, msg) {
  const onPage = ['list', 'read', 'fill', 'send'].includes(msg.cmd);
  const code = onPage ? await pageCode() : null;
  for (let i = 0; i < 20; i++) {
    if (!onPage) {
      const r = await chrome.tabs.sendMessage(tabId, msg).catch(() => null);
      if (r) return r;
    } else if (await loadPage(tabId, code).then(() => true, () => false)) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (m) => Promise.resolve(window.__ssakdaPage[m.cmd](m)).catch((e) => ({ error: e.message })),
        args: [msg],
      });
      if (res?.result) return res.result;
      throw new Error('숨고 탭이 일하는 도중에 바뀌었거나 응답하지 않습니다.');
    }
    await sleep(500);
  }
  throw new Error('숨고 탭이 닫혔거나 응답하지 않습니다.');
}
// 로그인 화면(숨고 로그인, 또는 카카오·네이버·애플·구글 로그인 창)인지. 그 화면에서는 사장님이 로그인 중일 수 있어 다시 불러오지 않는다.
// 빈 화면이나 오류 화면, 다른 사이트는 로그인 화면이 아니므로 채팅 목록으로 다시 불러온다
function isLoginUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    if (/(^|\.)soomgo\.com$/.test(hostname)) return /\/(login|sign-?in|auth)/i.test(pathname);
    return /(^|\.)(kakao\.com|naver\.com|apple\.com|google\.com|facebook\.com)$/.test(hostname);
  } catch {
    return false;
  }
}
// AI 비서가 하는 일을 숨고 탭(목록 탭과 답장을 쓰는 채팅방 탭) 아래쪽에 보여준다
function showWork() {
  const text = status.work || (status.state === 'ok' ? '새 채팅방을 기다리는 중' : status.state === 'login' ? '숨고에 로그인해 주세요' : '');
  chrome.storage.session.get('aiTabId').then(({ aiTabId }) => {
    for (const id of [aiTabId, roomTabId]) if (id) chrome.tabs.sendMessage(id, { cmd: 'banner', text }).catch(() => {});
  });
  chrome.action.setBadgeText({ text: ['login', 'error'].includes(status.state) ? '!' : '' });
  chrome.action.setBadgeBackgroundColor({ color: status.state === 'login' ? '#b45309' : '#b91c1c' });
}

// ---------- 1분마다 하는 확인 ----------
// 채팅 목록을 잇달아 못 읽은 횟수
let listMisses = 0;
async function tick() {
  await restored;
  if (busy) return console.log('[비서] 앞의 확인이 아직 도는 중이라 건너뜀');
  busy = true;
  console.log('[비서] 확인 시작');
  // 크롬은 30초 동안 크롬 기능을 쓰지 않는 확장을 잠재운다. AI가 첫 응대를 쓰는 동안(30초를 넘기기도 한다) 잠들지 않게 20초마다 깨워 둔다
  const keepAwake = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    // 서버에 상태를 알리고 설정을 받는다. 꺼져 있으면 아무것도 하지 않는다
    let cfg;
    try {
      cfg = await report();
    } catch (e) {
      Object.assign(status, { state: 'error', message: e.message });
      await chrome.storage.local.set({ status });
      return showWork();
    }
    if (!cfg.chat) {
      if (status.state !== 'off') await report({ state: 'off', message: '', work: '' });
      return;
    }
    if (status.state === 'off') await report({ state: 'starting', message: '숨고 창을 여는 중입니다.' });
    const tab = await aiTab();
    // 사장님이 로그인하는 중일 수 있으니 로그인 화면이면 건드리지 않는다
    const current = (await chrome.tabs.get(tab.id)).url || '';
    if (isLoginUrl(current)) return await report({ state: 'login', message: '숨고 로그인이 필요합니다. 숨고 창에서 로그인해 주세요.', work: '' });
    // 채팅 목록 화면을 새로 불러와 읽는다
    await report({ work: '채팅 목록을 확인하는 중' });
    await navigate(tab.id, CHATS_URL);
    const list = await ask(tab.id, { cmd: 'list' });
    status.lastCheck = new Date().toISOString();
    if (list.loggedOut) return await report({ state: 'login', message: '숨고 로그인이 필요합니다. 숨고 창에서 로그인해 주세요.', work: '' });
    if (!list.account) return await report({ state: 'error', message: '로그인한 숨고 계정을 확인하지 못했습니다. 잠시 뒤 다시 확인합니다.', work: '' });
    // 숨고 화면이 목록을 늦게 받으면 한 번쯤 못 읽을 수 있다. 두 번 잇달아 못 읽었을 때만 알린다
    if (list.count == null || (list.count && !list.ids.length)) {
      listMisses += 1;
      if (listMisses < 2) return await report({ work: '' });
      return await report({ state: 'error', message: '채팅 목록을 제대로 읽지 못했습니다. 화면 구조 확인이 필요합니다.', work: '' });
    }
    listMisses = 0;
    status.account = list.account;
    // 서버가 처음 보는 채팅방을 골라 준다 (그 계정을 처음 보면 지금 있는 채팅방은 모두 본 것으로 치고 아무것도 주지 않는다)
    const { fresh } = await api('/api/ext/claim', { account: list.account, ids: list.ids, count: list.count });
    await report({ state: 'ok', message: list.ids.length ? `채팅방 ${list.ids.length}개 확인` : '채팅방이 아직 없습니다. 새 채팅방을 기다리는 중입니다.', work: '' });
    for (const id of fresh) await handleRoom(tab, id, list.account);
  } catch (e) {
    console.log('[비서] 확인 중 오류', e.message);
    await report({ state: 'error', message: `숨고 확인 중 오류: ${e.message}`, work: '' }).catch(() => {});
  } finally {
    clearInterval(keepAwake);
    busy = false;
    console.log('[비서] 확인 끝', status.state, status.message);
  }
}

// 새 채팅방 하나: 새 탭에서 열어 글과 사진을 서버로 보내고, AI가 쓴 첫 응대를 그 탭의 채팅창에 써 넣는다
async function handleRoom(listTab, chatId, account) {
  let inquiryId = null;
  try {
    await report({ work: '새 채팅방을 여는 중' });
    const tab = await chrome.tabs.create({ windowId: listTab.windowId, url: `${CHATS_URL}/${chatId}`, active: true });
    roomTabId = tab.id;
    await waitLoaded(tab.id);
    await report({ work: '새 채팅방을 읽는 중' });
    const room = await ask(tab.id, { cmd: 'read' });
    if (room.loggedOut) throw new Error('숨고 로그인이 풀려 있습니다.');
    const images = await fetchImages(room.images || []);
    const { id } = await api('/api/ext/room', { chatId, account, text: room.text, images });
    inquiryId = id;
    status.lastNew = new Date().toISOString();
    await report({ work: '첫 응대를 쓰는 중' });
    const inq = await waitAnalysis(id);
    // AI가 보내지 않기로 했거나(이미 대화 중 등) 실패했으면 탭을 닫는다. 사유는 비서 사이트의 문의에 남아 있다
    if (!inq.extTask || inq.autoSend) {
      chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    // 그 사이 사장님이 직접 보냈으면(문의 화면의 '보낸 것으로 표시') 써 넣지 않는다
    const latest = await api(`/api/inquiries/${id}`);
    if (latest.autoSend || latest.status === 'sent') return;
    const sending = inq.extTask.mode === 'send';
    await report({ work: sending ? '답장을 보내는 중' : '채팅창에 답장을 쓰는 중' });
    const r = await ask(tab.id, { cmd: sending ? 'send' : 'fill', text: inq.extTask.reply });
    await api(`/api/inquiries/${id}/typed`, r);
    // 그 채팅방 탭의 표시를 결과로 바꿔 둔다
    const result = r.sent ? '답장을 보냈습니다' : r.prepared ? r.note || '답장을 써 두었습니다. 읽어 보고 전송을 눌러 주세요' : `답장을 쓰지 못했습니다: ${r.error}`;
    chrome.tabs.sendMessage(tab.id, { cmd: 'banner', text: result }).catch(() => {});
    // 보냈으면 탭을 닫고, 써 두었으면 사장님이 확인하고 전송하도록 열어 둔다
    if (r.sent) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 3000);
  } catch (e) {
    console.log('[비서] 채팅방 처리 실패', chatId, e.message);
    // 실패해도 다음 채팅방은 계속한다. 문의를 만든 뒤에 실패했으면(탭이 닫힘 등) 그 문의에 사유를 남기고,
    // 그 전이면(채팅방을 읽지 못함) 첫 화면에 보이도록 '읽지 못한 채팅방'으로 남긴다
    if (inquiryId) await api(`/api/inquiries/${inquiryId}/typed`, { error: e.message }).catch(() => {});
    else await api('/api/ext/failed', { chatId, account, error: e.message }).catch(() => {});
  } finally {
    roomTabId = null;
    await report({ work: '' }).catch(() => {});
  }
}

// AI가 첫 응대를 다 쓸 때까지 3초마다 문의를 다시 읽는다 (6분까지)
async function waitAnalysis(id) {
  for (let i = 0; i < 120; i++) {
    const inq = await api(`/api/inquiries/${id}`);
    if (inq.status !== 'analyzing') return inq;
    await sleep(3000);
  }
  throw new Error('AI가 6분 안에 첫 응대를 쓰지 못했습니다.');
}

// 고객이 올린 사진을 받아 긴 쪽 1600픽셀 이하 JPG로 줄여 글자 형태(data:image/jpeg;base64,...)로 바꾼다. 못 받은 사진은 건너뛴다
async function fetchImages(urls) {
  const out = [];
  for (const url of urls.slice(0, 6)) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const blob = await res.blob();
      if (!res.ok || !/^image\/(jpeg|png|webp)/.test(blob.type)) continue;
      const bmp = await createImageBitmap(blob);
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push(`data:image/jpeg;base64,${btoa(bin)}`);
    } catch {
      // 사진 한 장을 못 받아도 계속한다
    }
  }
  return out;
}

// ---------- 비서 사이트와 확장 아이콘 창에서 오는 일 ----------
// start(켜기: 숨고 창을 띄우고 바로 확인), open(창 열기), show(그 채팅방 탭 보기), stop(끄기), status(지금 상태), hello(서버 주소 알림)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.cmd !== 'status') console.log('[비서] 받은 일', msg.cmd);
  (async () => {
    if (msg.server && SERVER_RE.test(msg.server)) await chrome.storage.local.set({ server: msg.server });
    if (msg.cmd === 'start') {
      // 숨고 창을 앞에 띄우고 바로 확인한다. 창을 띄우지 못해도 확인은 시작한다(확인하면서 창을 다시 연다)
      await aiTab(true).catch((e) => console.log('[비서] 숨고 창을 띄우지 못함', e.message));
      tick();
    } else if (msg.cmd === 'open') await aiTab(true);
    else if (msg.cmd === 'show') {
      const [room] = await chrome.tabs.query({ url: `${CHATS_URL}/${msg.chatId}*` });
      if (room) {
        await chrome.tabs.update(room.id, { active: true });
        await chrome.windows.update(room.windowId, { focused: true, state: 'normal' });
      } else await aiTab(true);
    } else if (msg.cmd === 'stop') await report({ state: 'off', message: '', work: '' }).catch(() => {});
    else if (msg.cmd === 'status') return { ok: true, status, server: await serverUrl() };
    return { ok: true };
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});

// 1분마다 확인한다. 크롬을 켜거나 확장을 설치·업데이트했을 때도 알람이 있는지 챙긴다
const ensureAlarm = () => chrome.alarms.get('tick').then((a) => a || chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => a.name === 'tick' && tick());
ensureAlarm();
