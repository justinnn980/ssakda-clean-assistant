// 싹다클린 숨고 문의 AI 비서 서버.
// 숨고에 새 채팅방이 생기면 그 채팅방을 보고 첫 응대(확인할 것과 사진 요청)를 써서 보낸다.
// 사장님이 올린 캡처·사진이나 숨고에서 가져온 요청서를 분석해 답변 초안과 예상 견적을 만드는 견적 기능은 꺼 두고 화면에서 숨겼다(QUOTE_FEATURES).
// 숨고 확인과 자동 발송은 설정에서 켠 경우에만 한다.
// ---- 노드(Node)에 기본으로 들어 있는 기능 ----
// 웹 서버를 여는 기능
import http from 'node:http';
// 파일을 읽고, 쓰고, 폴더를 만들고, 지우는 기능
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
// 다른 프로그램(cloudflared, tailscale, git)을 실행하는 기능
import { spawn, execFileSync } from 'node:child_process';
// 파일이 있는지 보거나, 프로그램을 켜는 순간에 바로 읽어야 하는 파일을 읽는 기능
import { existsSync, readFileSync } from 'node:fs';
// 암호 계산, 무작위 숫자 만들기, 값을 안전하게 비교하는 기능
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
// 폴더·파일 경로를 다루는 기능
import path from 'node:path';
// 이 컴퓨터의 네트워크 주소 같은 정보를 알아내는 기능
import os from 'node:os';
// 이 파일이 있는 위치를 알아내는 데 쓰는 기능
import { fileURLToPath } from 'node:url';

// ---- 이 프로그램의 다른 파일들 ----
// 문의와 사진을 파일로 저장하고 읽는 부분
import * as store from './lib/store.js';
// AI로 문의를 분석하는 부분과, 고를 수 있는 AI 목록
import { analyze, PROVIDERS } from './lib/ai.js';
// 사장님 카카오톡 '나와의 채팅'으로 알림을 보내는 부분
import * as kakao from './lib/kakao.js';
// 숨고 받은 요청을 확인하고 견적을 써 넣는 부분
import * as soomgo from './lib/soomgo.js';
// 카카오톡 채팅방을 지켜보다가 답장하는 부분 (카톡 일감 잡기)
import * as kakaotalk from './lib/kakaotalk.js';
// 금액 계산 규칙. 화면(public 폴더)과 같은 파일을 쓴다
import { calc, defaultInputs, rangeText, customerPrice, won } from './public/pricing.js';

// 이 프로그램이 들어 있는 폴더
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 접속 비밀번호 같은 비밀 값을 적어 두는 파일
const ENV_FILE = path.join(ROOT, '.env');

// 처음 켜서 .env 파일이 없으면 새로 만든다
if (!existsSync(ENV_FILE)) {
  // 접속 비밀번호: 무작위 숫자 8자리
  const pin = String(randomInt(10000000, 100000000));
  // 비밀번호, 로그인 유지에 쓰는 무작위 값, 포트 번호, 카카오 알림용 빈 칸을 적어 둔다
  await writeFile(
    ENV_FILE,
    `# 접속 비밀번호(숫자). 바꾸려면 숫자를 고치고 프로그램을 다시 시작하세요.\nACCESS_PIN=${pin}\nSESSION_SECRET=${randomBytes(24).toString('hex')}\nPORT=3210\n\n# 밖에서 접속하는 주소 (예: http://노트북의-tailscale-주소:3210). 카톡 알림의 링크에 쓰입니다.\nBASE_URL=\n\n# 카카오톡 알림 (README 참고)\nKAKAO_REST_KEY=\nKAKAO_CLIENT_SECRET=\n`,
    // 이 컴퓨터의 내 계정만 읽고 쓸 수 있게 한다
    { mode: 0o600 },
  );
}
// .env 파일에 적힌 값들을 프로그램 안으로 읽어 들인다
process.loadEnvFile(ENV_FILE);

// 서버가 쓸 포트 번호(주소 끝의 :3210). 정해 두지 않았으면 3210
const PORT = Number(process.env.PORT || 3210);
// 접속 비밀번호
const PIN = process.env.ACCESS_PIN || '';
// 비밀번호가 숫자 4자리 이상이 아니면 켜지 않고 끝낸다
if (!/^\d{4,}$/.test(PIN)) {
  console.error('.env 파일의 ACCESS_PIN을 4자리 이상 숫자로 정해주세요.');
  process.exit(1);
}
// 로그인한 브라우저에 주는 표(쿠키 값). 비밀번호와 무작위 값을 섞어 계산한 64글자라서 이 값을 봐도 비밀번호를 알아낼 수 없다. 비밀번호를 바꾸면 이 값도 바뀌어 모두 다시 로그인해야 한다
const SESSION = createHash('sha256').update(`${PIN}:${process.env.SESSION_SECRET || ''}`).digest('hex');
// 단가·원가·이익률이 적힌 config.json을 읽는다
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// 견적 기능(숨고 받은 요청 확인, 예상 금액 계산, 견적 보내기)을 쓸지. 2026-10-15 사용자 결정으로 끄고 화면에서 숨겼다.
// 코드는 남겨 두었으니 true로 바꾸면 다시 쓸 수 있다
const QUOTE_FEATURES = false;
// 서버(사무실 맥북)에서 돌리는지. 서버의 실행 설정(launchd)이 SERVER_MODE=1을 넣어 준다.
// 노트북에서만 되는 기능(밖에서 접속하기 스위치, 프로그램 끄기)은 쓰지 않는다. 카톡 일감 잡기는 카카오톡이 있는 PC의 도우미가 맡는다. 밖에서 접속하는 주소는 서버의 터널이 맡고, .env의 BASE_URL에 적어 둔다
const SERVER_MODE = process.env.SERVER_MODE === '1';
// 서버에서는 숨고 채팅을 사장님 PC 크롬의 '싹다클린 AI 비서' 확장(extension 폴더)이 맡는다(2026-10-19 사용자 결정). 서버는 숨고 크롬을 띄우지 않는다.
// 확장이 숨고 창을 띄워 새 채팅방을 열고 그 글을 보내면(/api/ext/...), 서버가 AI로 첫 응대를 써 두고, 확장이 가져가 그 채팅방에 써 넣거나 보낸다
const EXT_RUNNER = SERVER_MODE;
// 확장이 마지막으로 알려 준 상태(숨고 채팅 칸에 보여 준다). seenAt은 확장이 마지막으로 연락한 시각이라, 오래되면 PC 크롬이 꺼진 것이다
let extStatus = { state: 'off', message: '', lastCheck: null, lastNew: null, account: null, work: '', seenAt: null };
// 서버에는 카카오톡이 없어서, 카톡 일감 잡기는 카카오톡이 있는 PC의 '카톡 일감 도우미'(scripts/kakaotalk-agent.mjs)가 맡는다.
// 도우미가 몇 초마다 알려 주는 상태(지켜보기 상태·최근 기록·방 목록)와 마지막으로 연락한 시각
let talkAgent = { state: 'off', message: '', lastCheck: null, events: [], rooms: [], roomsNote: '', seenAt: null };

// ---------- 분석 대기열 (한 번에 한 건씩) ----------
// 앞의 분석이 끝나야 다음 분석이 시작되도록 줄을 세우는 변수. 처음에는 '이미 끝난 일'로 시작한다
let queue = Promise.resolve();

// 문의 한 건을 줄 맨 뒤에 세운다. 분석 중에 오류가 나도 줄이 끊기지 않게 오류는 기록만 한다
function enqueueAnalysis(id) {
  queue = queue.then(() => runAnalysis(id)).catch((e) => console.error('[분석 오류]', e));
}

// 문의 한 건을 분석한다: AI 분석 → 금액 계산 → 답변 초안 → (설정에 따라) 숨고에 쓰기 → 카톡 알림
async function runAnalysis(id) {
  // 저장해 둔 문의를 읽는다. 숨고 채팅방에서 온 것이면 채팅 첫 응대를 만든다
  let inq = await store.load(id);
  if (inq.kind === 'chat') return runChatReply(inq);
  try {
    // 설정에서 고른 AI에게 문의 글과 사진을 넘겨 분석 결과를 받는다 (보통 1분 안팎)
    const analysis = await analyze(inq, store.inquiryDir(id), settings.ai);
    // 분석하는 동안 화면에서 문의가 바뀌었을 수 있어 다시 읽은 뒤 결과를 붙인다
    inq = await store.load(id);
    inq.analysis = analysis;
    inq.title = analysis.title || inq.title;
    // AI가 낸 차량·인원·양으로 금액 계산에 넣을 값들을 만들고, 두 가지 방식의 금액을 계산한다
    inq.estimateInputs = defaultInputs(cfg, analysis);
    const est = calc(cfg, inq.estimateInputs);
    // 견적을 안내할 수 있는 경우: AI가 정보가 충분하다고 봤고, 두 방식 중 하나라도 금액이 계산됐을 때
    const ready = analysis.estimate_ready && (est.table || est.cost);
    // 견적을 낼 수 있으면 견적 안내 답변을, 아니면 정보를 더 묻는 답변을 초안으로 둔다
    inq.draftReply = ready ? analysis.reply_with_estimate : analysis.reply_need_info;
    // 상태를 '승인 대기'로 바꾸고, 전에 난 오류 표시는 지운다
    inq.status = 'awaiting_owner';
    inq.error = null;
    inq.log.push({ at: new Date().toISOString(), action: 'AI 분석 완료' });
    // 숨고에서 가져온 문의이고 아직 발송을 시도한 적이 없을 때만, 설정한 방식대로 숨고에 보내거나 써 둔다
    if (inq.soomgoId && !inq.autoSend) {
      // 숨고에 넣을 금액 범위: 단가표 기준을 먼저 쓰고, 없으면 원가 기준
      const range = ready ? est.table || est.cost : null;
      if (settings.quoteMode === 'send') await autoSend(inq, analysis, range);
      else if (settings.quoteMode === 'fill') await autoFill(inq, analysis, range);
    }
    // 여기까지의 결과를 파일에 저장한다
    await store.save(inq);

    // 사장님 카카오톡으로 보낼 알림 글을 만든다: 제목, 위험도, 금액, 자동 발송 결과
    const risk = { low: '일반', review: '확인 필요', high: '사장님 검토 필수' }[analysis.risk_level];
    const price = ready ? `\n단가표 ${rangeText(est.table)}\n원가기준 ${rangeText(est.cost)}` : '\n견적: 현장 확인 필요';
    const auto = inq.autoSend ? `\n${inq.autoSend.sent ? '숨고에 자동 발송함' : inq.autoSend.prepared ? inq.autoSend.reason : `자동 발송 안 함: ${inq.autoSend.reason}`}` : '';
    await kakao.notify(`[싹다클린] ${inq.title}\n${risk}${price}${auto}`, `/#/i/${id}`);
  } catch (e) {
    // 분석에 실패하면 상태를 '분석 실패'로 바꾸고 사유를 남긴 뒤 카톡으로 알린다
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
  // 지금 시각 (기록에 남길 때 쓴다)
  const at = new Date().toISOString();
  // 보내지 않기로 했을 때 그 사유를 문의에 남기는 작은 함수
  const skip = (reason) => {
    inq.autoSend = { sent: false, reason, at };
    inq.log.push({ at, action: '자동 발송 안 함', detail: reason });
  };
  // 싹다클린 업무가 아닌 요청이면 보내지 않는다
  if (analysis.job_category === 'other') return skip('싹다클린 업무가 아닌 요청입니다.');
  // 금액을 계산하지 못했으면 보내지 않는다
  if (!range) return skip('금액을 계산할 정보가 부족합니다. 내용을 확인한 뒤 직접 보내주세요.');
  // 답변의 {{견적}} 자리에 "65만~80만 원" 같은 금액 글자를 넣는다
  const reply = analysis.reply_with_estimate.replaceAll('{{견적}}', customerPrice(range)).trim();
  // 숨고 창에서 견적을 실제로 보낸다. 실패하면 사유를 남기고 끝낸다 (다시 시도하지 않는다)
  try {
    await soomgo.sendQuote(inq.soomgoId, { price: range.min, message: reply });
  } catch (e) {
    console.error(`[자동 발송 실패] ${inq.id}: ${e.message.split('\n')[0]}`);
    return skip(`보내지 못했습니다. ${e.message.split('\n')[0]}`);
  }
  // 보낸 것으로 기록한다: 보낸 금액, 보낸 답변, 대화 기록, 상태는 '전송 완료'
  inq.autoSend = { sent: true, price: range.min, at };
  inq.finalReply = inq.draftReply = reply;
  inq.finalPrice = customerPrice(range);
  inq.messages.push({ at, from: 'owner', text: reply, images: [] });
  inq.status = 'sent';
  inq.log.push({ at, action: '숨고에 자동 발송', detail: `견적 금액 ${won(range.min)}` });
}

// 숨고 창에 답변과 금액(계산됐으면)을 써 두고 멈춘다. 돈이 나가는 '견적 보내기'는 사장님이 숨고 창에서 직접 누른다.
async function autoFill(inq, analysis, range) {
  // 지금 시각
  const at = new Date().toISOString();
  // 써 둘 답변: 금액이 계산됐으면 금액을 넣은 견적 안내 답변, 아니면 정보를 더 묻는 답변
  const reply = (range ? analysis.reply_with_estimate.replaceAll('{{견적}}', customerPrice(range)) : analysis.reply_need_info).trim();
  // 숨고 창에 새 탭을 열어 답변과 금액을 써 둔다. 실패하면 사유를 남기고 끝낸다
  try {
    await soomgo.prepareQuote(inq.soomgoId, { price: range?.min ?? null, message: reply });
  } catch (e) {
    const reason = `숨고 창에 써 두지 못했습니다. ${e.message.split('\n')[0]}`;
    console.error(`[발송 준비 실패] ${inq.id}: ${reason}`);
    inq.autoSend = { sent: false, reason, at };
    inq.log.push({ at, action: '발송 준비 실패', detail: reason });
    return;
  }
  // 써 두는 데 성공했으면, 사장님이 이어서 할 일을 문의에 적어 둔다
  const reason = range
    ? '숨고 창에 답변과 금액을 써 두었습니다. 확인하고 "견적 보내기"를 눌러주세요.'
    : '숨고 창에 답변을 써 두었습니다. 금액을 넣고 "견적 보내기"를 눌러주세요.';
  inq.autoSend = { sent: false, prepared: true, reason, at };
  inq.draftReply = reply;
  inq.log.push({ at, action: '숨고 창에 발송 직전까지 준비', detail: range ? `견적 금액 ${won(range.min)}` : '금액 미정' });
}

// ---------- 숨고 채팅 첫 응대 ----------
// 채팅방 한 건의 첫 응대를 만든다: AI가 채팅방 화면을 보고 확인할 것과 사진을 요청하는 답장을 씀 → (설정에 따라) 숨고 채팅에 보내거나 써 둠 → 카톡 알림
async function runChatReply(inq) {
  const id = inq.id;
  // 숨고 알리미의 알림만 새로 온 채팅방은 답하지 않는다. AI를 돌리지 않고 카톡으로도 알리지 않으며, '보류'로 둔다
  const notice = noticeOnly(inq.messages[0]?.text || '');
  if (notice) {
    inq.title = `숨고 알리미: ${notice}`.slice(0, 60);
    inq.status = 'on_hold';
    skipChat(inq, `숨고 알리미의 알림(${notice})만 새로 온 채팅방이라 답하지 않았습니다.`);
    return store.save(inq);
  }
  try {
    const result = await analyze(inq, store.inquiryDir(id), settings.ai, 'chat');
    // 분석하는 동안 화면에서 문의가 바뀌었을 수 있어 다시 읽은 뒤 결과를 붙인다
    inq = await store.load(id);
    inq.analysis = result;
    inq.title = result.title || inq.title;
    inq.draftReply = result.reply;
    inq.status = 'awaiting_owner';
    inq.error = null;
    inq.log.push({ at: new Date().toISOString(), action: 'AI 첫 응대 작성' });
    // 아직 보내기를 시도한 적이 없을 때만 보낸다 (채팅방마다 한 번). PC 크롬 확장이 가져온 채팅방이면 확장이 써 넣도록 남겨 둔다
    if (!inq.autoSend) {
      if (inq.source === 'ext') planExtReply(inq, result);
      else await chatAutoReply(inq, result);
    }
    await store.save(inq);
    // 확장이 써 넣기를 기다리는 중이면 알림은 확장이 결과를 알려 준 뒤에 보낸다
    if (!inq.autoSend) return;
    // 카톡 알림: 보냄 / 써 둠 / 보내지 않은 사유
    await notifyChatOutcome(inq);
  } catch (e) {
    // AI가 실패하면 보내지 않고, 사유를 남긴 뒤 카톡으로 알린다
    inq = await store.load(id);
    inq.status = 'error';
    inq.error = e.message;
    inq.log.push({ at: new Date().toISOString(), action: '첫 응대 작성 실패', detail: e.message });
    await store.save(inq);
    await kakao.notify(`[숨고 채팅] 첫 응대를 만들지 못했습니다: ${inq.title}\n${e.message}`, `/#/i/${id}`);
  }
}

// 채팅방의 마지막 글이 숨고 알리미(숨고가 자동으로 보내는 안내)면 그 알림 제목을, 아니면 빈 글을 돌려준다.
// 예전 채팅방이 '미접속 견적 보상'(고객이 48시간 동안 견적을 읽지 않음) 같은 알림으로 목록 위로 올라오면 새 채팅방처럼 보인다.
// '고객이 견적을 읽었어요' 알림은 견적을 보낸 직후의 새 채팅방에도 붙으므로 빼고 본다.
// 화면 글에서 글마다 끝에 시각(오전 6:48)이 붙는 것으로 가른다: 알리미 글의 시각 뒤에 다른 시각이 없으면 알리미가 마지막 글이다
function noticeOnly(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const end = lines.indexOf('메시지를 입력하세요.');
  const chat = end < 0 ? lines : lines.slice(0, end);
  const at = chat.lastIndexOf('숨고 알리미');
  if (at < 0) return '';
  const isTime = (l) => /^(오전|오후)\s?\d{1,2}:\d{2}$/.test(l);
  const after = chat.slice(at + 1);
  const t = after.findIndex(isTime);
  if (t < 0 || after.slice(t + 1).some(isTime)) return '';
  const notice = after.slice(0, t).filter(Boolean);
  if (notice.some((l) => /견적을 읽었/.test(l))) return '';
  return notice[0] || '알림';
}

// 고객에게 바로 나가는 글을 마지막으로 점검한다. 문제가 있으면 그 사유를, 없으면 빈 글을 돌려준다
function replyProblem(text) {
  if (!text.trim()) return '보낼 답장이 비어 있습니다.';
  if (text.length > 1000) return '답장이 너무 깁니다.';
  if (/\{\{|\}\}/.test(text)) return '답장에 채우지 않은 자리({{ }})가 남아 있습니다.';
  // 전화번호, 인터넷 주소, 카카오톡·이메일 같은 연락처: 숨고 약관(우회 거래 유도) 때문에 보내지 않는다
  if (/\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}|https?:\/\/|www\.|카톡|카카오|kakao|@/i.test(text)) return '답장에 연락처로 보이는 내용이 있습니다.';
  // 금액: 첫 응대에서는 금액을 말하지 않는다 (예: 30만원, 150,000원)
  if (/\d[\d,]*\s*(만\s*)?원/.test(text)) return '답장에 금액이 들어 있습니다.';
  return '';
}

// 채팅 첫 응대의 결과를 카톡으로 알린다: 보냄 / 써 둠 / 보내지 않은 사유
async function notifyChatOutcome(inq) {
  const a = inq.autoSend;
  const outcome = a.sent ? '첫 응대를 보냈습니다.' : a.prepared ? a.reason : `보내지 않았습니다: ${a.reason}`;
  await kakao.notify(`[숨고 채팅] ${inq.title}\n${outcome}`, `/#/i/${inq.id}`);
}

// 첫 응대를 보내지 않기로 하고 그 사유를 문의에 남긴다
function skipChat(inq, reason) {
  const at = new Date().toISOString();
  inq.autoSend = { sent: false, reason, at };
  inq.log.push({ at, action: '자동 응대 안 함', detail: reason });
}

// AI가 쓴 첫 응대를 보내면 안 되는 사유. 보내도 되면 빈 글
function chatSkipReason(result) {
  // AI가 보내지 않는 게 좋다고 본 경우 (이미 대화 중, 업무가 아닌 요청 등)
  if (!result.send) return result.skip_reason || 'AI가 보내지 않는 것이 좋다고 판단했습니다.';
  // 답장에 연락처·금액 같은 것이 들어 있으면 보내지 않는다
  const problem = replyProblem(result.reply);
  return problem ? `${problem} 내용을 확인한 뒤 직접 보내주세요.` : '';
}

// PC 크롬 확장이 가져온 채팅방: 보내도 되는 답장이면 확장이 가져가 설정한 방식대로 써 넣도록 남겨 두고(extTask), 아니면 사유를 남긴다
function planExtReply(inq, result) {
  const reason = chatSkipReason(result);
  if (reason) return skipChat(inq, reason);
  inq.extTask = { mode: settings.chatMode, reply: result.reply.trim(), at: new Date().toISOString() };
}

// 설정한 방식대로 채팅방에 답장을 보내거나 써 둔다. 한 채팅방에 한 번만 시도하고, 보내지 않았으면 그 사유를 남긴다.
async function chatAutoReply(inq, result) {
  const at = new Date().toISOString();
  const skip = (reason) => skipChat(inq, reason);
  const reason = chatSkipReason(result);
  if (reason) return skip(reason);
  // 그 사이 숨고에 다른 계정으로 로그인했으면 보내지 않는다
  if (soomgo.chatStatus.account !== inq.account) return skip('숨고에 로그인한 계정이 바뀌어 보내지 않았습니다.');
  const reply = result.reply.trim();
  // 써 두기만 하는 방식: 노트북의 숨고 창에 새 탭을 열어 채팅창에 써 둔다
  if (settings.chatMode === 'fill') {
    try {
      await soomgo.prepareChat(inq.chatId, reply);
    } catch (e) {
      return skip(`숨고 채팅창에 써 두지 못했습니다. ${e.message.split('\n')[0]}`);
    }
    inq.autoSend = { sent: false, prepared: true, reason: '숨고 채팅창에 답장을 써 두었습니다. 확인하고 전송을 눌러주세요.', at };
    inq.log.push({ at, action: '숨고 채팅창에 답장을 써 둠' });
    return;
  }
  // 자동으로 보내는 방식
  try {
    await soomgo.sendChat(inq.chatId, reply);
  } catch (e) {
    console.error(`[숨고 채팅] 자동 응대 실패 ${inq.id}: ${e.message.split('\n')[0]}`);
    return skip(`보내지 못했습니다. ${e.message.split('\n')[0]}`);
  }
  // 보낸 것으로 기록한다: 보낸 답장, 대화 기록, 상태는 '전송 완료'
  inq.autoSend = { sent: true, at };
  inq.finalReply = inq.draftReply = reply;
  inq.messages.push({ at, from: 'owner', text: reply, images: [] });
  inq.status = 'sent';
  inq.log.push({ at, action: '숨고 채팅에 첫 응대를 자동으로 보냄' });
}

// 새 문의를 만든다: 번호를 정하고, 사진을 저장하고, 문의 파일을 만든 뒤 분석 줄에 세운다.
// 숨고 채팅방에서 온 것(chatId)이면 채팅방 화면 글과 그때 로그인한 계정 번호(account)를 함께 저장한다. PC 크롬 확장이 가져온 것은 source가 'ext'다
async function createInquiry({ text, images, soomgoId = null, chatId = null, account = null, source = 'soomgo' }) {
  // 날짜·시각으로 된 새 문의 번호
  const id = store.newId();
  // 올라온 사진을 문의 폴더에 저장하고 파일 이름을 받는다
  const files = await store.saveImages(id, images);
  const now = new Date().toISOString();
  // 문의의 처음 모습을 저장한다: 상태는 '분석 중', 첫 글은 고객 문의(채팅방이면 채팅방 화면 글)
  await store.save({
    id, createdAt: now, status: 'analyzing', source, soomgoId, kind: chatId ? 'chat' : 'quote', chatId, account,
    title: chatId ? '숨고 새 채팅방' : soomgoId ? '숨고 새 요청서' : text.slice(0, 30) || '새 문의',
    messages: [{ at: now, from: chatId ? 'room' : 'customer', text, images: files }],
    analysis: null, estimateInputs: null, draftReply: '', finalReply: null, finalPrice: null, error: null,
    booking: { date: null, note: null },
    log: [{ at: now, action: chatId ? '숨고 새 채팅방에서 자동 등록' : soomgoId ? '숨고에서 자동 등록' : '문의 등록' }],
  });
  // 분석 줄에 세우고, 문의 번호를 돌려준다
  enqueueAnalysis(id);
  return id;
}

// ---------- PC 크롬 확장이 본 채팅방 ----------
// 계정마다 이미 본 채팅방 번호 ({ 계정 번호: [채팅방 번호, ...] }). 노트북에서 켤 때 lib/soomgo.js가 쓰는 것과 같은 파일이다
const CHATS_SEEN_FILE = path.join(store.DATA_DIR, 'soomgo_chats_seen.json');
// 한 번에 하나씩 처리하려고 줄을 세운다 (PC 두 대가 동시에 물어도 같은 채팅방을 두 번 넘기지 않게)
let claiming = Promise.resolve();
// 확장이 읽은 채팅 목록(위가 최근)에서 처음 보는 채팅방을 위에서 3개까지 골라, 넘기기 전에 본 것으로 적어 두고 오래된 것부터 돌려준다.
// 그 계정을 처음 보면 지금 있는 채팅방을 모두 본 것으로 적고 아무것도 넘기지 않는다(예전 채팅방에는 답하지 않는다).
// 목록을 제대로 읽지 못했으면(채팅방이 있다는데 번호가 없음) 기록하지 않는다. 빈 목록을 기록하면 나중에 예전 채팅방에 모두 답하게 된다
function claimChats(account, ids, count) {
  const run = async () => {
    if (!/^\d{1,20}$/.test(account)) throw Object.assign(new Error('숨고 계정 번호가 올바르지 않습니다.'), { status: 400 });
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 500);
    if (!Number.isInteger(count) || count < 0 || (count > 0 && !list.length)) throw Object.assign(new Error('채팅 목록을 제대로 읽지 못했습니다.'), { status: 400 });
    let all = {};
    try {
      all = JSON.parse(await readFile(CHATS_SEEN_FILE, 'utf8'));
    } catch {
      // 처음이면 빈 기록에서 시작한다
    }
    const first = !all[account];
    const seen = all[account] || [...list];
    const fresh = first ? [] : list.filter((x) => !seen.includes(x)).slice(0, 3);
    seen.push(...fresh);
    all[account] = seen.slice(-2000);
    await writeFile(CHATS_SEEN_FILE, JSON.stringify(all));
    if (first) console.log(`[숨고 채팅] 계정 ${account}을 처음 확인했습니다. 지금 있는 채팅방 ${list.length}개는 응대하지 않습니다.`);
    return fresh.reverse();
  };
  const job = claiming.then(run);
  claiming = job.catch(() => {});
  return job;
}

// 확장이 첫 응대를 가져가 놓고 10분 넘게 결과를 알리지 않으면(그 사이 PC 크롬이 꺼짐 등) 보내지 않은 것으로 남기고 알린다. 5분마다 본다
if (EXT_RUNNER) {
  setInterval(async () => {
    for (const inq of await store.list().catch(() => [])) {
      if (!inq.extTask || inq.autoSend || Date.now() - new Date(inq.extTask.at) < 10 * 60 * 1000) continue;
      skipChat(inq, 'PC 크롬이 답장을 써 넣지 못했습니다. 문의의 답장을 복사해 숨고에서 직접 보내 주세요.');
      await store.save(inq);
      await notifyChatOutcome(inq);
    }
  }, 5 * 60 * 1000);
}

// ---------- HTTP 도우미 ----------
// 파일 종류별로 브라우저에 알려줄 형식 이름
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

// 브라우저에 답을 보낸다. 내용이 자료(객체)면 JSON으로, 글자면 그대로 보낸다. 브라우저가 옛 답을 저장해 두고 다시 쓰지 않게 한다
function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

// 브라우저가 보낸 내용을 끝까지 받아 자료로 바꾼다. 정해 둔 크기(기본 40MB)를 넘으면 받지 않는다
function readJson(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // 조각조각 나뉘어 오는 내용을 모아 둘 곳과, 지금까지 받은 크기
    const chunks = [];
    let size = 0;
    // 조각이 올 때마다 크기를 더해 보고, 한도를 넘으면 끊는다
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('사진 용량이 너무 큽니다.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    // 다 받았으면 조각을 이어 붙여 자료로 바꾼다. 형식이 틀리면 오류로 알린다
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

// 로그인한 브라우저인지 확인한다. 브라우저가 가진 표(쿠키)가 서버의 값과 같아야 한다
function authed(req) {
  // 쿠키에서 ssak=... 값을 찾는다
  const m = /(?:^|;\s*)ssak=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  // 비교에 걸린 시간으로 값을 짐작하지 못하도록, 항상 같은 시간이 걸리는 방법으로 비교한다
  return Boolean(m) && timingSafeEqual(Buffer.from(m[1]), Buffer.from(SESSION));
}

// 비밀번호를 틀린 횟수. 접속한 주소별(loginFails)과 전체(allFails)로 따로 센다
const loginFails = new Map();
const allFails = { n: 0, since: 0, until: 0 };

// 파일 하나를 읽어 브라우저에 보낸다. 없으면 '찾을 수 없습니다'.
// 영상은 브라우저가 일부분만 달라고 하면(Range) 그 부분만 보낸다 (아이폰 사파리는 이렇게 받아야 재생한다)
async function serveFile(res, file, req = null) {
  let body;
  try {
    body = await readFile(file);
  } catch {
    return send(res, 404, '찾을 수 없습니다.');
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const range = type.startsWith('video/') && /^bytes=(\d*)-(\d*)$/.exec(req?.headers.range || '');
  if (!range) return send(res, 200, body, { 'Content-Type': type, ...(type.startsWith('video/') ? { 'Accept-Ranges': 'bytes' } : {}) });
  const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  if (start > end || start >= body.length) return send(res, 416, '', { 'Content-Range': `bytes */${body.length}` });
  send(res, 206, body.subarray(start, end + 1), { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` });
}

// 화면에서 바꿀 수 있는 문의 상태: 승인 대기, 전송 완료, 보류, 거절, 예약 확정
const STATUSES = ['awaiting_owner', 'sent', 'on_hold', 'rejected', 'booked'];

// ---------- 라우팅 ----------
// 브라우저의 요청 하나를 받아, 주소와 방식(GET은 가져오기, POST는 보내기)에 따라 알맞은 일을 한다
async function handle(req, res) {
  // 요청 주소에서 경로만 떼어 낸다 (예: /api/inquiries)
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  // --- 로그인: 비밀번호가 맞으면 표(쿠키)를 준다 ---
  if (method === 'POST' && p === '/api/login') {
    // 터널을 거치면 접속자 주소가 모두 같게 보이므로 Cloudflare나 Tailscale이 알려주는 주소를 쓰고, 전체 실패 횟수도 함께 제한한다
    const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    // 이 주소가 지금까지 틀린 횟수. 잠겨 있는 동안에는 비밀번호를 보지도 않고 돌려보낸다
    const fail = loginFails.get(ip) || { n: 0, until: 0 };
    if (now < fail.until || now < allFails.until) return send(res, 429, { error: '잠시 후 다시 시도해주세요.' });
    const { pin } = await readJson(req, 1024);
    // 비밀번호가 틀렸을 때
    if (String(pin) !== PIN) {
      // 같은 주소에서 5번 틀리면 5분 동안 잠근다
      fail.n += 1;
      if (fail.n >= 5) Object.assign(fail, { n: 0, until: now + 5 * 60 * 1000 });
      loginFails.set(ip, fail);
      // 기록이 너무 많이 쌓이면 비운다
      if (loginFails.size > 1000) loginFails.clear();
      // 누가 틀렸든 5분 안에 모두 합쳐 20번 틀리면 전체를 5분 동안 잠근다
      if (now - allFails.since > 5 * 60 * 1000) Object.assign(allFails, { n: 0, since: now });
      allFails.n += 1;
      if (allFails.n >= 20) Object.assign(allFails, { n: 0, since: now, until: now + 5 * 60 * 1000 });
      return send(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }
    // 비밀번호가 맞았을 때: 틀린 기록을 지우고, 90일 동안 유지되는 표(쿠키)를 준다. https로 접속했으면 https에서만 쓰게 한다
    loginFails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `ssak=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}` });
  }

  // 화면 파일은 로그인 없이 내려준다. 고객 정보는 모두 /api 뒤에 있다.
  if (method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/kakao/')) {
    // 주소가 / 이면 첫 화면 파일을, 아니면 그 이름의 파일을 public 폴더에서 찾는다
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(ROOT, 'public', rel);
    // public 폴더 밖의 파일을 달라는 요청은 거절한다
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 404, '찾을 수 없습니다.');
    return serveFile(res, file, req);
  }

  // 여기부터는 로그인한 사람만 쓸 수 있다
  if (!authed(req)) return send(res, 401, { error: '로그인이 필요합니다.' });

  // --- 카카오톡 알림 연결: 카카오 동의 화면으로 보낸다 ---
  if (method === 'GET' && p === '/kakao/login') {
    if (!kakao.kakaoConfigured()) return send(res, 400, '.env 파일에 KAKAO_REST_KEY를 먼저 넣어주세요.');
    res.writeHead(302, { Location: kakao.authorizeUrl() });
    return res.end();
  }
  // --- 카카오 동의가 끝나면 카카오가 이 주소로 돌려보낸다. 받은 코드를 토큰으로 바꿔 저장하고 첫 화면으로 보낸다 ---
  if (method === 'GET' && p === '/kakao/callback') {
    const code = url.searchParams.get('code');
    if (!code) return send(res, 400, `카카오 연결 실패: ${url.searchParams.get('error_description') || '코드 없음'}`);
    await kakao.exchangeCode(code);
    await kakao.notify('[싹다클린] 카카오톡 알림이 연결되었습니다.');
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // --- 화면이 처음 열릴 때 필요한 것: 단가 설정, 스위치 상태, 카카오 알림 연결 여부 ---
  if (method === 'GET' && p === '/api/state') {
    return send(res, 200, { config: cfg, ...featureState(), kakao: { configured: kakao.kakaoConfigured(), connected: await kakao.kakaoConnected() } });
  }

  // --- 설정 화면에서 스위치나 값을 바꿨을 때 ---
  if (method === 'POST' && p === '/api/settings') {
    await applySettings(await readJson(req, 1024));
    return send(res, 200, featureState());
  }

  // --- 카톡 일감 잡기: 이 컴퓨터 카카오톡의 채팅방 목록. 읽지 못하면 빈 목록과 사유를 준다 ---
  if (method === 'GET' && p === '/api/talk/rooms') {
    // 서버에서는 PC 도우미가 알려 준 방 목록을 준다
    if (SERVER_MODE) {
      const live = talkAgent.seenAt && Date.now() - new Date(talkAgent.seenAt) < 60 * 1000;
      return send(res, 200, { rooms: live ? talkAgent.rooms : [], note: live ? talkAgent.roomsNote : 'PC의 카톡 일감 도우미가 켜져 있지 않아 방 목록을 불러오지 못했습니다.' });
    }
    try {
      return send(res, 200, { rooms: await kakaotalk.rooms() });
    } catch (e) {
      return send(res, 200, { rooms: [], note: e.message });
    }
  }

  // --- PC 카톡 일감 도우미 (서버에서만) ---
  // 도우미가 몇 초마다 지금 상태와 방 목록을 알려 주고, 켜 두었는지와 방·찾을 말·보낼 글·보낼 곳을 받아 간다
  if (SERVER_MODE && method === 'POST' && p === '/api/talk/agent') {
    const b = await readJson(req, 65536);
    const text = (v, n) => String(v ?? '').slice(0, n);
    const events = (Array.isArray(b.events) ? b.events : []).slice(0, 10).map((e) => ({
      at: text(e?.at, 40), text: text(e?.text, 80), sent: Boolean(e?.sent), note: text(e?.note, 300), to: text(e?.to, 100), ms: Number(e?.ms) || 0,
    }));
    const rooms = Array.isArray(b.rooms)
      ? b.rooms.slice(0, 100).map((r) => ({ name: text(r?.name, 100), members: Number.isInteger(r?.members) ? r.members : null, open: Boolean(r?.open) })).filter((r) => r.name)
      : talkAgent.rooms;
    talkAgent = {
      state: ['off', 'starting', 'ok', 'error'].includes(b.state) ? b.state : 'error',
      message: text(b.message, 300), lastCheck: b.lastCheck ? text(b.lastCheck, 40) : null, events, rooms,
      roomsNote: typeof b.roomsNote === 'string' ? text(b.roomsNote, 300) : talkAgent.roomsNote, seenAt: new Date().toISOString(),
    };
    return send(res, 200, { kakaoWatch: settings.kakaoWatch, talk: settings.talk });
  }

  // --- PC 크롬 확장 (서버에서만) ---
  // 확장이 1분마다 지금 상태를 알려 주고, 채팅 자동 응대를 켜 두었는지와 답장 방식을 받아 간다. 숨고 로그인이 풀렸으면 카톡으로 한 번 알린다
  if (EXT_RUNNER && method === 'POST' && p === '/api/ext/status') {
    const b = await readJson(req, 16384);
    const text = (v, n) => String(v ?? '').slice(0, n);
    const next = {
      state: ['off', 'starting', 'login', 'ok', 'error'].includes(b.state) ? b.state : 'error',
      message: text(b.message, 300), work: text(b.work, 200), account: /^\d{1,20}$/.test(b.account) ? b.account : null,
      lastCheck: b.lastCheck ? text(b.lastCheck, 40) : null, lastNew: b.lastNew ? text(b.lastNew, 40) : null, seenAt: new Date().toISOString(),
    };
    if (next.state === 'login' && extStatus.state !== 'login') kakao.notify('[숨고 채팅] 숨고 로그인이 필요합니다. PC 크롬에 열린 숨고 창에서 로그인해 주세요.');
    extStatus = next;
    return send(res, 200, { chat: settings.chat, chatMode: settings.chatMode });
  }
  // 확장이 읽은 채팅 목록을 받아, 처음 보는 채팅방을 본 것으로 적고 돌려준다
  if (EXT_RUNNER && method === 'POST' && p === '/api/ext/claim') {
    const b = await readJson(req, 65536);
    return send(res, 200, { fresh: await claimChats(String(b.account ?? ''), b.ids, b.count) });
  }
  // 확장이 연 새 채팅방의 글과 사진을 받아 문의로 등록한다. AI가 첫 응대를 쓰면 확장이 문의를 다시 읽어 가져간다
  if (EXT_RUNNER && method === 'POST' && p === '/api/ext/room') {
    const b = await readJson(req);
    const chatId = String(b.chatId ?? '');
    const account = String(b.account ?? '');
    if (!/^[\w-]{1,64}$/.test(chatId) || !/^\d{1,20}$/.test(account)) return send(res, 400, { error: '채팅방 번호나 계정 번호가 올바르지 않습니다.' });
    if (!settings.chat) return send(res, 409, { error: '채팅 자동 응대가 꺼져 있습니다.' });
    const text = `[숨고 채팅방 화면]\n${String(b.text || '').trim()}`.slice(0, 12000);
    // 사진은 JPG·PNG·WEBP 글자 형태만 받는다 (이상한 것이 섞여도 채팅방 등록은 계속한다)
    const images = (Array.isArray(b.images) ? b.images : []).filter((u) => /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, 6);
    return send(res, 201, { id: await createInquiry({ text, images, chatId, account, source: 'ext' }) });
  }
  // 확장이 새 채팅방을 열었지만 읽지 못했을 때: 첫 화면 '처리할 문의'에 보이도록 실패한 문의로 남기고 카톡으로 알린다 (AI는 돌리지 않는다)
  if (EXT_RUNNER && method === 'POST' && p === '/api/ext/failed') {
    const b = await readJson(req, 16384);
    const chatId = String(b.chatId ?? '');
    const account = String(b.account ?? '');
    if (!/^[\w-]{1,64}$/.test(chatId) || !/^\d{1,20}$/.test(account)) return send(res, 400, { error: '채팅방 번호나 계정 번호가 올바르지 않습니다.' });
    const detail = String(b.error || '').slice(0, 200);
    const reason = `새 채팅방을 읽지 못해 응대하지 못했습니다. 숨고에서 직접 확인해 주세요.${detail ? ` (${detail})` : ''}`;
    const id = store.newId();
    const at = new Date().toISOString();
    await store.save({
      id, createdAt: at, status: 'error', source: 'ext', soomgoId: null, kind: 'chat', chatId, account, title: '숨고 새 채팅방 (읽지 못함)',
      messages: [], analysis: null, estimateInputs: null, draftReply: '', finalReply: null, finalPrice: null, error: reason,
      booking: { date: null, note: null }, autoSend: { sent: false, reason, at }, log: [{ at, action: '숨고 새 채팅방을 읽지 못함', detail }],
    });
    await kakao.notify(`[숨고 채팅] ${reason}`, `/#/i/${id}`);
    return send(res, 201, { id });
  }
  // 확장이 숨고 화면에서 할 일(목록 읽기·채팅방 읽기·써 넣기·전송)의 최신 코드. 확장이 일할 때마다 받아 가므로,
  // 숨고 화면이 바뀌어 이 파일을 고치면 서버에 올리기만 해도 사장님 PC에 바로 적용된다(확장을 다시 깔지 않는다)
  if (EXT_RUNNER && method === 'GET' && p === '/api/ext/page.js') {
    return send(res, 200, await readFile(path.join(ROOT, 'extension', 'page.js'), 'utf8'), { 'Content-Type': 'text/javascript; charset=utf-8' });
  }
  // 확장 파일 내려받기 (PC 크롬에 설치할 때). extension 폴더를 압축해서 바로 보낸다
  if (EXT_RUNNER && method === 'GET' && p === '/api/extension.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ssakda-extension.zip"', 'Cache-Control': 'no-store' });
    const zip = spawn('zip', ['-r', '-q', '-X', '-', '.', '-x', '.*'], { cwd: path.join(ROOT, 'extension') });
    zip.stdout.pipe(res);
    zip.on('error', () => res.end());
    return;
  }

  // --- 프로그램 끄기: 먼저 답을 보내고 0.3초 뒤에 끈다. 서버에서는 끄지 않는다(꺼도 저절로 다시 켜진다) ---
  if (method === 'POST' && p === '/api/shutdown') {
    if (SERVER_MODE) return send(res, 400, { error: '서버에서 도는 비서는 여기서 끌 수 없습니다.' });
    send(res, 200, { ok: true });
    setTimeout(shutdown, 300);
    return;
  }

  // --- 문의 목록: 목록 화면에 필요한 항목만 추려서 보낸다 ---
  if (method === 'GET' && p === '/api/inquiries') {
    const all = await store.list();
    return send(res, 200, all.map((i) => ({ id: i.id, kind: i.kind || 'quote', title: i.title, status: i.status, updatedAt: i.updatedAt, risk: i.analysis?.risk_level || null, region: i.analysis?.region || null, autoSend: i.autoSend || null })));
  }

  // --- 새 문의 등록: 글이나 사진이 하나는 있어야 한다 ---
  if (method === 'POST' && p === '/api/inquiries') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text && !(body.images || []).length) return send(res, 400, { error: '숨고 캡처나 문의 내용을 넣어주세요.' });
    return send(res, 201, { id: await createInquiry({ text, images: body.images }) });
  }

  // --- 여기부터는 문의 한 건에 대한 요청: /api/inquiries/문의번호/할일/추가값 ---
  const m = /^\/api\/inquiries\/([0-9a-f-]+)(?:\/([a-z]+)(?:\/([\w.-]+))?)?$/.exec(p);
  if (!m) return send(res, 404, { error: '찾을 수 없습니다.' });
  const [, id, action, arg] = m;
  // 그 번호의 문의를 읽는다. 없으면 '찾을 수 없습니다'
  let inq;
  try {
    inq = await store.load(id);
  } catch {
    return send(res, 404, { error: '문의를 찾을 수 없습니다.' });
  }
  // 이 문의의 처리 기록에 한 줄을 남기는 작은 함수
  const log = (a, detail) => inq.log.push({ at: new Date().toISOString(), action: a, ...(detail ? { detail } : {}) });

  // 문의 한 건의 전체 내용 보기
  if (method === 'GET' && !action) return send(res, 200, inq);

  // 문의에 붙은 사진 보기. 정해진 모양의 파일 이름만 받는다
  if (method === 'GET' && action === 'photo' && arg) {
    if (!/^photo-[\w-]+\.(jpg|png|webp)$/.test(arg)) return send(res, 404, '찾을 수 없습니다.');
    return serveFile(res, path.join(store.inquiryDir(id), arg));
  }

  // 아래는 모두 무언가를 바꾸는 요청이라 POST만 받는다
  if (method !== 'POST') return send(res, 405, { error: '허용되지 않는 요청입니다.' });
  const body = await readJson(req);

  // 고객이 추가로 보낸 답장·사진을 붙이고 다시 분석한다 (재견적)
  if (action === 'messages') {
    const text = String(body.text || '').trim();
    if (!text && !(body.images || []).length) return send(res, 400, { error: '내용이나 사진을 넣어주세요.' });
    const images = await store.saveImages(id, body.images);
    inq.messages.push({ at: new Date().toISOString(), from: body.from === 'owner' ? 'owner' : 'customer', text, images });
    // 상태를 '분석 중'으로 바꾸고 다시 분석 줄에 세운다
    inq.status = 'analyzing';
    log('추가 내용 등록, 재분석');
    await store.save(inq);
    enqueueAnalysis(id);
    return send(res, 200, inq);
  }

  // 같은 내용으로 다시 분석하기
  if (action === 'reanalyze') {
    inq.status = 'analyzing';
    log('재분석 요청');
    await store.save(inq);
    enqueueAnalysis(id);
    return send(res, 200, inq);
  }

  // PC 크롬 확장이 첫 응대를 써 넣거나 보낸 결과. 채팅방마다 한 번만 받는다
  if (action === 'typed') {
    if (!inq.extTask || inq.autoSend) return send(res, 409, { error: '이미 처리한 채팅방입니다.' });
    const at = new Date().toISOString();
    const { reply } = inq.extTask;
    if (body.sent) {
      inq.autoSend = { sent: true, at };
      inq.finalReply = inq.draftReply = reply;
      inq.messages.push({ at, from: 'owner', text: reply, images: [] });
      inq.status = 'sent';
      log('숨고 채팅에 첫 응대를 자동으로 보냄 (PC 크롬)');
    } else if (body.prepared) {
      inq.autoSend = { sent: false, prepared: true, reason: body.note ? String(body.note).slice(0, 200) : '숨고 채팅창에 답장을 써 두었습니다. PC 크롬의 숨고 창에서 확인하고 전송을 눌러주세요.', at };
      log('숨고 채팅창에 답장을 써 둠 (PC 크롬)', body.diag ? String(body.diag).slice(0, 3000) : undefined);
    } else {
      skipChat(inq, `보내지 못했습니다. ${String(body.error || '').slice(0, 200)}`.trim());
    }
    if (body.diag && !body.prepared) log('확장 기록', String(body.diag).slice(0, 3000));
    await store.save(inq);
    await notifyChatOutcome(inq);
    return send(res, 200, { ok: true });
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
    // 답변이 비었거나 {{견적}} 자리가 남아 있으면 승인하지 않는다
    const reply = String(body.reply || '').trim();
    if (!reply) return send(res, 400, { error: '보낼 답변이 비어 있습니다.' });
    if (reply.includes('{{견적}}')) return send(res, 400, { error: '답변에 {{견적}} 자리가 남아 있습니다. 금액을 넣어주세요.' });
    // 최종 답변과 금액을 기록하고, 대화 기록에 사장님 답변으로 넣고, 상태를 '전송 완료'로 바꾼다
    inq.finalReply = reply;
    inq.draftReply = reply;
    inq.finalPrice = body.price ?? null;
    if (body.estimateInputs) inq.estimateInputs = body.estimateInputs;
    inq.messages.push({ at: new Date().toISOString(), from: 'owner', text: reply, images: [] });
    inq.status = 'sent';
    log('승인 후 복사', body.price ? `안내 금액: ${body.price}` : undefined);
    // PC 크롬 확장이 아직 써 넣기 전이면, 사장님이 직접 보낸 것으로 정해 확장이 또 보내지 않게 한다
    if (inq.extTask && !inq.autoSend) inq.autoSend = { sent: false, reason: '사장님이 직접 보냈습니다.', at: new Date().toISOString() };
    await store.save(inq);
    return send(res, 200, inq);
  }

  // 상태 바꾸기: 예약 확정, 보류, 거절 등. 예약 확정이면 예약일과 메모도 저장한다
  if (action === 'status') {
    if (!STATUSES.includes(body.status)) return send(res, 400, { error: '알 수 없는 상태입니다.' });
    inq.status = body.status;
    if (body.status === 'booked') inq.booking = { date: body.date || null, note: body.note || null };
    log(`상태 변경: ${body.status}`, body.note || body.date || undefined);
    await store.save(inq);
    return send(res, 200, inq);
  }

  // 위의 어느 것에도 해당하지 않는 요청
  return send(res, 404, { error: '찾을 수 없습니다.' });
}

// 웹 서버를 만든다. 요청을 처리하다 오류가 나도 프로그램이 죽지 않게 오류 답을 보낸다
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    // 일부러 낸 오류(크기 초과 등)는 그 문구를 그대로 보여주고, 예상하지 못한 오류는 기록한 뒤 일반 문구를 보여준다
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '서버 오류가 발생했습니다.' });
  });
});

// 프로그램이 꺼질 때 분석 중이던 문의는 다시 대기열에 넣는다
for (const inq of await store.list()) if (inq.status === 'analyzing') enqueueAnalysis(inq.id);

// ---------- 켜고 끌 수 있는 기능 (설정 화면의 스위치) ----------
// 스위치 상태를 적어 두는 파일. 컴퓨터마다 따로 있다
const SETTINGS_FILE = path.join(store.DATA_DIR, 'settings.json');
let settings;
// 저장된 설정을 읽는다. 없으면 기본값으로 시작한다
try {
  settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  settings = { tunnel: process.env.TUNNEL === '1', soomgo: process.env.SOOMGO_WATCH === '1' };
}
// 숨고 답변 보내는 방식: off(승인 후 직접 복사), fill(숨고 창에 써 두고 멈춤), send(확인 없이 발송)
// 값이 이상하면 '직접 보내기'로 둔다. 예전 방식의 설정(autoSend)이 남아 있으면 새 방식으로 옮긴다
if (!['off', 'fill', 'send'].includes(settings.quoteMode)) settings.quoteMode = settings.autoSend ? 'send' : 'off';
delete settings.autoSend;
// 카카오톡 채팅방 지켜보기: 방 이름, 찾을 말, 보낼 글
// 문의를 분석할 AI: codex(ChatGPT 구독) 또는 claude(Claude 구독)
if (!(settings.ai in PROVIDERS)) settings.ai = 'codex';
// 숨고 채팅 자동 응대 스위치와 답장 방식: send(바로 보냄), fill(채팅창에 써 두고 멈춤)
settings.chat = Boolean(settings.chat);
if (!['send', 'fill'].includes(settings.chatMode)) settings.chatMode = 'fill';
// 카톡 일감 잡기 스위치와 기본값(찾을 말, 보낼 글, 보낼 곳). 저장된 값이 있으면 그 값이 우선이다
settings.kakaoWatch = Boolean(settings.kakaoWatch);
settings.talk = { room: '', keyword: '[방문견적]', message: '안녕하세요, 방문견적 가능합니다.', target: 'direct', ...settings.talk };
// 외부 접속의 지금 상태: 실행 중인 프로그램, 만들어진 주소, 켜 두기를 원하는지, 화면에 보여줄 안내
const tunnel = { child: null, url: null, wanted: false, note: '' };

// Tailscale이 설치돼 있으면 그 실행 파일을 돌려준다. 맥 앱은 실행 경로에 넣어 주지 않아서 앱 안의 것을 직접 찾는다.
function tailscaleBin() {
  // 먼저 맥과 윈도우의 정해진 설치 위치를 본다
  const known = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'].find((f) => existsSync(f));
  if (known) return known;
  // 없으면 그냥 tailscale 명령이 실행되는지 본다. 안 되면 없는 것으로 친다
  try {
    execFileSync('tailscale', ['version'], { stdio: 'ignore' });
    return 'tailscale';
  } catch {
    return null;
  }
}

// 외부 접속 주소가 정해졌을 때: 기억해 두고, 파일에 적고, 전과 달라졌으면 카톡으로 알린다
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

// 외부 접속용 https 주소를 만든다. 아래 순서로 고른다.
// 1) .env에 TUNNEL_NAME과 TUNNEL_HOSTNAME이 있으면 내 도메인에 연결한 Cloudflare 터널 (주소 고정)
// 2) Tailscale이 설치돼 있으면 Tailscale Funnel (주소 고정)
// 3) 둘 다 없으면 켤 때마다 주소가 바뀌는 Cloudflare 임시 터널
function startTunnel() {
  // 켜 두기를 원한다고 표시한다. 이미 돌고 있으면 또 켜지 않는다
  tunnel.wanted = true;
  if (tunnel.child) return;
  // 내 도메인을 쓸지(.env에 터널 이름과 주소가 있는지), 아니면 Tailscale이 있는지 확인한다
  const { TUNNEL_NAME: named, TUNNEL_HOSTNAME: host } = process.env;
  const own = Boolean(named && host);
  const ts = own ? null : tailscaleBin();
  const local = `http://localhost:${PORT}`;
  // 고른 방식에 맞는 프로그램을 실행한다
  const child = own
    ? spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--url', local, named], { stdio: ['ignore', 'pipe', 'pipe'] })
    : ts
      ? spawn(ts, ['funnel', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel.child = child;
  // 그 프로그램이 내놓는 글을 읽어 주소나 문제를 알아낸다
  let lastLine = '';
  const onOutput = (d) => {
    const text = String(d);
    lastLine = text.trim().split('\n').pop() || lastLine;
    // 내 도메인 터널은 주소를 이미 알고 있으므로, 연결됐다는 기록이 나오면 그 주소를 쓴다
    const url = own ? /Registered tunnel connection/.test(text) && [`https://${host}`] : /https:\/\/[a-z0-9.-]+\.(?:ts\.net|trycloudflare\.com)/.exec(text);
    if (url && !tunnel.url) return publishUrl(url[0]).catch((e) => console.error(e));
    // Tailscale이 아직 준비되지 않았으면 무엇을 해야 하는지 설정 화면에 보여준다
    const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
    if (enable) tunnel.note = `Tailscale에서 외부 공개(Funnel)를 허용해야 합니다. 노트북에서 이 주소를 열어 허용해 주세요: ${enable[0]}`;
    else if (ts && /logged out|not logged in|needslogin|stopped|not running|failed to connect/i.test(text)) tunnel.note = 'Tailscale이 꺼져 있거나 로그인되어 있지 않습니다. 노트북에서 Tailscale을 열어 로그인해 주세요.';
  };
  // 프로그램의 일반 출력과 오류 출력을 모두 읽는다
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  // 프로그램을 실행조차 못 했을 때 (설치돼 있지 않은 경우)
  child.on('error', (e) => {
    tunnel.note = `외부 접속 프로그램(${ts ? 'Tailscale' : 'cloudflared'})을 실행하지 못했습니다. 설치되어 있는지 확인해 주세요.`;
    console.error('[외부 접속 실패]', e.message);
  });
  // 프로그램이 끝났을 때: 꺼 달라고 한 것이 아니면 10초 뒤 다시 켠다
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

// 외부 접속을 끈다
function stopTunnel() {
  tunnel.wanted = false;
  tunnel.note = '';
  tunnel.child?.kill();
}

// 숨고 확인을 시작한다. 새 요청서가 오면 문의로 등록하고, 알릴 일이 생기면 카톡으로 보낸다. 시작하지 못하면 사유를 화면에 보여준다
function startSoomgo() {
  soomgo.startWatcher({ onNew: createInquiry, onAlert: (t) => kakao.notify(t) }).catch((e) => {
    soomgo.status.state = 'error';
    soomgo.status.message = `숨고 확인을 시작하지 못했습니다: ${e.message.split('\n')[0]}`;
    console.error(`[숨고] ${soomgo.status.message}`);
  });
}

// 숨고 채팅 자동 응대를 시작한다. 새 채팅방이 생기면 문의로 등록하고, 알릴 일이 생기면 카톡으로 보낸다
function startChat() {
  soomgo.startChatWatcher({ onNew: createInquiry, onAlert: (t) => kakao.notify(t) }).catch((e) => {
    soomgo.chatStatus.state = 'error';
    soomgo.chatStatus.message = `숨고 채팅 확인을 시작하지 못했습니다: ${e.message.split('\n')[0]}`;
    console.error(`[숨고 채팅] ${soomgo.chatStatus.message}`);
  });
}

// 설정 화면에서 바꾼 값을 받아 바로 적용하고 파일에 저장한다
async function applySettings(next) {
  // 서버에서는 노트북 전용 설정(밖에서 접속하기)을 받지 않는다. 카톡 일감 잡기 설정은 저장만 하고 PC 도우미가 받아 간다
  if (SERVER_MODE) delete next.tunnel;
  // 밖에서 접속하기 스위치. 비밀번호가 8자리보다 짧으면 켜지 못하게 한다
  if (typeof next.tunnel === 'boolean' && next.tunnel !== settings.tunnel) {
    if (next.tunnel && PIN.length < 8) throw Object.assign(new Error('밖에서 접속하려면 접속 비밀번호가 8자리 이상이어야 합니다.'), { status: 400 });
    settings.tunnel = next.tunnel;
    next.tunnel ? startTunnel() : stopTunnel();
  }
  // 숨고 채팅 자동 응대 스위치와 답장 방식. 켜면 크롬 창을 열고, 끄면(받은 요청 확인도 꺼져 있으면) 닫는다
  if (typeof next.chat === 'boolean' && next.chat !== settings.chat) {
    settings.chat = next.chat;
    // 확장이 맡을 때는 스위치만 바꾼다 (확장이 1분 안에 받아 간다)
    if (!EXT_RUNNER) next.chat ? startChat() : await soomgo.stopChatWatcher();
  }
  if (['send', 'fill'].includes(next.chatMode)) settings.chatMode = next.chatMode;
  // 숨고 비서(받은 요청 확인) 스위치. 견적 기능을 끈 동안에는 바꾸지 않는다
  if (QUOTE_FEATURES && typeof next.soomgo === 'boolean' && next.soomgo !== settings.soomgo) {
    settings.soomgo = next.soomgo;
    next.soomgo ? startSoomgo() : await soomgo.stopWatcher();
  }
  // 숨고 답변 보내는 방식과 분석할 AI. 정해진 값 중 하나일 때만 바꾼다
  if (['off', 'fill', 'send'].includes(next.quoteMode)) settings.quoteMode = next.quoteMode;
  if (next.ai in PROVIDERS) settings.ai = next.ai;
  // 카톡 일감 잡기의 방 이름·찾을 말·보낼 글(300자까지)과 보낼 곳
  let talkChanged = false;
  if (next.talk && typeof next.talk === 'object') {
    for (const k of ['room', 'keyword', 'message']) {
      if (typeof next.talk[k] === 'string') settings.talk[k] = next.talk[k].trim().slice(0, 300);
    }
    if (['direct', 'room'].includes(next.talk.target)) settings.talk.target = next.talk.target;
    talkChanged = true;
  }
  // 카톡 일감 잡기 스위치
  if (typeof next.kakaoWatch === 'boolean' && next.kakaoWatch !== settings.kakaoWatch) {
    settings.kakaoWatch = next.kakaoWatch;
    talkChanged = true;
  }
  // 카톡 설정이 바뀌었으면 새 설정으로 다시 시작하거나 멈춘다 (서버에서는 PC 도우미가 몇 초 안에 받아 가서 한다)
  if (talkChanged && !SERVER_MODE) settings.kakaoWatch ? kakaotalk.start(settings.talk) : kakaotalk.stop();
  // 바뀐 설정을 파일에 저장한다
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// 크롬 웹스토어에 확장을 올렸으면 .env의 EXT_STORE_URL에 그 주소를 적는다. 그러면 안내 페이지가 '웹스토어에서 추가하기'로 바뀐다
// 서버에 있는 확장(extension 폴더)의 버전. 사장님 PC의 확장이 이와 다르면 화면에서 업데이트하라고 알린다
let extLatest = '';
try {
  extLatest = JSON.parse(readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
} catch {
  // 확장 폴더가 없으면 알리지 않는다
}
// 지금 돌고 있는 버전(마지막으로 받은 변경). 업데이트가 적용됐는지 설정 화면에서 확인하는 데 쓴다.
let version = '';
try {
  version = execFileSync('git', ['log', '-1', '--format=%h · %cd', '--date=format:%m-%d %H:%M'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // git이 없거나 내려받은 폴더가 아니면 표시하지 않는다
}
// 화면에 보여줄 지금 상태를 한데 모은다: 설정, 버전, 견적 기능을 보여줄지, 서버에서 도는지, 확장이 맡는지, 외부 접속 주소와 안내, 숨고 상태, 숨고 채팅 상태, 카톡 상태
// 확장이 맡을 때 숨고 채팅 상태는 확장이 알려 준 것이고, extRunner로 화면에 알린다
const featureState = () => ({ settings, version, quoteFeatures: QUOTE_FEATURES, serverMode: SERVER_MODE, extRunner: EXT_RUNNER, extLatest, extStore: process.env.EXT_STORE_URL || '', tunnelUrl: tunnel.url, tunnelNote: tunnel.note, soomgo: soomgo.status, chat: EXT_RUNNER ? extStatus : soomgo.chatStatus, talk: SERVER_MODE ? talkAgent : kakaotalk.status });

// 서버의 프로세스 번호를 적어 두는 파일. stop.sh가 이 번호로 프로그램을 끈다
const PID_FILE = path.join(store.DATA_DIR, 'server.pid');
// 끄는 중인지 표시한다 (두 번 끄지 않기 위해)
let closing = false;
// 프로그램을 끈다: 외부 접속, 카톡 지켜보기, 숨고 채팅·받은 요청 확인(크롬 창)을 차례로 멈추고 번호 파일을 지운 뒤 끝낸다
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('싹다클린 AI 비서를 끕니다.');
  stopTunnel();
  kakaotalk.stop();
  await soomgo.stopChatWatcher().catch(() => {});
  await soomgo.stopWatcher().catch(() => {});
  await unlink(PID_FILE).catch(() => {});
  process.exit(0);
}
// 터미널에서 Ctrl+C를 누르거나 stop.sh가 끄라는 신호를 보내면 위의 끄기를 실행한다
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

// 서버를 열지 못했을 때. 같은 포트를 이미 쓰고 있으면 '이미 켜져 있습니다'라고 알린다
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? '이미 켜져 있습니다.' : e.message);
  process.exit(1);
});

// 서버를 연다. 같은 와이파이의 휴대폰에서도 접속할 수 있게 모든 주소(0.0.0.0)에서 받는다.
// 서버에서는 터널로만 들어오게 HOST=127.0.0.1(이 컴퓨터 안에서만)로 연다
server.listen(PORT, process.env.HOST || '0.0.0.0', async () => {
  // data 폴더를 만들고 프로세스 번호를 적어 둔다
  await mkdir(store.DATA_DIR, { recursive: true });
  await writeFile(PID_FILE, String(process.pid));
  // 이 컴퓨터의 와이파이 주소를 찾아 접속 주소와 비밀번호를 터미널에 보여준다
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('싹다클린 AI 비서가 켜졌습니다.');
  // 서버에서는 이 글이 기록 파일에 남으므로 비밀번호를 적지 않는다
  if (SERVER_MODE) console.log(`  서버에서 실행 중: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  else {
    console.log(`  이 노트북:  http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  휴대폰:    http://${ip}:${PORT}`);
    console.log(`  접속 비밀번호: ${PIN}`);
  }
  // 지난번에 켜 두었던 기능들을 다시 켠다 (서버에서는 노트북 전용 기능을 빼고)
  if (settings.tunnel && PIN.length >= 8 && !SERVER_MODE) startTunnel();
  if (settings.soomgo && QUOTE_FEATURES) startSoomgo();
  if (settings.chat && !EXT_RUNNER) startChat();
  if (settings.kakaoWatch && !SERVER_MODE) kakaotalk.start(settings.talk);
});
