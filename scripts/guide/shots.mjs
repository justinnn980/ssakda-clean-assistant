// 가이드 사진 다시 만들기 (화면이 바뀌었을 때). public/guide/*.jpg 와 docs/store/*.png 를 만든다.
// 준비: 1) 이 저장소를 복사한 폴더에서 SERVER_MODE=1 HOST=127.0.0.1 PORT=3297 로 시험 서버를 켠다(.env의 ACCESS_PIN=11112222, 새 data 폴더).
//       예시 문의가 있으면 '처리할 문의' 사진이 자연스럽다. 2) Playwright가 받아 둔 Chrome for Testing이 있어야 한다(정식 크롬은 --load-extension을 막는다).
// 실행: node scripts/guide/shots.mjs <작업 폴더>   (작업 폴더에 찍은 원본과 크롬 프로필이 생긴다)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright-core');
const SP = process.argv[2];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUIDE = `${REPO}/public/guide`;
const STORE = `${REPO}/docs/store`;
const RAW = `${SP}/raw`;
for (const d of [GUIDE, STORE, RAW]) fs.mkdirSync(d, { recursive: true });
const B = 'http://127.0.0.1:3297';
const CFT = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const FONT = "-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

const browser = await chromium.launch({ executablePath: CFT, headless: true, args: ['--lang=ko'] });

// 찍어 둔 화면 위에 빨간 테두리(boxes)와 '예시' 표시를 그려 저장한다. crop이 있으면 그 부분만
async function compose(raw, out, { boxes = [], crop = null, note = '', size = { width: 1280, height: 800 } } = {}) {
  const c = crop || { x: 0, y: 0, width: size.width, height: size.height };
  const page = await browser.newPage({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;overflow:hidden;width:${c.width}px;height:${c.height}px;position:relative;font-family:${FONT}">
    <img src="${dataUrl(raw)}" style="position:absolute;left:${-c.x}px;top:${-c.y}px">
    ${boxes.map((b) => `<div style="position:absolute;left:${b.x - c.x - 8}px;top:${b.y - c.y - 8}px;width:${b.w + 16}px;height:${b.h + 16}px;border:5px solid #e11d48;border-radius:12px;box-shadow:0 0 0 4px rgba(255,255,255,.8)"></div>`).join('')}
    ${note ? `<div style="position:absolute;right:16px;top:16px;background:#17201e;color:#fff;font-weight:700;font-size:18px;padding:6px 14px;border-radius:999px;opacity:.85">${note}</div>` : ''}
  </body></html>`);
  await page.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png', ...(out.endsWith('.jpg') ? { quality: 85 } : {}) });
  await page.close();
}

// ---------- 1. 비서 사이트 화면 ----------
const site = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
const sp = await site.newPage();
await sp.goto(`${B}/`);
await sp.fill('#pin', '11112222');
await sp.click('#go');
await sp.waitForSelector('#chatPower');
// 안내 페이지 (확장 없음) — 확장 파일 받기 버튼
await sp.goto(`${B}/#/guide`);
await sp.waitForSelector('.guide');
const dl = await sp.locator('a[href="/api/extension.zip"]').first();
await dl.scrollIntoViewIfNeeded();
await sp.waitForTimeout(300);
await sp.screenshot({ path: `${RAW}/site-download.png` });
const dlBox = await dl.boundingBox();
const guideBtn = await sp.locator('#guideBtn').boundingBox();
await compose(`${RAW}/site-download.png`, `${GUIDE}/1-download.jpg`, { boxes: [{ x: dlBox.x, y: dlBox.y, w: dlBox.width, h: dlBox.height }] });

// 첫 화면 (꺼짐) — 켜기 버튼 (확장 있는 것처럼 표시해서 찍는다)
const ext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
await ext.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.ssakdaExt = '0.1.2'; }));
const cookies = await site.cookies();
await ext.addCookies(cookies);
const ep = await ext.newPage();
await ep.goto(`${B}/#/`);
await ep.waitForSelector('#chatPower');
await ep.screenshot({ path: `${RAW}/home-off.png` });
const power = await ep.locator('#chatPower').boundingBox();
await compose(`${RAW}/home-off.png`, `${GUIDE}/8-turn-on.jpg`, { boxes: [{ x: power.x, y: power.y, w: power.width, h: power.height }] });
// 안내 페이지 맨 위 (확장 설치됨)
await ep.goto(`${B}/#/guide`);
await ep.waitForSelector('.guide .state-line');
await ep.screenshot({ path: `${RAW}/site-ok.png` });
const okLine = await ep.locator('.guide .state-line').first().boundingBox();
await compose(`${RAW}/site-ok.png`, `${GUIDE}/7-site-ok.jpg`, { boxes: [{ x: okLine.x, y: okLine.y, w: okLine.width, h: okLine.height }] });
// 첫 화면 (켜짐, PC 크롬에서 동작 중) — 확장이 알린 상태를 서버에 넣어 둔다
await ep.request.post(`${B}/api/settings`, { data: { chat: true } });
await ep.request.post(`${B}/api/ext/status`, { data: { state: 'ok', message: '채팅방 3개 확인', lastCheck: new Date().toISOString(), lastNew: new Date(Date.now() - 180000).toISOString(), account: '1', work: '' } });
await ep.goto(`${B}/#/`);
await ep.waitForSelector('#chatWin');
await ep.screenshot({ path: `${RAW}/home-on.png` });
const card = await ep.locator('.card').first().boundingBox();
await compose(`${RAW}/home-on.png`, `${GUIDE}/10-running.jpg`, { boxes: [{ x: card.x, y: card.y, w: card.width, h: card.height }] });
await ep.screenshot({ path: `${STORE}/1-dashboard.png` });
// 휴대폰 화면 (확장 없음)
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' });
await phoneCtx.addCookies(cookies);
const pp = await phoneCtx.newPage();
await pp.goto(`${B}/#/`);
await pp.waitForSelector('#chatPower');
await pp.screenshot({ path: `${RAW}/phone.png` });

// ---------- 2. 크롬 확장 화면 (chrome://extensions) ----------
const cft = await chromium.launchPersistentContext(`${SP}/shot-profile`, { executablePath: CFT, headless: true, locale: 'ko-KR', args: ['--lang=ko'], viewport: { width: 1280, height: 800 } });
const xp = await cft.newPage();
await xp.goto('chrome://extensions');
await xp.waitForTimeout(1200);
await xp.screenshot({ path: `${RAW}/ext-empty.png` });
const dev = await xp.evaluate(() => {
  const tb = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot;
  const t = tb.querySelector('#devMode').getBoundingClientRect();
  const label = [...tb.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === '개발자 모드')?.getBoundingClientRect();
  return { t: [t.x, t.y, t.width, t.height], l: label ? [label.x, label.y, label.width, label.height] : null };
});
const devBox = dev.l ? { x: dev.l[0], y: dev.t[1] - 4, w: dev.t[0] + dev.t[2] - dev.l[0], h: dev.t[3] + 8 } : { x: dev.t[0], y: dev.t[1], w: dev.t[2], h: dev.t[3] };
await compose(`${RAW}/ext-empty.png`, `${GUIDE}/3-devmode.jpg`, { boxes: [devBox] });
await xp.evaluate(() => document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode').click());
await xp.waitForTimeout(800);
await xp.screenshot({ path: `${RAW}/ext-dev.png` });
const load = await xp.evaluate(() => {
  const tb = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot;
  const b = [...tb.querySelectorAll('cr-button')].find((e) => /압축해제된/.test(e.textContent));
  const r = b?.getBoundingClientRect();
  return r ? [r.x, r.y, r.width, r.height] : null;
});
await compose(`${RAW}/ext-dev.png`, `${GUIDE}/4-load.jpg`, { boxes: load ? [{ x: load[0], y: load[1], w: load[2], h: load[3] }] : [] });
await cft.close();
// 확장을 설치한 모습
const cft2 = await chromium.launchPersistentContext(`${SP}/shot-profile2`, {
  executablePath: CFT, headless: true, locale: 'ko-KR', viewport: { width: 1280, height: 800 },
  args: ['--lang=ko', `--disable-extensions-except=${REPO}/extension`, `--load-extension=${REPO}/extension`],
});
let [sw] = cft2.serviceWorkers();
if (!sw) sw = await cft2.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const xp2 = await cft2.newPage();
await xp2.goto('chrome://extensions');
await xp2.waitForTimeout(1200);
await xp2.screenshot({ path: `${RAW}/ext-installed.png` });
const item = await xp2.evaluate(() => {
  const list = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot;
  const r = list.querySelector('extensions-item')?.getBoundingClientRect();
  return r ? [r.x, r.y, r.width, r.height] : null;
});
await compose(`${RAW}/ext-installed.png`, `${GUIDE}/6-installed.jpg`, { boxes: item ? [{ x: item[0], y: item[1], w: item[2], h: item[3] }] : [] });
// 확장 아이콘 창
const pop = await cft2.newPage();
await pop.setViewportSize({ width: 300, height: 230 });
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForTimeout(800);
await pop.screenshot({ path: `${RAW}/popup.png` });
await cft2.close();

// ---------- 3. 그림으로 그리는 화면 (윈도우 압축 풀기, 폴더 고르기, 숨고 창 예시) ----------
async function drawn(out, html, size = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(`<html><body style="margin:0;width:${size.width}px;height:${size.height}px;font-family:${FONT};background:#e9eef2;position:relative;overflow:hidden">${html}</body></html>`);
  await page.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png', ...(out.endsWith('.jpg') ? { quality: 88 } : {}) });
  await page.close();
}
const tag = (t) => `<div style="position:absolute;right:20px;top:20px;background:#17201e;color:#fff;font-weight:700;font-size:20px;padding:8px 16px;border-radius:999px;opacity:.85">${t}</div>`;
const red = 'border:5px solid #e11d48;border-radius:10px;box-shadow:0 0 0 4px rgba(255,255,255,.85)';
// 윈도우: 받은 파일 오른쪽 클릭 → 모두 압축 풀기
await drawn(`${GUIDE}/2-unzip.jpg`, `${tag('예시 그림 (윈도우)')}
  <div style="position:absolute;left:70px;top:60px;font-size:24px;font-weight:700;color:#17201e">다운로드 폴더</div>
  <div style="position:absolute;left:90px;top:130px;width:150px;text-align:center">
    <div style="width:96px;height:110px;margin:0 auto;background:#fde68a;border-radius:8px;position:relative;box-shadow:0 2px 6px rgba(0,0,0,.2)"><div style="position:absolute;left:40px;top:0;width:16px;height:110px;background:repeating-linear-gradient(#a16207 0 8px,#fde68a 8px 16px)"></div></div>
    <div style="margin-top:10px;font-size:18px;background:#cfe3ff;padding:4px 6px;border-radius:4px">ssakda-extension.zip</div>
  </div>
  <div style="position:absolute;left:250px;top:170px;width:330px;background:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:8px 0;font-size:21px">
    <div style="padding:12px 24px">열기</div>
    <div style="padding:12px 24px;margin:0 8px;${red};background:#eef6ff;font-weight:700">모두 압축 풀기...</div>
    <div style="padding:12px 24px">압축 파일로 보내기</div>
    <div style="padding:12px 24px">이름 바꾸기</div>
    <div style="padding:12px 24px">삭제</div>
  </div>
  <div style="position:absolute;left:680px;top:170px;width:520px;background:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:26px 30px;font-size:20px">
    <div style="font-size:23px;font-weight:700;margin-bottom:18px">압축(ZIP) 폴더 풀기</div>
    <div style="color:#555;margin-bottom:8px">파일을 아래 폴더에 풉니다:</div>
    <div style="border:1px solid #bbb;padding:10px;border-radius:6px;margin-bottom:26px">C:\\Users\\사장님\\Downloads\\ssakda-extension</div>
    <div style="text-align:right"><span style="display:inline-block;padding:10px 26px;background:#0067c0;color:#fff;border-radius:6px;font-weight:700;${red}">압축 풀기</span> <span style="display:inline-block;padding:10px 22px;border:1px solid #bbb;border-radius:6px;margin-left:12px">취소</span></div>
  </div>
  <div style="position:absolute;left:90px;top:560px;font-size:24px;line-height:1.6;color:#17201e">① 받은 파일을 <b>마우스 오른쪽 버튼</b>으로 누릅니다<br>② <b>모두 압축 풀기...</b> → <b>압축 풀기</b><br>③ 같은 이름의 폴더가 생깁니다. 이 폴더는 <b>지우지 마세요</b>.</div>`);
// 폴더 고르기 창
await drawn(`${GUIDE}/5-pick-folder.jpg`, `${tag('예시 그림 (윈도우)')}
  <div style="position:absolute;left:150px;top:90px;width:980px;height:560px;background:#fff;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.28);font-size:21px">
    <div style="padding:16px 22px;font-weight:700;border-bottom:1px solid #ddd">확장 프로그램 디렉터리 선택</div>
    <div style="display:flex;height:410px">
      <div style="width:230px;border-right:1px solid #eee;padding:16px 20px;color:#444;line-height:2.2">바탕 화면<br><b style="color:#0067c0">다운로드</b><br>문서<br>사진</div>
      <div style="flex:1;padding:18px 24px">
        <div style="color:#666;margin-bottom:14px">다운로드</div>
        <div style="display:flex;align-items:center;gap:14px;padding:10px 14px;${red};background:#eef6ff;width:420px"><span style="display:inline-block;width:40px;height:30px;background:#f5c542;border-radius:4px"></span><b>ssakda-extension</b></div>
        <div style="display:flex;align-items:center;gap:14px;padding:10px 14px;color:#888;margin-top:12px"><span style="display:inline-block;width:40px;height:30px;background:#fde68a;border-radius:4px"></span>ssakda-extension.zip</div>
      </div>
    </div>
    <div style="border-top:1px solid #ddd;padding:16px 22px;text-align:right"><span style="display:inline-block;padding:10px 26px;background:#0067c0;color:#fff;border-radius:6px;font-weight:700;${red}">폴더 선택</span> <span style="display:inline-block;padding:10px 22px;border:1px solid #bbb;border-radius:6px;margin-left:12px">취소</span></div>
  </div>
  <div style="position:absolute;left:150px;top:680px;font-size:24px;color:#17201e">압축을 푼 <b>ssakda-extension</b> 폴더를 한 번 누르고 <b>폴더 선택</b>을 누릅니다.</div>`);
// 숨고 로그인 화면 + AI 비서 표시 (실제 숨고 로그인 화면을 찍고 표시를 얹는다)
const real = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
await real.goto('https://soomgo.com/login', { waitUntil: 'domcontentloaded' });
await real.waitForTimeout(2500);
await real.screenshot({ path: `${RAW}/soomgo-login.png` });
await real.close();
const pill = (t) => `<div style="position:absolute;left:12px;bottom:12px;padding:8px 14px;border-radius:999px;background:#0f766e;color:#fff;font:600 15px/1.4 ${FONT};box-shadow:0 2px 8px rgba(0,0,0,.25)">싹다클린 AI 비서 · ${t}</div>`;
await drawn(`${GUIDE}/9-soomgo-login.jpg`, `<img src="${dataUrl(`${RAW}/soomgo-login.png`)}" style="position:absolute;left:0;top:0">${pill('숨고에 로그인해 주세요')}
  <div style="position:absolute;left:4px;bottom:4px;width:330px;height:52px;${red}"></div>`);
// 새 채팅방 탭에 답장을 써 둔 모습 (예시 화면)
const roomHtml = (withTag) => `${withTag ? tag('예시 화면 (실제 숨고와 모양이 다릅니다)') : ''}
  <div style="position:absolute;left:140px;top:70px;width:1000px;height:640px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.15);overflow:hidden">
    <div style="padding:18px 26px;font-size:22px;font-weight:700;border-bottom:1px solid #eee">채팅 · 홍길동 고객</div>
    <div style="padding:22px 26px;font-size:18px;line-height:1.6">
      <div style="background:#f1f5f4;border-radius:12px;padding:14px 18px;width:560px">요청서 · 유품정리 · 경기 평택시 안중읍 · 24평 아파트(엘리베이터 있음)<br>가구와 가전이 많아요.</div>
      <div style="background:#e7f3f1;border-radius:12px;padding:14px 18px;width:460px;margin:14px 0 0 auto">견적 금액은 현장 확인 후 안내드립니다.</div>
    </div>
    <div style="position:absolute;left:26px;right:26px;bottom:24px;display:flex;gap:12px;align-items:flex-end">
      <div style="flex:1;border:3px solid #0f766e;border-radius:12px;padding:14px 16px;font-size:17px;line-height:1.55;height:150px;overflow:hidden">안녕하세요 고객님, 싹다클린입니다. 평택시 안중읍 24평 아파트 유품 정리, 가구와 가전이 많다고 남겨 주신 내용 확인했습니다.<br><br>정확한 안내를 위해 희망하시는 날짜와, 남겨 두실 물건을 미리 나누셨는지 알려 주시겠어요? 방마다 전체가 보이게 한 장씩 사진을 보내 주시면…</div>
      <div style="padding:14px 26px;background:#0f766e;color:#fff;border-radius:10px;font-weight:700;font-size:19px;${red}">전송</div>
    </div>
  </div>${pill('답장을 써 두었습니다. 읽어 보고 전송을 눌러 주세요')}`;
await drawn(`${GUIDE}/11-draft.jpg`, roomHtml(true));
await drawn(`${STORE}/2-reply-draft.png`, roomHtml(false));

// ---------- 4. 웹스토어 사진 3번: 확장 아이콘 창 ----------
await drawn(`${STORE}/3-popup.png`, `<div style="position:absolute;left:0;top:0;width:1280px;height:800px;background:linear-gradient(135deg,#e7f3f1,#f4f6f5)"></div>
  <div style="position:absolute;left:120px;top:250px;font-size:44px;font-weight:800;color:#0f766e;line-height:1.35">숨고 새 채팅방에<br>AI 비서가 첫 응대를</div>
  <div style="position:absolute;left:120px;top:400px;font-size:24px;color:#334;line-height:1.6">확장 아이콘을 누르면 지금 상태를 볼 수 있습니다.</div>
  <img src="${dataUrl(`${RAW}/popup.png`)}" style="position:absolute;left:760px;top:260px;border-radius:14px;box-shadow:0 10px 32px rgba(0,0,0,.25);transform:scale(1.4);transform-origin:top left">`);

await browser.close();
console.log('extension id for this shot:', extId);
console.log(fs.readdirSync(GUIDE).join(' '));
console.log(fs.readdirSync(STORE).join(' '));
