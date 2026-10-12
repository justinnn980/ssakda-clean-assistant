// 싹다클린 숨고 문의 AI 비서 서버.
// 사장님이 올린 캡처·사진이나 숨고에서 가져온 요청서를 분석해 답변 초안과 예상 견적을 만든다.
// 숨고 확인과 답변 자동 발송은 설정에서 켠 경우에만 한다.
import http from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.js';
import { analyze } from './lib/ai.js';
import * as kakao from './lib/kakao.js';
import * as soomgo from './lib/soomgo.js';
import * as kakaotalk from './lib/kakaotalk.js';
import { calc, defaultInputs, rangeText, customerPrice, won } from './public/pricing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');

if (!existsSync(ENV_FILE)) {
  const pin = String(randomInt(10000000, 100000000));
  await writeFile(
    ENV_FILE,
    `# 접속 비밀번호(숫자). 바꾸려면 숫자를 고치고 프로그램을 다시 시작하세요.\nACCESS_PIN=${pin}\nSESSION_SECRET=${randomBytes(24).toString('hex')}\nPORT=3210\n\n# 밖에서 접속하는 주소 (예: http://노트북의-tailscale-주소:3210). 카톡 알림의 링크에 쓰입니다.\nBASE_URL=\n\n# 카카오톡 알림 (README 참고)\nKAKAO_REST_KEY=\nKAKAO_CLIENT_SECRET=\n`,
    { mode: 0o600 },
  );
}
process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 3210);
const PIN = process.env.ACCESS_PIN || '';
if (!/^\d{4,}$/.test(PIN)) {
  console.error('.env 파일의 ACCESS_PIN을 4자리 이상 숫자로 정해주세요.');
  process.exit(1);
}
const SESSION = createHash('sha256').update(`${PIN}:${process.env.SESSION_SECRET || ''}`).digest('hex');
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// ---------- 분석 대기열 (한 번에 한 건씩) ----------
let queue = Promise.resolve();

function enqueueAnalysis(id) {
  queue = queue.then(() => runAnalysis(id)).catch((e) => console.error('[분석 오류]', e));
}

async function runAnalysis(id) {
  let inq = await store.load(id);
  try {
    const analysis = await analyze(inq, store.inquiryDir(id));
    inq = await store.load(id);
    inq.analysis = analysis;
    inq.title = analysis.title || inq.title;
    inq.estimateInputs = defaultInputs(cfg, analysis);
    const est = calc(cfg, inq.estimateInputs);
    const ready = analysis.estimate_ready && (est.table || est.cost);
    inq.draftReply = ready ? analysis.reply_with_estimate : analysis.reply_need_info;
    inq.status = 'awaiting_owner';
    inq.error = null;
    inq.log.push({ at: new Date().toISOString(), action: 'AI 분석 완료' });
    if (inq.soomgoId && !inq.autoSend) {
      const range = ready ? est.table || est.cost : null;
      if (settings.quoteMode === 'send') await autoSend(inq, analysis, range);
      else if (settings.quoteMode === 'fill') await autoFill(inq, analysis, range);
    }
    await store.save(inq);

    const risk = { low: '일반', review: '확인 필요', high: '사장님 검토 필수' }[analysis.risk_level];
    const price = ready ? `\n단가표 ${rangeText(est.table)}\n원가기준 ${rangeText(est.cost)}` : '\n견적: 현장 확인 필요';
    const auto = inq.autoSend ? `\n${inq.autoSend.sent ? '숨고에 자동 발송함' : inq.autoSend.prepared ? inq.autoSend.reason : `자동 발송 안 함: ${inq.autoSend.reason}`}` : '';
    await kakao.notify(`[싹다클린] ${inq.title}\n${risk}${price}${auto}`, `/#/i/${id}`);
  } catch (e) {
    inq = await store.load(id);
    inq.status = 'error';
    inq.error = e.message;
    inq.log.push({ at: new Date().toISOString(), action: '분석 실패', detail: e.message });
    await store.save(inq);
    await kakao.notify(`[싹다클린] 분석 실패: ${inq.title}\n${e.message}`, `/#/i/${id}`);
  }
}

// 사장님 확인 없이 숨고에 견적을 보낸다(숨고캐시 차감). 한 문의에 한 번만 시도하고, 보내지 않았으면 그 사유를 남긴다.
// 금액은 단가표 기준(없으면 원가 기준)의 최소 금액을 넣고, 답변 글에는 범위를 적는다.
async function autoSend(inq, analysis, range) {
  const at = new Date().toISOString();
  const skip = (reason) => {
    inq.autoSend = { sent: false, reason, at };
    inq.log.push({ at, action: '자동 발송 안 함', detail: reason });
  };
  if (analysis.job_category === 'other') return skip('싹다클린 업무가 아닌 요청입니다.');
  if (!range) return skip('금액을 계산할 정보가 부족합니다. 내용을 확인한 뒤 직접 보내주세요.');
  const reply = analysis.reply_with_estimate.replaceAll('{{견적}}', customerPrice(range)).trim();
  try {
    await soomgo.sendQuote(inq.soomgoId, { price: range.min, message: reply });
  } catch (e) {
    console.error(`[자동 발송 실패] ${inq.id}: ${e.message.split('\n')[0]}`);
    return skip(`보내지 못했습니다. ${e.message.split('\n')[0]}`);
  }
  inq.autoSend = { sent: true, price: range.min, at };
  inq.finalReply = inq.draftReply = reply;
  inq.finalPrice = customerPrice(range);
  inq.messages.push({ at, from: 'owner', text: reply, images: [] });
  inq.status = 'sent';
  inq.log.push({ at, action: '숨고에 자동 발송', detail: `견적 금액 ${won(range.min)}` });
}

// 숨고 창에 답변과 금액(계산됐으면)을 써 두고 멈춘다. 돈이 나가는 '견적 보내기'는 사장님이 숨고 창에서 직접 누른다.
async function autoFill(inq, analysis, range) {
  const at = new Date().toISOString();
  const reply = (range ? analysis.reply_with_estimate.replaceAll('{{견적}}', customerPrice(range)) : analysis.reply_need_info).trim();
  try {
    await soomgo.prepareQuote(inq.soomgoId, { price: range?.min ?? null, message: reply });
  } catch (e) {
    const reason = `숨고 창에 써 두지 못했습니다. ${e.message.split('\n')[0]}`;
    console.error(`[발송 준비 실패] ${inq.id}: ${reason}`);
    inq.autoSend = { sent: false, reason, at };
    inq.log.push({ at, action: '발송 준비 실패', detail: reason });
    return;
  }
  const reason = range
    ? '숨고 창에 답변과 금액을 써 두었습니다. 확인하고 "견적 보내기"를 눌러주세요.'
    : '숨고 창에 답변을 써 두었습니다. 금액을 넣고 "견적 보내기"를 눌러주세요.';
  inq.autoSend = { sent: false, prepared: true, reason, at };
  inq.draftReply = reply;
  inq.log.push({ at, action: '숨고 창에 발송 직전까지 준비', detail: range ? `견적 금액 ${won(range.min)}` : '금액 미정' });
}

async function createInquiry({ text, images, soomgoId = null }) {
  const id = store.newId();
  const files = await store.saveImages(id, images);
  const now = new Date().toISOString();
  await store.save({
    id, createdAt: now, status: 'analyzing', title: soomgoId ? '숨고 새 요청서' : text.slice(0, 30) || '새 문의', source: 'soomgo', soomgoId,
    messages: [{ at: now, from: 'customer', text, images: files }],
    analysis: null, estimateInputs: null, draftReply: '', finalReply: null, finalPrice: null, error: null,
    booking: { date: null, note: null },
    log: [{ at: now, action: soomgoId ? '숨고에서 자동 등록' : '문의 등록' }],
  });
  enqueueAnalysis(id);
  return id;
}

// ---------- HTTP 도우미 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('사진 용량이 너무 큽니다.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('요청 형식이 올바르지 않습니다.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authed(req) {
  const m = /(?:^|;\s*)ssak=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return Boolean(m) && timingSafeEqual(Buffer.from(m[1]), Buffer.from(SESSION));
}

const loginFails = new Map();
const allFails = { n: 0, since: 0, until: 0 };

async function serveFile(res, file) {
  try {
    send(res, 200, await readFile(file), { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, '찾을 수 없습니다.');
  }
}

const STATUSES = ['awaiting_owner', 'sent', 'on_hold', 'rejected', 'booked'];

// ---------- 라우팅 ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  if (method === 'POST' && p === '/api/login') {
    // 터널을 거치면 접속자 주소가 모두 같게 보이므로 Cloudflare나 Tailscale이 알려주는 주소를 쓰고, 전체 실패 횟수도 함께 제한한다
    const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const fail = loginFails.get(ip) || { n: 0, until: 0 };
    if (now < fail.until || now < allFails.until) return send(res, 429, { error: '잠시 후 다시 시도해주세요.' });
    const { pin } = await readJson(req, 1024);
    if (String(pin) !== PIN) {
      fail.n += 1;
      if (fail.n >= 5) Object.assign(fail, { n: 0, until: now + 5 * 60 * 1000 });
      loginFails.set(ip, fail);
      if (loginFails.size > 1000) loginFails.clear();
      if (now - allFails.since > 5 * 60 * 1000) Object.assign(allFails, { n: 0, since: now });
      allFails.n += 1;
      if (allFails.n >= 20) Object.assign(allFails, { n: 0, since: now, until: now + 5 * 60 * 1000 });
      return send(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }
    loginFails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `ssak=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}` });
  }

  // 화면 파일은 로그인 없이 내려준다. 고객 정보는 모두 /api 뒤에 있다.
  if (method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/kakao/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 404, '찾을 수 없습니다.');
    return serveFile(res, file);
  }

  if (!authed(req)) return send(res, 401, { error: '로그인이 필요합니다.' });

  if (method === 'GET' && p === '/kakao/login') {
    if (!kakao.kakaoConfigured()) return send(res, 400, '.env 파일에 KAKAO_REST_KEY를 먼저 넣어주세요.');
    res.writeHead(302, { Location: kakao.authorizeUrl() });
    return res.end();
  }
  if (method === 'GET' && p === '/kakao/callback') {
    const code = url.searchParams.get('code');
    if (!code) return send(res, 400, `카카오 연결 실패: ${url.searchParams.get('error_description') || '코드 없음'}`);
    await kakao.exchangeCode(code);
    await kakao.notify('[싹다클린] 카카오톡 알림이 연결되었습니다.');
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (method === 'GET' && p === '/api/state') {
    return send(res, 200, { config: cfg, ...featureState(), kakao: { configured: kakao.kakaoConfigured(), connected: await kakao.kakaoConnected() } });
  }

  if (method === 'POST' && p === '/api/settings') {
    await applySettings(await readJson(req, 1024));
    return send(res, 200, featureState());
  }

  if (method === 'POST' && p === '/api/shutdown') {
    send(res, 200, { ok: true });
    setTimeout(shutdown, 300);
    return;
  }

  if (method === 'GET' && p === '/api/inquiries') {
    const all = await store.list();
    return send(res, 200, all.map((i) => ({ id: i.id, title: i.title, status: i.status, updatedAt: i.updatedAt, risk: i.analysis?.risk_level || null, region: i.analysis?.region || null, autoSend: i.autoSend || null })));
  }

  if (method === 'POST' && p === '/api/inquiries') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text && !(body.images || []).length) return send(res, 400, { error: '숨고 캡처나 문의 내용을 넣어주세요.' });
    return send(res, 201, { id: await createInquiry({ text, images: body.images }) });
  }

  const m = /^\/api\/inquiries\/([0-9a-f-]+)(?:\/([a-z]+)(?:\/([\w.-]+))?)?$/.exec(p);
  if (!m) return send(res, 404, { error: '찾을 수 없습니다.' });
  const [, id, action, arg] = m;
  let inq;
  try {
    inq = await store.load(id);
  } catch {
    return send(res, 404, { error: '문의를 찾을 수 없습니다.' });
  }
  const log = (a, detail) => inq.log.push({ at: new Date().toISOString(), action: a, ...(detail ? { detail } : {}) });

  if (method === 'GET' && !action) return send(res, 200, inq);

  if (method === 'GET' && action === 'photo' && arg) {
    if (!/^photo-[\w-]+\.(jpg|png|webp)$/.test(arg)) return send(res, 404, '찾을 수 없습니다.');
    return serveFile(res, path.join(store.inquiryDir(id), arg));
  }

  if (method !== 'POST') return send(res, 405, { error: '허용되지 않는 요청입니다.' });
  const body = await readJson(req);

  // 고객이 추가로 보낸 답장·사진을 붙이고 다시 분석한다 (재견적)
  if (action === 'messages') {
    const text = String(body.text || '').trim();
    if (!text && !(body.images || []).length) return send(res, 400, { error: '내용이나 사진을 넣어주세요.' });
    const images = await store.saveImages(id, body.images);
    inq.messages.push({ at: new Date().toISOString(), from: body.from === 'owner' ? 'owner' : 'customer', text, images });
    inq.status = 'analyzing';
    log('추가 내용 등록, 재분석');
    await store.save(inq);
    enqueueAnalysis(id);
    return send(res, 200, inq);
  }

  if (action === 'reanalyze') {
    inq.status = 'analyzing';
    log('재분석 요청');
    await store.save(inq);
    enqueueAnalysis(id);
    return send(res, 200, inq);
  }

  // 화면에서 고친 견적 입력값·답변을 저장한다
  if (action === 'draft') {
    if (body.estimateInputs) inq.estimateInputs = body.estimateInputs;
    if (typeof body.draftReply === 'string') inq.draftReply = body.draftReply;
    await store.save(inq);
    return send(res, 200, inq);
  }

  // 사장님 승인: 복사해 숨고에서 직접 보낸 답변과 금액을 기록한다
  if (action === 'approve') {
    const reply = String(body.reply || '').trim();
    if (!reply) return send(res, 400, { error: '보낼 답변이 비어 있습니다.' });
    if (reply.includes('{{견적}}')) return send(res, 400, { error: '답변에 {{견적}} 자리가 남아 있습니다. 금액을 넣어주세요.' });
    inq.finalReply = reply;
    inq.draftReply = reply;
    inq.finalPrice = body.price ?? null;
    if (body.estimateInputs) inq.estimateInputs = body.estimateInputs;
    inq.messages.push({ at: new Date().toISOString(), from: 'owner', text: reply, images: [] });
    inq.status = 'sent';
    log('승인 후 복사', body.price ? `안내 금액: ${body.price}` : undefined);
    await store.save(inq);
    return send(res, 200, inq);
  }

  if (action === 'status') {
    if (!STATUSES.includes(body.status)) return send(res, 400, { error: '알 수 없는 상태입니다.' });
    inq.status = body.status;
    if (body.status === 'booked') inq.booking = { date: body.date || null, note: body.note || null };
    log(`상태 변경: ${body.status}`, body.note || body.date || undefined);
    await store.save(inq);
    return send(res, 200, inq);
  }

  return send(res, 404, { error: '찾을 수 없습니다.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '서버 오류가 발생했습니다.' });
  });
});

// 프로그램이 꺼질 때 분석 중이던 문의는 다시 대기열에 넣는다
for (const inq of await store.list()) if (inq.status === 'analyzing') enqueueAnalysis(inq.id);

// ---------- 켜고 끌 수 있는 기능 (설정 화면의 스위치) ----------
const SETTINGS_FILE = path.join(store.DATA_DIR, 'settings.json');
let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  settings = { tunnel: process.env.TUNNEL === '1', soomgo: process.env.SOOMGO_WATCH === '1' };
}
// 숨고 답변 보내는 방식: off(승인 후 직접 복사), fill(숨고 창에 써 두고 멈춤), send(확인 없이 발송)
if (!['off', 'fill', 'send'].includes(settings.quoteMode)) settings.quoteMode = settings.autoSend ? 'send' : 'off';
delete settings.autoSend;
// 카카오톡 채팅방 지켜보기: 방 이름, 찾을 말, 보낼 글
settings.kakaoWatch = Boolean(settings.kakaoWatch);
settings.talk = { room: '', keyword: '[방문견적]', message: '안녕하세요, 방문견적 가능합니다.', ...settings.talk };
const tunnel = { child: null, url: null, wanted: false, note: '' };

// Tailscale이 설치돼 있으면 그 실행 파일을 돌려준다. 맥 앱은 실행 경로에 넣어 주지 않아서 앱 안의 것을 직접 찾는다.
function tailscaleBin() {
  const known = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'].find((f) => existsSync(f));
  if (known) return known;
  try {
    execFileSync('tailscale', ['version'], { stdio: 'ignore' });
    return 'tailscale';
  } catch {
    return null;
  }
}

async function publishUrl(url) {
  tunnel.url = url;
  tunnel.note = '';
  process.env.BASE_URL = url;
  const file = path.join(store.DATA_DIR, 'public_url.txt');
  const previous = await readFile(file, 'utf8').catch(() => '');
  await writeFile(file, url + '\n');
  console.log(`  외부 접속:  ${url}`);
  if (previous.trim() !== url) await kakao.notify(`[싹다클린] 외부 접속 주소가 바뀌었습니다.\n${url}`);
}

// 외부 접속용 https 주소를 만든다. Tailscale이 있으면 주소가 바뀌지 않는 Tailscale Funnel을 쓰고,
// 없으면 켤 때마다 주소가 바뀌는 Cloudflare 임시 터널을 쓴다.
function startTunnel() {
  tunnel.wanted = true;
  if (tunnel.child) return;
  const ts = tailscaleBin();
  const child = ts
    ? spawn(ts, ['funnel', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel.child = child;
  let lastLine = '';
  const onOutput = (d) => {
    const text = String(d);
    lastLine = text.trim().split('\n').pop() || lastLine;
    const url = /https:\/\/[a-z0-9.-]+\.(?:ts\.net|trycloudflare\.com)/.exec(text);
    if (url && !tunnel.url) return publishUrl(url[0]).catch((e) => console.error(e));
    // Tailscale이 아직 준비되지 않았으면 무엇을 해야 하는지 설정 화면에 보여준다
    const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
    if (enable) tunnel.note = `Tailscale에서 외부 공개(Funnel)를 허용해야 합니다. 노트북에서 이 주소를 열어 허용해 주세요: ${enable[0]}`;
    else if (ts && /logged out|not logged in|needslogin|stopped|not running|failed to connect/i.test(text)) tunnel.note = 'Tailscale이 꺼져 있거나 로그인되어 있지 않습니다. 노트북에서 Tailscale을 열어 로그인해 주세요.';
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (e) => {
    tunnel.note = `외부 접속 프로그램(${ts ? 'Tailscale' : 'cloudflared'})을 실행하지 못했습니다.`;
    console.error('[외부 접속 실패]', e.message);
  });
  child.on('close', () => {
    const hadUrl = Boolean(tunnel.url);
    tunnel.child = null;
    tunnel.url = null;
    if (!tunnel.wanted) return;
    if (!hadUrl && !tunnel.note) tunnel.note = `외부 접속을 시작하지 못했습니다. ${lastLine}`.trim();
    console.error(`[외부 접속 끊김] 10초 뒤 다시 연결합니다. ${tunnel.note}`);
    setTimeout(() => tunnel.wanted && startTunnel(), 10000);
  });
}

function stopTunnel() {
  tunnel.wanted = false;
  tunnel.note = '';
  tunnel.child?.kill();
}

function startSoomgo() {
  soomgo.startWatcher({ onNew: createInquiry, onAlert: (t) => kakao.notify(t) }).catch((e) => {
    soomgo.status.state = 'error';
    soomgo.status.message = `숨고 확인을 시작하지 못했습니다: ${e.message.split('\n')[0]}`;
    console.error(`[숨고] ${soomgo.status.message}`);
  });
}

async function applySettings(next) {
  if (typeof next.tunnel === 'boolean' && next.tunnel !== settings.tunnel) {
    if (next.tunnel && PIN.length < 8) throw Object.assign(new Error('밖에서 접속하려면 접속 비밀번호가 8자리 이상이어야 합니다.'), { status: 400 });
    settings.tunnel = next.tunnel;
    next.tunnel ? startTunnel() : stopTunnel();
  }
  if (typeof next.soomgo === 'boolean' && next.soomgo !== settings.soomgo) {
    settings.soomgo = next.soomgo;
    next.soomgo ? startSoomgo() : await soomgo.stopWatcher();
  }
  if (['off', 'fill', 'send'].includes(next.quoteMode)) settings.quoteMode = next.quoteMode;
  let talkChanged = false;
  if (next.talk && typeof next.talk === 'object') {
    for (const k of ['room', 'keyword', 'message']) {
      if (typeof next.talk[k] === 'string') settings.talk[k] = next.talk[k].trim().slice(0, 300);
    }
    talkChanged = true;
  }
  if (typeof next.kakaoWatch === 'boolean' && next.kakaoWatch !== settings.kakaoWatch) {
    settings.kakaoWatch = next.kakaoWatch;
    talkChanged = true;
  }
  if (talkChanged) settings.kakaoWatch ? kakaotalk.start(settings.talk) : kakaotalk.stop();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// 지금 돌고 있는 버전(마지막으로 받은 변경). 업데이트가 적용됐는지 설정 화면에서 확인하는 데 쓴다.
let version = '';
try {
  version = execFileSync('git', ['log', '-1', '--format=%h · %cd', '--date=format:%m-%d %H:%M'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // git이 없거나 내려받은 폴더가 아니면 표시하지 않는다
}
const featureState = () => ({ settings, version, tunnelUrl: tunnel.url, tunnelNote: tunnel.note, soomgo: soomgo.status, talk: kakaotalk.status });

const PID_FILE = path.join(store.DATA_DIR, 'server.pid');
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('싹다클린 AI 비서를 끕니다.');
  stopTunnel();
  kakaotalk.stop();
  await soomgo.stopWatcher().catch(() => {});
  await unlink(PID_FILE).catch(() => {});
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? '이미 켜져 있습니다.' : e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  await mkdir(store.DATA_DIR, { recursive: true });
  await writeFile(PID_FILE, String(process.pid));
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('싹다클린 AI 비서가 켜졌습니다.');
  console.log(`  이 노트북:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  휴대폰:    http://${ip}:${PORT}`);
  console.log(`  접속 비밀번호: ${PIN}`);
  if (settings.tunnel && PIN.length >= 8) startTunnel();
  if (settings.soomgo) startSoomgo();
  if (settings.kakaoWatch) kakaotalk.start(settings.talk);
});
