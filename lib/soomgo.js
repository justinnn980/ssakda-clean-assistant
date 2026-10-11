// 숨고 받은 요청을 주기적으로 확인해 새 요청서를 문의로 등록한다.
// 로그인은 사장님이 이 프로그램이 띄운 크롬 창에서 직접 한다. 아이디·비밀번호는 다루지도 저장하지도 않는다.
// 읽기만 한다. 견적 발송과 채팅 전송은 하지 않는다.
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const LIST_URL = 'https://soomgo.com/requests/received';
const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
const SEEN_FILE = path.join(DATA_DIR, 'soomgo_seen.json');
const DEBUG_DIR = path.join(DATA_DIR, 'soomgo-debug');
// 요청서 번호에는 숫자가 들어 있다. /requests/received/unread 같은 탭 주소는 제외한다
const DETAIL_RE = /\/requests\/received\/([\w-]*\d[\w-]*)/;

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

async function listRequestIds(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (loggedOut(page)) return null;
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const ids = [];
  for (const h of hrefs) {
    const m = DETAIL_RE.exec(h || '');
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  ids.empty = text.includes('아직 받은 요청이 없어요');
  return ids;
}

async function readRequest(context, id) {
  const page = await context.newPage();
  try {
    await page.goto(`https://soomgo.com/requests/received/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const text = (await page.evaluate(() => (document.querySelector('main') || document.body).innerText)).trim().slice(0, 8000);
    const shot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
    return { text, image: `data:image/jpeg;base64,${shot.toString('base64')}` };
  } finally {
    await page.close();
  }
}

// onNew({ text, images, soomgoId }) 는 새 요청서 한 건을 문의로 등록한다. onAlert(text) 는 사장님에게 알린다.
let context = null;
let generation = 0;

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
    viewport: { width: 1100, height: 900 },
    args: ['--window-position=40,40'],
  });
  const page = context.pages()[0] || (await context.newPage());
  let alertedLogin = false;
  let dumped = false;

  while (active()) {
    try {
      const ids = await listRequestIds(page);
      status.lastCheck = new Date().toISOString();
      if (ids === null) {
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
      if (ids.length) status.message = `받은 요청 ${ids.length}건 확인`;
      else if (ids.empty) status.message = '받은 요청이 아직 없습니다. 새 요청을 기다리는 중입니다.';
      else {
        // 요청은 있는데 번호를 찾지 못한 경우: 화면 구조를 확인할 수 있게 기록을 남긴다
        status.state = 'error';
        status.message = '받은 요청은 있는데 내용을 읽지 못했습니다. 화면 구조 확인이 필요합니다.';
        await dump(page, 'list-unreadable');
      }

      for (const id of fresh.slice(0, 5).reverse()) {
        const req = await readRequest(context, id);
        await onNew({ text: req.text, images: [req.image], soomgoId: id });
        seen.push(id);
        await saveSeen(seen);
        status.lastNew = new Date().toISOString();
        console.log(`[숨고] 새 요청서 등록: ${id}`);
        await sleep(4000 + Math.random() * 4000);
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
