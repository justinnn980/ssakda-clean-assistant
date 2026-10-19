// 숨고를 크롬으로 열어 두 가지 일을 한다.
// 1) 받은 요청 확인: 받은 요청을 주기적으로 확인해 새 요청서를 문의로 등록한다. 받은 요청은 읽기만 한다.
//    견적은 설정의 '답변 보내는 방식'에 따라 숨고 창에 써 두기만 하거나(prepareQuote) 보낸다(sendQuote). 지금은 꺼 두었다(server.js의 QUOTE_FEATURES).
// 2) 채팅 자동 응대: 채팅 목록을 주기적으로 확인해 새 채팅방이 생기면 그 채팅방 화면의 글과 사진을 넘기고,
//    답장을 채팅창에 써 두기만 하거나(prepareChat) 보낸다(sendChat). 채팅방마다 한 번만 한다. 채팅 화면 말고 다른 화면(프로필 등)은 열지 않는다.
// 로그인은 사용자가 이 프로그램이 띄운 크롬 창에서 직접 한다. 아이디·비밀번호는 다루지도 저장하지도 않는다.
// 서버에서 돌릴 때(SERVER_MODE=1)는 크롬 창을 띄울 화면이 없어서 화면 없이 연다. 그 대신 비서 웹 화면의 '숨고 화면'에서
// 탭의 모습을 보고 누르고 글자를 넣는다(아래 '숨고 화면'). 로그인도 거기서 한다.
// 크롬을 프로그램으로 조종하는 도구
import { chromium } from 'playwright-core';
// 파일 읽기·쓰기, 폴더 만들기, 경로 다루기
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
// 자료를 두는 data 폴더의 위치
import { DATA_DIR } from './store.js';

// 숨고 '받은 요청' 화면 주소
const LIST_URL = 'https://soomgo.com/requests/received';
// 받은 요청 화면이 스스로 불러오는 목록 데이터. 이 응답을 읽기만 하고, 요청서를 열지 않으므로 '읽음' 표시도 바뀌지 않는다
const LIST_API_RE = /^https:\/\/api\.soomgo\.com\/v\d+\/requests\/received\?/;
// 숨고 전용 크롬의 로그인 정보가 저장되는 폴더. 여기에 남아 있어서 한 번 로그인하면 유지된다
const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
// 이미 등록한 요청 번호를 적어 두는 파일
const SEEN_FILE = path.join(DATA_DIR, 'soomgo_seen.json');
// 문제가 생겼을 때 화면 기록(글자·캡처)을 남기는 폴더
const DEBUG_DIR = path.join(DATA_DIR, 'soomgo-debug');

// 서버에서 돌리는지. 서버의 실행 설정이 SERVER_MODE=1을 넣어 준다
const onServer = () => process.env.SERVER_MODE === '1';
// 숨고 탭의 크기: 평소(견적 칸이 잘리지 않는 폭)와, 서버에서 휴대폰으로 로그인할 때(휴대폰 화면에 꽉 차는 폭)
const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 420, height: 860 };
// 로그인이 풀렸을 때 화면과 카톡에 보여 줄 안내
const loginMessage = () =>
  onServer() ? '숨고 로그인이 필요합니다. 비서 화면 위쪽의 "숨고 화면"에서 로그인해 주세요.' : '숨고 로그인이 필요합니다. 노트북에 열린 크롬 창에서 로그인해 주세요.';

// 화면에 보여줄 숨고 확인 상태: 상태(off 꺼짐, starting 여는 중, login 로그인 필요, ok 정상, error 문제), 안내 글, 마지막 확인 시각, 마지막으로 새 요청을 등록한 시각
export const status = { state: 'off', message: '', lastCheck: null, lastNew: null };

// 정해진 시간만큼 기다린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 이미 본 번호를 적어 둔 파일을 읽는다. 파일이 없으면(처음이면) null
const loadSeen = async (file = SEEN_FILE) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};
// 등록한 요청 번호를 저장한다. 최근 2000개만 남긴다
const saveSeen = (seen) => writeFile(SEEN_FILE, JSON.stringify(seen.slice(-2000)));

// 화면 구조를 확인할 수 있게 목록 화면의 링크·글자·캡처를 남긴다
async function dump(page, name) {
  await mkdir(DEBUG_DIR, { recursive: true });
  // 화면의 모든 링크 주소와 화면에 보이는 글자를 모아 글 파일로, 화면 모습을 그림 파일로 남긴다
  const hrefs = await page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]).catch(() => []);
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  await writeFile(path.join(DEBUG_DIR, `${name}.txt`), `URL: ${page.url()}\n\n--- 링크 ---\n${hrefs.join('\n')}\n\n--- 화면 글자 ---\n${text}`);
  await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
}

// 지금 주소가 로그인 화면이면 로그인이 풀린 것으로 본다
const loggedOut = (page) => /\/(login|sign-?in|auth)/i.test(new URL(page.url()).pathname);

// 사용자가 그 탭에서 로그인해 로그인 화면을 벗어날 때까지 기다린다.
// 서버에서는 '숨고 화면'에서 휴대폰으로 로그인하기 좋게, 기다리는 동안 탭을 휴대폰 폭으로 바꿔 두었다가 되돌린다
async function waitForLogin(page) {
  if (onServer()) await page.setViewportSize(PHONE).catch(() => {});
  await page.waitForURL((u) => !/\/(login|sign-?in|auth)/i.test(u.pathname), { timeout: 0 });
  if (onServer()) await page.setViewportSize(DESKTOP).catch(() => {});
}

// 받은 요청 화면을 열고 화면이 불러온 요청 목록을 돌려준다. 로그인이 풀렸으면 null, 목록을 받지 못했으면 undefined.
async function listRequests(page) {
  // 화면이 목록 데이터를 불러오는 것을 기다렸다가 그 내용을 받아 둔다 (45초까지). 화면을 열기 전에 미리 기다리기 시작해야 놓치지 않는다
  const listed = page
    .waitForResponse((r) => LIST_API_RE.test(r.url()) && r.request().method() === 'GET' && r.ok(), { timeout: 45000 })
    .then((r) => r.json())
    .catch(() => null);
  // 받은 요청 화면을 열고, 화면이 다 불러올 때까지 잠깐 기다린다
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // 로그인 화면으로 넘어갔으면 null
  if (loggedOut(page)) return null;
  // 받아 둔 데이터에서 요청 목록을 꺼낸다. 번호가 있는 것만 남긴다
  const items = (await listed)?.response?.items;
  return Array.isArray(items) ? items.filter((it) => it?.id) : undefined;
}

// 목록의 요청 한 건을 AI가 읽을 요청서 글로 바꾼다. 고객 이름은 넣지 않는다.
function requestText(it) {
  const lines = ['[숨고 요청서]'];
  // 값이 있을 때만 "이름: 값" 한 줄을 더하는 작은 함수
  const add = (label, v) => v && lines.push(`${label}: ${String(v).trim()}`);
  add('서비스', it.serviceInfo?.service?.name);
  add('지역', it.address);
  add('희망 날짜', it.detail?.desiredDate);
  // 고객이 답한 질문과 답을 차례로 적는다. 그런 형식이 없으면 답만 목록으로 적는다
  const qa = (it.formattedRequestInfo?.items || []).filter((q) => q?.answer);
  for (const q of qa) lines.push('', `질문: ${String(q.question || '').trim()}`, `답: ${String(q.answer).trim()}`);
  if (!qa.length) for (const a of it.detail?.answers || []) lines.push(`- ${a}`);
  // 고객이 따로 적은 추가 요청
  const extra = String(it.additionalRequirement?.text || '').trim();
  if (extra) lines.push('', `추가 요청: ${extra}`);
  // 너무 길면 8000자까지만 쓴다
  return lines.join('\n').slice(0, 8000);
}

// 고객이 요청서에 붙인 사진을 내려받는다.
function requestImages(context, it) {
  // 요청서와 추가 요청에 붙은 사진 주소를 모은다
  const urls = [...(it.formattedRequestInfo?.images || []), ...(it.additionalRequirement?.images || [])].map((v) =>
    typeof v === 'string' ? v : Object.values(v || {}).find((x) => typeof x === 'string' && x.startsWith('https://')),
  );
  return downloadImages(context, urls);
}

// 사진 주소들에서 사진을 내려받는다. 숨고 주소(soomgo.com)의 사진만, 겹치는 것은 빼고 받고, 실패한 사진은 건너뛴다.
async function downloadImages(context, list) {
  const urls = list.filter((u, i, all) => /^https:\/\/[\w.-]+\.soomgo\.com\//.test(u || '') && all.indexOf(u) === i);
  const images = [];
  // 많아도 8장까지만 받는다. 받은 사진은 저장하기 좋은 글자 형태(data:image/...)로 바꾼다
  for (const url of urls.slice(0, 8)) {
    try {
      const res = await context.request.get(url, { timeout: 30000 });
      const type = /^image\/(jpeg|png|webp)/.exec(res.headers()['content-type'] || '');
      if (res.ok() && type) images.push(`data:image/${type[1]};base64,${(await res.body()).toString('base64')}`);
    } catch {
      // 사진 한 장을 못 받아도 요청서 등록은 계속한다
    }
  }
  return images;
}

// 요청서 화면을 열어 견적 칸에 설명과 금액(있으면)을 넣는다. 보내기 버튼은 누르지 않고 그 버튼을 돌려준다.
async function fillQuote(page, id, { price, message }) {
  // 요청 번호가 정해진 모양(글자 24개)이 아니면 열지 않는다
  if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('잘못된 숨고 요청 번호입니다.');
  // 그 요청서 화면을 연다
  await page.goto(`${LIST_URL}/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // 로그인이 풀려 있으면 멈춘다
  if (loggedOut(page)) throw new Error('숨고 로그인이 풀려 있습니다.');
  // 금액 칸을 찾는다. 20초 안에 나오지 않으면 견적을 넣을 수 없는 요청으로 본다
  const amount = page.getByPlaceholder('금액을 입력해 주세요.');
  await amount.waitFor({ timeout: 20000 }).catch(() => {
    throw new Error('견적을 넣는 칸을 찾지 못했습니다. 마감됐거나 이미 견적을 보낸 요청일 수 있습니다.');
  });
  // 설명 칸에 답변을 넣는다 (1000자까지). 금액이 있으면 금액 칸에 숫자로 넣는다
  await page.locator('textarea').first().fill(message.slice(0, 1000));
  if (price > 0) await amount.fill(String(Math.round(price)));
  // '견적 보내기' 버튼을 찾아 돌려준다. 여기서는 누르지 않는다
  return page.locator('button', { hasText: '견적 보내기' }).last();
}

// 숨고 창에 새 탭을 열어 견적을 써 두고 멈춘다. 탭은 열어 둔다. 보내기는 사장님이 그 탭에서 직접 누른다.
export async function prepareQuote(id, quote) {
  // 숨고 크롬 창이 열려 있지 않으면(비서가 꺼져 있으면) 할 수 없다
  if (!context) throw new Error('비서가 꺼져 있어 숨고 창에 쓸 수 없습니다.');
  // 새 탭을 연다
  const page = await context.newPage();
  try {
    // 칸을 채우고, 보내기 버튼이 보이게 화면을 내린 뒤, 그 탭을 맨 앞에 띄우고, 화면을 그림으로 남긴다
    const send = await fillQuote(page, id, quote);
    await send.scrollIntoViewIfNeeded().catch(() => {});
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: path.join(DEBUG_DIR, `quote-prepared-${id}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
    return { label: (await send.innerText()).trim() };
  } catch (e) {
    // 실패하면 열었던 탭을 닫고 오류를 그대로 알린다
    await page.close().catch(() => {});
    throw e;
  }
}

// 요청서 화면의 견적 칸에 금액과 설명을 넣고 보낸다. 보내면 숨고캐시가 차감된다.
// 보내기를 누른 뒤 발송이 확인되지 않으면(캐시 부족, 추가 확인 화면 등) 더 누르지 않고 화면을 기록한 뒤 멈춘다.
// dryRun이면 칸만 채우고 보내지 않는다.
export async function submitQuote(ctx, id, { price, message, dryRun = false }) {
  // 금액이 없으면 보내지 않는다
  if (!(price > 0)) throw new Error('보낼 금액이 없습니다.');
  const page = await ctx.newPage();
  try {
    // 칸을 채우고, 보내기 버튼이 눌릴 수 있는 상태가 될 때까지 10초까지 기다린다
    const send = await fillQuote(page, id, { price, message });
    for (let i = 0; i < 20 && !(await send.isEnabled()); i++) await sleep(500);
    if (!(await send.isEnabled())) throw new Error('견적 보내기 버튼이 눌리지 않는 상태입니다. 금액이나 설명이 숨고 기준에 맞지 않을 수 있습니다.');
    // 버튼에 적힌 글자 (기록용)
    const label = (await send.innerText()).trim();
    // 시험(dryRun)이면 화면 기록만 남기고 보내지 않는다
    if (dryRun) {
      await dump(page, `quote-dryrun-${id}`);
      return { sent: false, label };
    }
    // 버튼을 누른 뒤 숨고로 나가는 요청들을 적어 둔다 (읽기만 하는 요청은 빼고)
    const calls = [];
    const onResponse = (r) => {
      const m = r.request().method();
      if (m !== 'GET' && m !== 'OPTIONS' && r.url().startsWith('https://api.soomgo.com/')) calls.push({ method: m, url: r.url(), status: r.status() });
    };
    page.on('response', onResponse);
    // 견적 보내기 버튼을 누른다. 한 번만 누른다
    await send.click();
    // 견적을 보내는 요청이 나갔는지 20초까지 지켜본다
    const isQuote = (c) => c.method === 'POST' && /quote|estimate|requests\/received/i.test(c.url);
    for (let i = 0; i < 40 && !calls.some(isQuote); i++) await sleep(500);
    page.off('response', onResponse);
    console.log(`[숨고] 견적 보내기(${label}) 뒤 요청: ${calls.map((c) => `${c.method} ${c.status} ${c.url}`).join(' , ') || '없음'}`);
    // 그런 요청이 없었으면 화면 기록을 남기고 '확인되지 않음'으로 멈춘다
    const posted = calls.find(isQuote);
    if (!posted) {
      await dump(page, `quote-unconfirmed-${id}`);
      throw new Error('견적 보내기를 눌렀지만 발송이 확인되지 않았습니다. 숨고에서 직접 확인해 주세요.');
    }
    // 요청은 나갔지만 숨고가 거절한 경우
    if (posted.status >= 400) throw new Error(`숨고가 견적을 받지 않았습니다. (응답 ${posted.status})`);
    return { sent: true, label };
  } finally {
    // 성공하든 실패하든 이 탭은 닫는다
    await page.close().catch(() => {});
  }
}

// ---------- 숨고 크롬 창 (두 기능이 함께 쓴다) ----------
// 지금 열려 있는 숨고 크롬 창. 꺼져 있으면 null
let context = null;
// 크롬 창을 여는 중이면 그 작업. 두 기능이 한꺼번에 켜져도 창은 하나만 연다
let opening = null;
// 크롬 창을 쓰고 있는 기능들: requests(받은 요청 확인), chats(채팅 자동 응대). 모두 꺼지면 창을 닫는다
const users = new Set();

// 숨고 전용 크롬 창을 연다. 이미 열려 있으면 그 창을 쓴다
async function openBrowser(who) {
  users.add(who);
  if (context) return context;
  opening ||= (async () => {
    // 설치된 크롬을 숨고 전용 폴더로 연다. 사용자가 로그인할 수 있게 창이 보이는 상태로 연다.
    // 서버에서는 창을 띄울 화면이 없어 화면 없이 열고, 한국어·한국 시간으로 맞춘다
    await mkdir(PROFILE_DIR, { recursive: true });
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: onServer(),
      viewport: DESKTOP,
      ...(onServer() ? { locale: 'ko-KR', timezoneId: 'Asia/Seoul' } : { args: ['--window-position=40,40'] }),
    });
    // 창이 닫히면(사용자가 닫거나 크롬이 죽으면) 닫힌 것으로 표시한다
    ctx.on('close', () => context === ctx && (context = null));
    context = ctx;
    return ctx;
  })().finally(() => (opening = null));
  return opening;
}

// 그 기능이 크롬 창을 다 썼다고 알린다. 쓰는 기능이 하나도 없으면 창을 닫는다
async function releaseBrowser(who) {
  users.delete(who);
  if (users.size) return;
  const closing = context;
  context = null;
  await closing?.close().catch(() => {});
}

// 처음 열린 빈 탭이 있으면 그 탭을, 없으면 새 탭을 쓴다
const blankOrNewPage = async (ctx) => ctx.pages().find((p) => p.url() === 'about:blank') || ctx.newPage();

// ---------- 숨고 화면 (서버에서 돌릴 때) ----------
// 서버에는 크롬 창을 띄울 화면이 없어서, 숨고 탭의 모습을 그림으로 찍어 비서 웹 화면에 보여 주고,
// 사용자가 그림에서 누른 자리와 쓴 글자를 그 탭에 그대로 넣는다. 숨고 로그인도 여기서 한다.
// 넣은 글자(비밀번호 포함)는 탭에 넣기만 하고 기록하거나 저장하지 않는다.
// 탭마다 붙이는 번호. 다른 탭이 열리고 닫혀도 같은 탭은 같은 번호다
const pageIds = new WeakMap();
let lastPageId = 0;
const pageId = (p) => pageIds.get(p) ?? (pageIds.set(p, ++lastPageId), lastPageId);
// 자동 확인이 쓰는 탭(채팅 목록·받은 요청). 사용자가 닫지 못하게 한다
const watcherPages = new WeakSet();
// 채팅방을 읽으려고 잠깐 여는 탭. 금방 닫히므로 목록에 보이지 않는다
const transientPages = new WeakSet();
// 로그인 화면(숨고 로그인, 또는 카카오·네이버 같은 숨고 밖의 로그인 창)인지
function isLoginUrl(u) {
  try {
    const { protocol, hostname, pathname } = new URL(u);
    return /\/(login|sign-?in|auth)/i.test(pathname) || (protocol === 'https:' && !/(^|\.)soomgo\.com$/.test(hostname));
  } catch {
    return false;
  }
}
// 번호로 탭을 찾는다. 없으면(닫혔으면) undefined
const findPage = (id) => context?.pages().find((p) => pageIds.get(p) === id);

// 열린 탭 목록과, 먼저 보여 줄 탭의 번호(로그인 화면이 있으면 가장 최근의 그것, 없으면 가장 최근 탭)
export async function screenView() {
  if (!context) return { open: false, pages: [], pick: null };
  const pages = await Promise.all(
    context
      .pages()
      .filter((p) => !transientPages.has(p))
      .map(async (p) => ({ id: pageId(p), url: p.url(), title: await p.title().catch(() => ''), login: isLoginUrl(p.url()), auto: watcherPages.has(p) })),
  );
  const pick = pages.findLast((p) => p.login) || pages.at(-1);
  return { open: true, pages, pick: pick?.id ?? null };
}

// 탭 하나의 지금 모습을 그림(JPG)으로 돌려준다. 입력칸의 깜빡이는 표시도 보이게 찍는다. 탭이 없으면 null
export async function screenShot(id) {
  const page = findPage(id);
  if (!page) return null;
  return page.screenshot({ type: 'jpeg', quality: 60, caret: 'initial', timeout: 10000 }).catch(() => null);
}

// 사용자가 '숨고 화면'에서 한 동작을 그 탭에 그대로 한다: 누르기(tap), 글자 넣기(text), 키 누르기(key), 위아래로 밀기(scroll), 뒤로(back), 새로 고침(reload), 탭 닫기(close)
export async function screenInput({ id, type, x, y, text, key, dy }) {
  const page = findPage(id);
  if (!page) throw Object.assign(new Error('그 탭이 닫혔습니다. 다른 탭을 골라 주세요.'), { status: 404 });
  const size = page.viewportSize() || DESKTOP;
  // 숫자를 0부터 max 사이로 맞춘다
  const clamp = (v, max) => Math.min(Math.max(Number(v) || 0, 0), max);
  if (type === 'tap') await page.mouse.click(clamp(x, size.width), clamp(y, size.height));
  else if (type === 'text') await page.keyboard.type(String(text || '').slice(0, 500));
  else if (type === 'key' && ['Backspace', 'Enter', 'Tab'].includes(key)) await page.keyboard.press(key);
  else if (type === 'scroll') {
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(dy) || 0)));
  } else if (type === 'back') await page.goBack({ timeout: 15000 }).catch(() => {});
  else if (type === 'reload') await page.reload({ timeout: 30000 }).catch(() => {});
  else if (type === 'close') {
    if (watcherPages.has(page)) throw Object.assign(new Error('자동 확인에 쓰는 탭이라 닫을 수 없습니다.'), { status: 400 });
    await page.close();
  } else throw Object.assign(new Error('알 수 없는 동작입니다.'), { status: 400 });
}

// ---------- 받은 요청 확인 ----------
// onNew({ text, images, soomgoId }) 는 새 요청서 한 건을 문의로 등록한다. onAlert(text) 는 사장님에게 알린다.
// 켜고 끌 때마다 올라가는 번호. 끈 뒤에도 돌고 있던 옛 확인이 스스로 멈추게 하는 데 쓴다
let generation = 0;

// 견적을 실제로 보낸다 (자동 발송에서 쓴다)
export function sendQuote(id, quote) {
  if (!context) throw new Error('비서가 꺼져 있어 숨고에 보낼 수 없습니다.');
  return submitQuote(context, id, quote);
}

// 숨고 확인을 멈춘다. 채팅 자동 응대도 꺼져 있으면 크롬 창을 닫는다
export async function stopWatcher() {
  generation += 1;
  status.state = 'off';
  status.message = '';
  await releaseBrowser('requests');
}

// 숨고 확인을 시작한다. 3분마다 받은 요청을 확인해 새 요청서가 있으면 onNew로 넘긴다
export async function startWatcher({ onNew, onAlert, intervalMs = 3 * 60 * 1000 }) {
  // 이미 켜져 있으면 또 켜지 않는다
  if (users.has('requests')) return;
  // 이번에 켠 것의 번호. 이 번호가 최신일 때만 계속 돈다
  const gen = ++generation;
  const active = () => gen === generation;
  status.state = 'starting';
  status.message = '크롬 창을 여는 중입니다.';
  // 숨고 크롬 창을 열고, 처음 열린 빈 탭을 쓴다
  const ctx = await openBrowser('requests');
  const page = await blankOrNewPage(ctx);
  watcherPages.add(page);
  // 로그인 안내를 이미 보냈는지, 화면 기록을 이미 남겼는지 (같은 일을 되풀이하지 않기 위해)
  let alertedLogin = false;
  let dumped = false;

  // 꺼질 때까지 되풀이한다
  while (active()) {
    try {
      // 받은 요청 목록을 읽고 확인한 시각을 적는다
      const items = await listRequests(page);
      status.lastCheck = new Date().toISOString();
      // 로그인이 풀려 있는 경우: 화면과 카톡으로 한 번만 알린다
      if (items === null) {
        status.state = 'login';
        status.message = loginMessage();
        if (!alertedLogin) {
          alertedLogin = true;
          console.log(`[숨고] ${status.message}`);
          await onAlert(`[싹다클린] ${status.message}`);
        }
        // 로그인 중인 화면을 건드리지 않도록, 로그인 화면을 벗어날 때까지 기다린다
        await waitForLogin(page);
        await sleep(3000);
        continue;
      }
      // 로그인이 된 경우
      if (alertedLogin) console.log('[숨고] 로그인 확인됨. 받은 요청을 확인합니다.');
      alertedLogin = false;
      // 처음 한 번, 목록 화면의 모습을 기록으로 남긴다 (화면 구조가 바뀌었을 때 확인하려고)
      if (!dumped) {
        dumped = true;
        await dump(page, 'list');
      }

      // 목록의 요청 번호 가운데 아직 등록하지 않은 것(fresh)을 가린다
      const ids = (items || []).map((it) => it.id);
      let seen = await loadSeen();
      let fresh;
      if (seen === null) {
        // 처음 연결한 때는 쌓여 있던 요청을 모두 가져오지 않고 가장 위의 한 건만 가져온다
        seen = ids.slice(1);
        fresh = ids.slice(0, 1);
      } else {
        fresh = ids.filter((id) => !seen.includes(id));
      }
      // 상태를 정한다: 정상 / 목록을 읽지 못함 / 요청 몇 건 확인 / 아직 요청 없음
      status.state = 'ok';
      if (!items) {
        // 목록 데이터를 받지 못한 경우: 화면 구조를 확인할 수 있게 기록을 남긴다
        status.state = 'error';
        status.message = '받은 요청 목록을 읽지 못했습니다. 화면 구조 확인이 필요합니다.';
        await dump(page, 'list-unreadable');
      } else if (ids.length) status.message = `받은 요청 ${ids.length}건 확인`;
      else status.message = '받은 요청이 아직 없습니다. 새 요청을 기다리는 중입니다.';

      // 새 요청을 목록의 위에서 5건까지, 아래 것부터 차례로 문의로 등록한다. 한 건 등록할 때마다 번호를 저장해 두 번 등록되지 않게 한다
      for (const id of fresh.slice(0, 5).reverse()) {
        const it = items.find((x) => x.id === id);
        await onNew({ text: requestText(it), images: await requestImages(ctx, it), soomgoId: id });
        seen.push(id);
        await saveSeen(seen);
        status.lastNew = new Date().toISOString();
        console.log(`[숨고] 새 요청서 등록: ${id}`);
      }
      if (ids.length) await saveSeen(seen);
    } catch (e) {
      // 확인 중에 오류가 난 경우. 꺼진 뒤에 난 오류는 무시한다
      if (!active()) return;
      status.state = 'error';
      status.message = `숨고 확인 중 오류: ${e.message.split('\n')[0]}`;
      console.error(`[숨고] ${status.message}`);
      // 크롬 창이 닫혔거나 죽었으면 알리고 멈춘다. 그 밖의 오류는 다음 차례에 다시 시도한다
      if (/closed|crash/i.test(e.message)) {
        status.message = '숨고 확인용 크롬 창이 닫혔습니다. 설정에서 껐다가 다시 켜주세요.';
        await releaseBrowser('requests');
        await onAlert(`[싹다클린] ${status.message}`);
        return;
      }
    }
    // 다음 확인까지 기다린다. 3분을 기준으로 20%쯤 앞뒤로 달리해서 간격이 매번 똑같지 않게 한다
    await sleep(intervalMs * (0.8 + Math.random() * 0.4));
  }
}

// ---------- 채팅 자동 응대 ----------
// 숨고 '채팅' 화면 주소. 채팅방 하나는 이 주소 뒤에 채팅방 번호를 붙인 주소다
const CHATS_URL = 'https://soomgo.com/pro/chats';
// 채팅 화면이 스스로 불러오는 채팅방 목록 데이터 (예: /api/v2.4/chats/?role=provider)
const CHATS_API_RE = /^https:\/\/api\.soomgo\.com\/(?:api\/)?v[\d.]+\/chats\/?\?/;
// 채팅 화면이 실시간 연결을 위해 받는 표. 안에 로그인한 계정 번호가 들어 있다
const SOCKET_TOKEN_RE = /^https:\/\/api\.soomgo\.com\/v\d+\/accounts\/web-socket\/token/;
// 계정마다 이미 본 채팅방 번호를 적어 두는 파일 ({ 계정 번호: [채팅방 번호, ...] })
const CHATS_SEEN_FILE = path.join(DATA_DIR, 'soomgo_chats_seen.json');

// 화면에 보여줄 채팅 자동 응대 상태: 상태, 안내 글, 마지막 확인 시각, 마지막으로 새 채팅방을 넘긴 시각, 로그인한 계정 번호
export const chatStatus = { state: 'off', message: '', lastCheck: null, lastNew: null, account: null };
// 켜고 끌 때마다 올라가는 번호 (받은 요청 확인의 generation과 같은 쓰임)
let chatGeneration = 0;

// 응답이 올 때까지 기다렸다가 그 자료를 돌려준다. 45초 안에 오지 않으면 null. 화면을 열기 전에 기다리기 시작해야 놓치지 않는다
const awaitJson = (page, re, method) =>
  page
    .waitForResponse((r) => re.test(r.url()) && r.request().method() === method && r.ok(), { timeout: 45000 })
    .then(async (r) => ({ url: r.url(), body: await r.json() }))
    .catch(() => null);
// 화면을 다 불러온 뒤에도 그 응답이 5초 안에 오지 않으면 기다리지 않는다
const within5s = (p) => Promise.race([p, sleep(5000).then(() => null)]);

// 실시간 연결 표(JWT)의 가운데 부분을 풀어 'private-userid-123' 같은 채널 이름에서 계정 번호를 꺼낸다. 없으면 null
function accountFromSocketToken(body) {
  try {
    const payload = JSON.parse(Buffer.from(String(body?.response?.token).split('.')[1], 'base64url').toString('utf8'));
    for (const ch of payload.channels || []) {
      const m = /^private-userid-(\d+)$/.exec(ch);
      if (m) return m[1];
    }
  } catch {
    // 모양이 다르면 계정을 모르는 것으로 친다
  }
  return null;
}

// 채팅 화면을 열어 로그인한 계정 번호(account), 채팅방 번호들(ids, 위가 최근), 목록 데이터의 채팅방 수(count)를 돌려준다.
// 로그인이 풀렸으면 null
async function listChats(page) {
  const listed = awaitJson(page, CHATS_API_RE, 'GET');
  const token = awaitJson(page, SOCKET_TOKEN_RE, 'POST');
  await page.goto(CHATS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (loggedOut(page)) return null;
  const [data, tok] = await Promise.all([within5s(listed), within5s(token)]);
  const results = Array.isArray(data?.body?.results) ? data.body.results : null;
  // 화면의 채팅방 링크(/pro/chats/번호)에서 채팅방 번호를 모은다
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href'))).catch(() => []);
  let ids = [...new Set(hrefs.map((h) => /^(?:https:\/\/soomgo\.com)?\/pro\/chats\/([\w-]+)/.exec(h || '')?.[1]).filter(Boolean))];
  // 화면에 링크가 없으면 목록 데이터의 번호를 쓴다
  if (!ids.length && results) ids = results.map((r) => r?.id).filter((v) => v != null).map(String);
  return { account: accountFromSocketToken(tok?.body), ids, count: results ? results.length : null, data: data?.body ?? null };
}

// 채팅방을 새 탭에서 열어 화면의 글(요청서와 지금까지의 대화)과 사진을 읽어 온다. 다 읽으면 탭을 닫는다
async function readRoom(ctx, id) {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('잘못된 채팅방 번호입니다.');
  const page = await ctx.newPage();
  transientPages.add(page);
  // 채팅방이 불러오는 데이터를 기록해 둔다 (화면 구조를 확인하려고)
  const loaded = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'GET' || !r.url().startsWith('https://api.soomgo.com/') || !/json/.test(r.headers()['content-type'] || '')) return;
    loaded.push({ url: r.url(), body: await r.json().catch(() => null) });
  });
  try {
    await page.goto(`${CHATS_URL}/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(2000);
    if (loggedOut(page)) throw new Error('숨고 로그인이 풀려 있습니다.');
    await dump(page, `chat-${id}`);
    await writeFile(path.join(DEBUG_DIR, `chat-${id}.json`), JSON.stringify(loaded, null, 1)).catch(() => {});
    // 화면 위아래의 메뉴를 빼고 본문만 읽는다. 본문 칸이 없으면 화면 전체 글을 쓴다
    const text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText).catch(() => '');
    // 고객이 올린 사진: 숨고에 올라간 사진 가운데 프로필 사진이 아니고 충분히 큰 것 (6장까지)
    const srcs = await page.$$eval('img', (imgs) => imgs.filter((i) => i.naturalWidth >= 200 && i.naturalHeight >= 200).map((i) => i.currentSrc || i.src)).catch(() => []);
    const images = await downloadImages(ctx, srcs.filter((u) => /\/upload\//.test(u) && !/\/profile\//.test(u)).slice(0, 6));
    return { text: `[숨고 채팅방 화면]\n${text.trim()}`.slice(0, 12000), images };
  } finally {
    await page.close().catch(() => {});
  }
}

// 채팅방을 새 탭에서 열어 입력칸에 답장을 써 넣고, 그 탭과 입력칸을 돌려준다. 실패하면 탭을 닫는다
async function fillChat(id, text) {
  if (!context) throw new Error('채팅 자동 응대가 꺼져 있어 숨고에 쓸 수 없습니다.');
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('잘못된 채팅방 번호입니다.');
  const page = await context.newPage();
  try {
    await page.goto(`${CHATS_URL}/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (loggedOut(page)) throw new Error('숨고 로그인이 풀려 있습니다.');
    // 입력칸: 화면 아래쪽의 글 칸(textarea). 없으면 글을 쓸 수 있는 칸(contenteditable)
    const box = page.locator('textarea:visible, [contenteditable="true"]:visible').last();
    await box.waitFor({ timeout: 20000 }).catch(() => {
      throw new Error('채팅 입력칸을 찾지 못했습니다.');
    });
    if (!(await box.isEditable())) throw new Error('채팅 입력칸이 막혀 있습니다. 숨고가 아직 메시지를 보낼 수 없게 해 둔 채팅방일 수 있습니다.');
    await box.fill(text.slice(0, 1000));
    return { page, box };
  } catch (e) {
    await dump(page, `chat-unfilled-${id}`).catch(() => {});
    await page.close().catch(() => {});
    throw e;
  }
}

// 답장을 써 두고 열어 둔 탭들 (오래된 것부터)
const preparedPages = [];

// 채팅창에 답장을 써 두고 멈춘다. 탭은 열어 둔다. 전송은 사용자가 그 탭에서 직접 누른다.
// 서버에서는 아무도 탭을 닫지 않아 계속 쌓이므로, 최근 5개만 남기고 오래된 탭은 닫는다
export async function prepareChat(id, text) {
  const { page } = await fillChat(id, text);
  await page.bringToFront().catch(() => {});
  await page.screenshot({ path: path.join(DEBUG_DIR, `chat-prepared-${id}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
  if (!onServer()) return;
  preparedPages.push(page);
  while (preparedPages.length > 5) await preparedPages.shift().close().catch(() => {});
}

// 채팅창에 답장을 써 넣고 전송한다. 한 번만 누르고, 보내졌는지 확인되지 않으면 더 누르지 않고 화면을 기록한 뒤 멈춘다.
// 전송 버튼을 찾지 못하면 써 둔 탭을 열어 두어 사용자가 직접 보낼 수 있게 한다
export async function sendChat(id, text) {
  const { page, box } = await fillChat(id, text);
  // 전송 버튼: '전송'이나 '보내기'라고 적힌 버튼, 또는 그런 이름표가 붙은 버튼
  const send = page
    .locator('button:visible')
    .filter({ hasText: /^\s*(전송|보내기)\s*$/ })
    .or(page.locator('button[aria-label*="전송"]:visible, button[aria-label*="보내"]:visible'))
    .last();
  if (!(await send.count()) || !(await send.isEnabled())) {
    await dump(page, `chat-nosend-${id}`);
    await page.bringToFront().catch(() => {});
    throw new Error('전송 버튼을 찾지 못했습니다. 채팅창에 답장을 써 두었으니 직접 전송해 주세요.');
  }
  try {
    // 버튼을 누른 뒤 숨고로 나가는 요청들을 적어 둔다 (읽기만 하는 요청은 빼고)
    const calls = [];
    const onResponse = (r) => {
      const m = r.request().method();
      if (m !== 'GET' && m !== 'OPTIONS' && r.url().startsWith('https://api.soomgo.com/')) calls.push({ method: m, url: r.url(), status: r.status() });
    };
    page.on('response', onResponse);
    await send.click();
    // 보내졌다는 표시: 채팅 글을 보내는 요청이 나갔거나, 입력칸이 비워지고 보낸 글이 화면에 나타났다
    const head = text.trim().split('\n')[0].slice(0, 20);
    const isChat = (c) => /chat|message/i.test(c.url);
    const shown = async () =>
      (await box.evaluate((el) => ('value' in el ? el.value : el.innerText)).catch(() => 'x')).trim() === '' &&
      (await page.evaluate((h) => document.body.innerText.includes(h), head).catch(() => false));
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      await sleep(500);
      ok = calls.some(isChat) || (await shown());
    }
    page.off('response', onResponse);
    console.log(`[숨고 채팅] 전송 뒤 요청: ${calls.map((c) => `${c.method} ${c.status} ${c.url}`).join(' , ') || '없음'}`);
    const failed = calls.find((c) => isChat(c) && c.status >= 400);
    if (failed) throw new Error(`숨고가 답장을 받지 않았습니다. (응답 ${failed.status})`);
    if (!ok) {
      await dump(page, `chat-unconfirmed-${id}`);
      throw new Error('전송을 눌렀지만 보내졌는지 확인되지 않았습니다. 숨고에서 직접 확인해 주세요.');
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// 채팅 자동 응대를 멈춘다. 받은 요청 확인도 꺼져 있으면 크롬 창을 닫는다
export async function stopChatWatcher() {
  chatGeneration += 1;
  chatStatus.state = 'off';
  chatStatus.message = '';
  await releaseBrowser('chats');
}

// 채팅 자동 응대를 시작한다. 1분마다 채팅 목록을 확인해, 처음 보는 채팅방이 있으면 그 내용을 onNew({ chatId, account, text, images })로 넘긴다.
// 로그인한 계정마다 처음 확인할 때 이미 있던 채팅방은 본 것으로 치고 넘기지 않는다. 채팅방마다 한 번만 넘긴다.
export async function startChatWatcher({ onNew, onAlert, intervalMs = 60 * 1000 }) {
  // 이미 켜져 있으면 또 켜지 않는다
  if (users.has('chats')) return;
  const gen = ++chatGeneration;
  const active = () => gen === chatGeneration;
  chatStatus.state = 'starting';
  chatStatus.message = '크롬 창을 여는 중입니다.';
  // 숨고 크롬 창을 열고, 처음 열린 빈 탭(없으면 새 탭)을 채팅 목록 확인에 쓴다
  const ctx = await openBrowser('chats');
  const page = await blankOrNewPage(ctx);
  watcherPages.add(page);
  // 로그인 안내를 이미 보냈는지, 화면 기록을 이미 남겼는지
  let alertedLogin = false;
  let dumped = false;

  while (active()) {
    try {
      const list = await listChats(page);
      if (!active()) break;
      chatStatus.lastCheck = new Date().toISOString();
      // 로그인이 풀려 있는 경우: 화면과 카톡으로 한 번만 알리고, 로그인 화면을 벗어날 때까지 기다린다
      if (list === null) {
        chatStatus.state = 'login';
        chatStatus.message = loginMessage();
        if (!alertedLogin) {
          alertedLogin = true;
          console.log(`[숨고 채팅] ${chatStatus.message}`);
          await onAlert(`[숨고 채팅] ${chatStatus.message}`);
        }
        await waitForLogin(page);
        await sleep(3000);
        continue;
      }
      alertedLogin = false;
      // 처음 한 번, 채팅 목록 화면과 목록 데이터를 기록으로 남긴다 (화면 구조를 확인하려고)
      if (!dumped) {
        dumped = true;
        await dump(page, 'chats');
        await writeFile(path.join(DEBUG_DIR, 'chats-list.json'), JSON.stringify(list.data, null, 1)).catch(() => {});
      }
      // 제대로 읽었는지: 목록 데이터를 받았고, 거기에 채팅방이 있으면 번호도 찾았어야 한다. 아니면 화면 구조가 달라진 것이다
      const readable = list.count !== null && !(list.count && !list.ids.length);
      if (!readable) await dump(page, 'chats-unreadable');
      if (!list.account) throw new Error('로그인한 계정을 확인하지 못했습니다. 잠시 뒤 다시 확인합니다.');
      // 로그인한 계정을 적어 둔다. 채팅방 기록은 계정마다 따로 두고, 보내기 직전에 계정이 바뀌었으면 보내지 않는다
      if (chatStatus.account !== list.account) console.log(`[숨고 채팅] 계정 ${list.account}의 채팅방을 확인합니다.`);
      chatStatus.account = list.account;
      // 제대로 읽지 못했으면 새 채팅방을 가리지 않는다. 빈 목록을 '본 것'으로 적어 두면 나중에 예전 채팅방에 모두 답하게 된다
      if (!readable) {
        chatStatus.state = 'error';
        chatStatus.message = '채팅 목록을 제대로 읽지 못했습니다. 화면 구조 확인이 필요합니다.';
        await sleep(intervalMs);
        continue;
      }
      chatStatus.state = 'ok';
      chatStatus.message = list.ids.length ? `채팅방 ${list.ids.length}개 확인` : '채팅방이 아직 없습니다. 새 채팅방을 기다리는 중입니다.';

      // 이 계정에서 이미 본 채팅방 번호. 처음 확인하는 계정이면 지금 있는 채팅방을 모두 본 것으로 친다
      const all = (await loadSeen(CHATS_SEEN_FILE)) || {};
      const first = !all[list.account];
      const seen = all[list.account] || [...list.ids];
      const save = () => writeFile(CHATS_SEEN_FILE, JSON.stringify({ ...all, [list.account]: seen.slice(-2000) }));
      if (first) await save();
      const fresh = first ? [] : list.ids.filter((id) => !seen.includes(id));
      // 새 채팅방을 위에서 3개까지, 오래된 것부터 차례로 넘긴다. 한 채팅방에 한 번만 하도록 읽기 전에 먼저 본 것으로 적어 둔다
      for (const id of fresh.slice(0, 3).reverse()) {
        if (!active()) break;
        seen.push(id);
        await save();
        try {
          const room = await readRoom(ctx, id);
          await onNew({ chatId: id, account: list.account, ...room });
          chatStatus.lastNew = new Date().toISOString();
          console.log(`[숨고 채팅] 새 채팅방: ${id}`);
        } catch (e) {
          if (!active()) break;
          console.error(`[숨고 채팅] 새 채팅방 ${id}을 읽지 못했습니다: ${e.message.split('\n')[0]}`);
          await onAlert(`[숨고 채팅] 새 채팅방을 읽지 못해 응대하지 못했습니다. 숨고에서 직접 확인해 주세요.\n${e.message.split('\n')[0]}`);
        }
      }
    } catch (e) {
      // 확인 중에 오류가 난 경우. 꺼진 뒤에 난 오류는 무시한다
      if (!active()) return;
      chatStatus.state = 'error';
      chatStatus.message = `숨고 채팅 확인 중 오류: ${e.message.split('\n')[0]}`;
      console.error(`[숨고 채팅] ${chatStatus.message}`);
      // 크롬 창이 닫혔거나 죽었으면 알리고 멈춘다. 그 밖의 오류는 다음 차례에 다시 시도한다
      if (/closed|crash/i.test(e.message)) {
        chatStatus.message = '숨고 크롬 창이 닫혔습니다. 채팅 자동 응대를 껐다가 다시 켜 주세요.';
        await releaseBrowser('chats');
        await onAlert(`[숨고 채팅] ${chatStatus.message}`);
        return;
      }
    }
    // 다음 확인까지 기다린다. 1분을 기준으로 20%쯤 앞뒤로 달리한다
    await sleep(intervalMs * (0.8 + Math.random() * 0.4));
  }
}
