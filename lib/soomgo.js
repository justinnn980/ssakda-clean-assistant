// 숨고 받은 요청을 주기적으로 확인해 새 요청서를 문의로 등록한다.
// 로그인은 사장님이 이 프로그램이 띄운 크롬 창에서 직접 한다. 아이디·비밀번호는 다루지도 저장하지도 않는다.
// 받은 요청은 읽기만 한다. 견적은 설정의 '답변 보내는 방식'에 따라 숨고 창에 써 두기만 하거나(prepareQuote) 보낸다(sendQuote). 채팅 전송은 하지 않는다.
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const LIST_URL = 'https://soomgo.com/requests/received';
// 받은 요청 화면이 스스로 불러오는 목록 데이터. 이 응답을 읽기만 하고, 요청서를 열지 않으므로 '읽음' 표시도 바뀌지 않는다
const LIST_API_RE = /^https:\/\/api\.soomgo\.com\/v\d+\/requests\/received\?/;
const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
const SEEN_FILE = path.join(DATA_DIR, 'soomgo_seen.json');
const DEBUG_DIR = path.join(DATA_DIR, 'soomgo-debug');

export const status = { state: 'off', message: '', lastCheck: null, lastNew: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadSeen = async () => {
  try {
    return JSON.parse(await readFile(SEEN_FILE, 'utf8'));
  } catch {
    return null;
  }
};
const saveSeen = (seen) => writeFile(SEEN_FILE, JSON.stringify(seen.slice(-2000)));

// 화면 구조를 확인할 수 있게 목록 화면의 링크·글자·캡처를 남긴다
async function dump(page, name) {
  await mkdir(DEBUG_DIR, { recursive: true });
  const hrefs = await page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]).catch(() => []);
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  await writeFile(path.join(DEBUG_DIR, `${name}.txt`), `URL: ${page.url()}\n\n--- 링크 ---\n${hrefs.join('\n')}\n\n--- 화면 글자 ---\n${text}`);
  await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
}

const loggedOut = (page) => /\/(login|sign-?in|auth)/i.test(new URL(page.url()).pathname);

// 받은 요청 화면을 열고 화면이 불러온 요청 목록을 돌려준다. 로그인이 풀렸으면 null, 목록을 받지 못했으면 undefined.
async function listRequests(page) {
  const listed = page
    .waitForResponse((r) => LIST_API_RE.test(r.url()) && r.request().method() === 'GET' && r.ok(), { timeout: 45000 })
    .then((r) => r.json())
    .catch(() => null);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (loggedOut(page)) return null;
  const items = (await listed)?.response?.items;
  return Array.isArray(items) ? items.filter((it) => it?.id) : undefined;
}

// 목록의 요청 한 건을 AI가 읽을 요청서 글로 바꾼다. 고객 이름은 넣지 않는다.
function requestText(it) {
  const lines = ['[숨고 요청서]'];
  const add = (label, v) => v && lines.push(`${label}: ${String(v).trim()}`);
  add('서비스', it.serviceInfo?.service?.name);
  add('지역', it.address);
  add('희망 날짜', it.detail?.desiredDate);
  const qa = (it.formattedRequestInfo?.items || []).filter((q) => q?.answer);
  for (const q of qa) lines.push('', `질문: ${String(q.question || '').trim()}`, `답: ${String(q.answer).trim()}`);
  if (!qa.length) for (const a of it.detail?.answers || []) lines.push(`- ${a}`);
  const extra = String(it.additionalRequirement?.text || '').trim();
  if (extra) lines.push('', `추가 요청: ${extra}`);
  return lines.join('\n').slice(0, 8000);
}

// 고객이 요청서에 붙인 사진을 내려받는다. 숨고 주소의 사진만 받고, 실패한 사진은 건너뛴다.
async function requestImages(context, it) {
  const urls = [...(it.formattedRequestInfo?.images || []), ...(it.additionalRequirement?.images || [])]
    .map((v) => (typeof v === 'string' ? v : Object.values(v || {}).find((x) => typeof x === 'string' && x.startsWith('https://'))))
    .filter((u, i, all) => /^https:\/\/[\w.-]+\.soomgo\.com\//.test(u || '') && all.indexOf(u) === i);
  const images = [];
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
  if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('잘못된 숨고 요청 번호입니다.');
  await page.goto(`${LIST_URL}/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (loggedOut(page)) throw new Error('숨고 로그인이 풀려 있습니다.');
  const amount = page.getByPlaceholder('금액을 입력해 주세요.');
  await amount.waitFor({ timeout: 20000 }).catch(() => {
    throw new Error('견적을 넣는 칸을 찾지 못했습니다. 마감됐거나 이미 견적을 보낸 요청일 수 있습니다.');
  });
  await page.locator('textarea').first().fill(message.slice(0, 1000));
  if (price > 0) await amount.fill(String(Math.round(price)));
  return page.locator('button', { hasText: '견적 보내기' }).last();
}

// 숨고 창에 새 탭을 열어 견적을 써 두고 멈춘다. 탭은 열어 둔다. 보내기는 사장님이 그 탭에서 직접 누른다.
export async function prepareQuote(id, quote) {
  if (!context) throw new Error('비서가 꺼져 있어 숨고 창에 쓸 수 없습니다.');
  const page = await context.newPage();
  try {
    const send = await fillQuote(page, id, quote);
    await send.scrollIntoViewIfNeeded().catch(() => {});
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: path.join(DEBUG_DIR, `quote-prepared-${id}.jpg`), type: 'jpeg', quality: 60 }).catch(() => {});
    return { label: (await send.innerText()).trim() };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

// 요청서 화면의 견적 칸에 금액과 설명을 넣고 보낸다. 보내면 숨고캐시가 차감된다.
// 보내기를 누른 뒤 발송이 확인되지 않으면(캐시 부족, 추가 확인 화면 등) 더 누르지 않고 화면을 기록한 뒤 멈춘다.
// dryRun이면 칸만 채우고 보내지 않는다.
export async function submitQuote(ctx, id, { price, message, dryRun = false }) {
  if (!(price > 0)) throw new Error('보낼 금액이 없습니다.');
  const page = await ctx.newPage();
  try {
    const send = await fillQuote(page, id, { price, message });
    for (let i = 0; i < 20 && !(await send.isEnabled()); i++) await sleep(500);
    if (!(await send.isEnabled())) throw new Error('견적 보내기 버튼이 눌리지 않는 상태입니다. 금액이나 설명이 숨고 기준에 맞지 않을 수 있습니다.');
    const label = (await send.innerText()).trim();
    if (dryRun) {
      await dump(page, `quote-dryrun-${id}`);
      return { sent: false, label };
    }
    const calls = [];
    const onResponse = (r) => {
      const m = r.request().method();
      if (m !== 'GET' && m !== 'OPTIONS' && r.url().startsWith('https://api.soomgo.com/')) calls.push({ method: m, url: r.url(), status: r.status() });
    };
    page.on('response', onResponse);
    await send.click();
    const isQuote = (c) => c.method === 'POST' && /quote|estimate|requests\/received/i.test(c.url);
    for (let i = 0; i < 40 && !calls.some(isQuote); i++) await sleep(500);
    page.off('response', onResponse);
    console.log(`[숨고] 견적 보내기(${label}) 뒤 요청: ${calls.map((c) => `${c.method} ${c.status} ${c.url}`).join(' , ') || '없음'}`);
    const posted = calls.find(isQuote);
    if (!posted) {
      await dump(page, `quote-unconfirmed-${id}`);
      throw new Error('견적 보내기를 눌렀지만 발송이 확인되지 않았습니다. 숨고에서 직접 확인해 주세요.');
    }
    if (posted.status >= 400) throw new Error(`숨고가 견적을 받지 않았습니다. (응답 ${posted.status})`);
    return { sent: true, label };
  } finally {
    await page.close().catch(() => {});
  }
}

// onNew({ text, images, soomgoId }) 는 새 요청서 한 건을 문의로 등록한다. onAlert(text) 는 사장님에게 알린다.
let context = null;
let generation = 0;

export function sendQuote(id, quote) {
  if (!context) throw new Error('비서가 꺼져 있어 숨고에 보낼 수 없습니다.');
  return submitQuote(context, id, quote);
}

export async function stopWatcher() {
  generation += 1;
  const closing = context;
  context = null;
  status.state = 'off';
  status.message = '';
  await closing?.close().catch(() => {});
}

export async function startWatcher({ onNew, onAlert, intervalMs = 3 * 60 * 1000 }) {
  if (context) return;
  const gen = ++generation;
  const active = () => gen === generation;
  status.state = 'starting';
  status.message = '크롬 창을 여는 중입니다.';
  await mkdir(PROFILE_DIR, { recursive: true });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    // 견적을 보내는 칸이 잘리지 않고 보이는 폭
    viewport: { width: 1400, height: 900 },
    args: ['--window-position=40,40'],
  });
  const page = context.pages()[0] || (await context.newPage());
  let alertedLogin = false;
  let dumped = false;

  while (active()) {
    try {
      const items = await listRequests(page);
      status.lastCheck = new Date().toISOString();
      if (items === null) {
        status.state = 'login';
        status.message = '숨고 로그인이 필요합니다. 노트북에 열린 크롬 창에서 로그인해 주세요.';
        if (!alertedLogin) {
          alertedLogin = true;
          console.log(`[숨고] ${status.message}`);
          await onAlert(`[싹다클린] ${status.message}`);
        }
        // 로그인 중인 화면을 건드리지 않도록, 로그인 화면을 벗어날 때까지 기다린다
        await page.waitForURL((u) => !/\/(login|sign-?in|auth)/i.test(u.pathname), { timeout: 0 });
        await sleep(3000);
        continue;
      }
      if (alertedLogin) console.log('[숨고] 로그인 확인됨. 받은 요청을 확인합니다.');
      alertedLogin = false;
      if (!dumped) {
        dumped = true;
        await dump(page, 'list');
      }

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
      status.state = 'ok';
      if (!items) {
        // 목록 데이터를 받지 못한 경우: 화면 구조를 확인할 수 있게 기록을 남긴다
        status.state = 'error';
        status.message = '받은 요청 목록을 읽지 못했습니다. 화면 구조 확인이 필요합니다.';
        await dump(page, 'list-unreadable');
      } else if (ids.length) status.message = `받은 요청 ${ids.length}건 확인`;
      else status.message = '받은 요청이 아직 없습니다. 새 요청을 기다리는 중입니다.';

      for (const id of fresh.slice(0, 5).reverse()) {
        const it = items.find((x) => x.id === id);
        await onNew({ text: requestText(it), images: await requestImages(context, it), soomgoId: id });
        seen.push(id);
        await saveSeen(seen);
        status.lastNew = new Date().toISOString();
        console.log(`[숨고] 새 요청서 등록: ${id}`);
      }
      if (ids.length) await saveSeen(seen);
    } catch (e) {
      if (!active()) return;
      status.state = 'error';
      status.message = `숨고 확인 중 오류: ${e.message.split('\n')[0]}`;
      console.error(`[숨고] ${status.message}`);
      if (/closed|crash/i.test(e.message)) {
        status.message = '숨고 확인용 크롬 창이 닫혔습니다. 설정에서 껐다가 다시 켜주세요.';
        context = null;
        await onAlert(`[싹다클린] ${status.message}`);
        return;
      }
    }
    await sleep(intervalMs * (0.8 + Math.random() * 0.4));
  }
}
