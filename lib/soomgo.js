// 숨고 받은 요청을 주기적으로 확인해 새 요청서를 문의로 등록한다.
// 로그인은 사장님이 이 프로그램이 띄운 크롬 창에서 직접 한다. 아이디·비밀번호는 다루지도 저장하지도 않는다.
// 받은 요청은 읽기만 한다. 견적은 설정의 '답변 보내는 방식'에 따라 숨고 창에 써 두기만 하거나(prepareQuote) 보낸다(sendQuote). 채팅 전송은 하지 않는다.
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

// 화면에 보여줄 숨고 확인 상태: 상태(off 꺼짐, starting 여는 중, login 로그인 필요, ok 정상, error 문제), 안내 글, 마지막 확인 시각, 마지막으로 새 요청을 등록한 시각
export const status = { state: 'off', message: '', lastCheck: null, lastNew: null };

// 정해진 시간만큼 기다린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 이미 등록한 요청 번호 목록을 읽는다. 파일이 없으면(처음이면) null
const loadSeen = async () => {
  try {
    return JSON.parse(await readFile(SEEN_FILE, 'utf8'));
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

// 고객이 요청서에 붙인 사진을 내려받는다. 숨고 주소의 사진만 받고, 실패한 사진은 건너뛴다.
async function requestImages(context, it) {
  // 요청서와 추가 요청에 붙은 사진 주소를 모은다. 숨고 주소(soomgo.com)인 것만, 겹치는 것은 빼고 남긴다
  const urls = [...(it.formattedRequestInfo?.images || []), ...(it.additionalRequirement?.images || [])]
    .map((v) => (typeof v === 'string' ? v : Object.values(v || {}).find((x) => typeof x === 'string' && x.startsWith('https://'))))
    .filter((u, i, all) => /^https:\/\/[\w.-]+\.soomgo\.com\//.test(u || '') && all.indexOf(u) === i);
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

// onNew({ text, images, soomgoId }) 는 새 요청서 한 건을 문의로 등록한다. onAlert(text) 는 사장님에게 알린다.
// 지금 열려 있는 숨고 크롬 창. 꺼져 있으면 null
let context = null;
// 켜고 끌 때마다 올라가는 번호. 끈 뒤에도 돌고 있던 옛 확인이 스스로 멈추게 하는 데 쓴다
let generation = 0;

// 견적을 실제로 보낸다 (자동 발송에서 쓴다)
export function sendQuote(id, quote) {
  if (!context) throw new Error('비서가 꺼져 있어 숨고에 보낼 수 없습니다.');
  return submitQuote(context, id, quote);
}

// 숨고 확인을 멈추고 크롬 창을 닫는다
export async function stopWatcher() {
  generation += 1;
  const closing = context;
  context = null;
  status.state = 'off';
  status.message = '';
  await closing?.close().catch(() => {});
}

// 숨고 확인을 시작한다. 3분마다 받은 요청을 확인해 새 요청서가 있으면 onNew로 넘긴다
export async function startWatcher({ onNew, onAlert, intervalMs = 3 * 60 * 1000 }) {
  // 이미 켜져 있으면 또 켜지 않는다
  if (context) return;
  // 이번에 켠 것의 번호. 이 번호가 최신일 때만 계속 돈다
  const gen = ++generation;
  const active = () => gen === generation;
  status.state = 'starting';
  status.message = '크롬 창을 여는 중입니다.';
  // 설치된 크롬을 숨고 전용 폴더로 연다. 사장님이 로그인할 수 있게 창이 보이는 상태로 연다
  await mkdir(PROFILE_DIR, { recursive: true });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    // 견적을 보내는 칸이 잘리지 않고 보이는 폭
    viewport: { width: 1400, height: 900 },
    args: ['--window-position=40,40'],
  });
  // 처음 열린 탭을 쓴다. 없으면 새로 연다
  const page = context.pages()[0] || (await context.newPage());
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
        await onNew({ text: requestText(it), images: await requestImages(context, it), soomgoId: id });
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
        context = null;
        await onAlert(`[싹다클린] ${status.message}`);
        return;
      }
    }
    // 다음 확인까지 기다린다. 3분을 기준으로 20%쯤 앞뒤로 달리해서 간격이 매번 똑같지 않게 한다
    await sleep(intervalMs * (0.8 + Math.random() * 0.4));
  }
}
