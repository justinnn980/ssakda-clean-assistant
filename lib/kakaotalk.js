// 카카오톡 채팅방에 정해 둔 말(예: [방문견적])이 든 새 글이 올라오면 바로 답을 보낸다.
// 카카오톡에는 이런 용도의 공식 연동이 없어서 이 컴퓨터의 카카오톡 창을 직접 읽고 조작한다.
// 답은 글 올린 사람에게 개인톡으로 보내거나(direct), 시험용으로 같은 방에 보낸다(room).
// 개인톡은 일반 단체방이면 그 사람의 프로필에서 1:1 채팅을 열어 보내고, 오픈채팅방이면 이미 만들어 둔 1:1 채팅방으로 보낸다.
// 창 조작은 운영체제마다 달라 맥용(scripts/kakaotalk-mac.js)과 윈도우용(scripts/kakaotalk-win.ps1)이 따로 있다.
// 윈도우는 채팅 글이 접근성 정보로 나오지 않아 채팅방 창을 찍어 글자 인식(OCR)으로 읽는다.
// AI 분석은 거치지 않는다. 일감은 1분 안에 마감되기도 해서 글자가 들어 있는지만 보고 즉시 보낸다.
// 다른 프로그램을 실행하는 기능과 경로를 다루는 기능
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 이 프로그램이 들어 있는 폴더와, 맥·윈도우에서 카카오톡 창을 조작하는 스크립트의 위치
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAC_SCRIPT = path.join(ROOT, 'scripts', 'kakaotalk-mac.js');
const WIN_SCRIPT = path.join(ROOT, 'scripts', 'kakaotalk-win.ps1');

// 이 컴퓨터에 맞는 스크립트를 실행하고 그 결과(JSON 한 줄)를 받아 온다. 15초(방 목록은 40초, 개인톡은 30초) 안에 끝나지 않으면 실패로 본다
function run(...args) {
  const [program, before] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_SCRIPT]]
      : ['osascript', ['-l', 'JavaScript', MAC_SCRIPT]];
  return new Promise((resolve, reject) => {
    // 방 목록 읽기는 방이 많으면, 개인톡은 1:1 방을 찾아 여느라 오래 걸려서 넉넉히 기다린다
    const timeout = args[0] === 'rooms' ? 40000 : args[0] === 'direct' ? 30000 : 15000;
    execFile(program, [...before, ...args], { timeout, windowsHide: true }, (err, stdout) => {
      // 실행 자체가 실패한 경우
      if (err) return reject(new Error(`카카오톡 창을 읽지 못했습니다: ${String(err.message).split('\n')[0]}`));
      // 결과를 자료로 바꾼다. 결과에 error가 들어 있으면 실패로, 아니면 성공으로 돌려준다
      try {
        const out = JSON.parse(stdout);
        out.error ? reject(new Error(out.error)) : resolve(out);
      } catch {
        reject(new Error('카카오톡 창에서 받은 내용을 읽지 못했습니다.'));
      }
    });
  });
}

// 글자를 견줄 때 띄어쓰기·괄호·이모티콘처럼 글자 인식이 자주 틀리는 것을 뺀다(한글·영문·숫자만 남긴다)
const squash = (s) => String(s).replace(/[^0-9A-Za-z가-힣]/g, '');

// 두 글이 거의 같은지(글자 인식이 한두 글자 다르게 읽은 정도인지) 본다
function similar(a, b) {
  if (a === b) return true;
  if (!a || !b || Math.abs(a.length - b.length) > Math.max(2, a.length * 0.15)) return false;
  // 한 글을 다른 글로 바꾸는 데 고쳐야 하는 글자 수
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.15));
}

// 윈도우의 글 읽기. 화면을 찍어 읽은 글에는 맥처럼 고정된 줄 번호가 없어서, 지난번에 읽은 글과 견주어 번호를 붙인다.
// 지난번 글과 (거의) 같은 글은 그때 번호를, 그 뒤에 새로 보이는 글에만 새 번호를 준다. 겹치는 글이 하나도 없으면
// (창을 새로 열었거나 위로 올려 본 경우) count를 0으로 돌려 지금 보이는 글을 모두 본 것으로 치게 한다.
const winState = new Map();
async function winPeek(room) {
  const cur = await run('peek', room);
  const state = winState.get(room) || { next: 0, rows: [] };
  const keys = cur.rows.map((r) => squash(r.text));
  // 지난번 글과 같은 것 가운데 가장 아래에 있는 글
  let lastOld = -1;
  const indexes = keys.map((k, i) => {
    const old = state.rows.find((o) => o.sender === cur.rows[i].sender && similar(o.key, k));
    if (old) lastOld = i;
    return old ? old.index : null;
  });
  const reset = state.rows.length > 0 && lastOld < 0 && keys.length > 0;
  const rows = cur.rows.map((r, i) => {
    // 그 글보다 아래에 있는 처음 보는 글만 새 글이다. 위쪽의 처음 보는 글(스크롤로 드러난 예전 글)은 본 것으로 친다
    const index = indexes[i] ?? (i > lastOld || reset ? state.next++ : -1);
    return { ...r, index };
  });
  winState.set(room, { next: state.next, rows: rows.map((r, i) => ({ key: keys[i], sender: r.sender, index: r.index })) });
  return { count: reset ? 0 : state.next, rows: rows.filter((r) => r.index >= 0) };
}

// 운영체제마다 다른 '창 조작' 부분을 끼우는 자리. 그 밖의 운영체제는 없어서 null이다
const adapter =
  process.platform === 'darwin' || process.platform === 'win32'
    ? {
        // 채팅방 목록 읽기
        rooms: () => run('rooms'),
        // 방의 마지막 글들 읽기
        peek: (room) => (process.platform === 'win32' ? winPeek(room) : run('peek', room)),
        // 같은 방에 글 보내기
        send: (room, text) => run('send', room, text),
        // 글 올린 사람에게 개인톡 보내기
        direct: (room, text, rowText) => run('direct', room, text, rowText),
      }
    : null;

// 화면에 보여줄 상태: 상태(off, starting, ok, error), 안내 글, 마지막 확인 시각, 최근에 반응한 기록 10개
export const status = { state: 'off', message: '', lastCheck: null, events: [] };

// 윈도우에서 화면이 꺼지거나 잠들지 않게 하는 명령(맥의 caffeinate -d). 이 PowerShell을 끝내면 원래대로 돌아간다
const WIN_KEEP_AWAKE =
  "Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [Win32.Power]::SetThreadExecutionState(0x80000003) | Out-Null; while ($true) { Start-Sleep -Seconds 3600 }";

// 정해진 시간만큼 기다린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 켜고 끌 때마다 올라가는 번호. 끄거나 설정을 바꾸면 돌고 있던 옛 지켜보기가 스스로 멈추게 하는 데 쓴다
let generation = 0;

// 설정 화면에서 고를 수 있게 이 컴퓨터 카카오톡의 채팅방 이름을 돌려준다.
// 읽는 데 몇 초 걸리므로 5분 동안은 읽어 둔 목록을 다시 쓴다(fresh면 바로 다시 읽는다).
let roomCache = { at: 0, list: [] };
export async function rooms(fresh = false) {
  // 창 조작이 없는 컴퓨터에서는 빈 목록
  if (!adapter) return [];
  if (fresh || Date.now() - roomCache.at > 5 * 60 * 1000) roomCache = { at: Date.now(), list: (await adapter.rooms()).rooms };
  return roomCache.list;
}

// 지켜보기를 멈춘다. 번호를 올리면 아래 start의 되풀이가 다음 차례에 끝난다
export function stop() {
  generation += 1;
  status.state = 'off';
  status.message = '';
}

// room 방을 지켜보다가 keyword가 든 새 글이 오면 message를 보낸다. 켜기 전에 있던 글에는 반응하지 않는다.
// target이 direct면 글 올린 사람에게 개인톡으로, room이면 같은 방에 보낸다.
export async function start({ room, keyword, message, target = 'direct', intervalMs = 1500 }) {
  // 이번에 켠 것의 번호. 이 번호가 최신일 때만 계속 돈다
  const gen = ++generation;
  const active = () => gen === generation;
  // 창 조작이 준비되지 않은 컴퓨터면 안내만 남기고 끝낸다
  if (!adapter) {
    status.state = 'error';
    status.message = '이 컴퓨터에서는 카카오톡 조작이 준비되지 않았습니다. 맥과 윈도우에서만 됩니다.';
    return;
  }
  // 방 이름·찾을 말·보낼 글이 비었거나, 보낼 글 안에 찾을 말이 들어 있으면 시작하지 않는다
  if (!room || !keyword || !message || message.includes(keyword)) {
    status.state = 'error';
    status.message = !room || !keyword || !message ? '설정에서 방 이름, 찾을 말, 보낼 글을 채워 주세요.' : '보낼 글에 찾을 말이 들어 있으면 자기 글에 계속 답하게 됩니다. 보낼 글을 고쳐 주세요.';
    return;
  }
  status.state = 'starting';
  status.message = '카카오톡 창을 확인하는 중입니다.';
  // 개인톡은 화면의 프로필을 실제로 눌러서 보내므로, 지켜보는 동안 화면이 꺼지지 않게 한다.
  // 윈도우는 화면이 꺼지거나 잠기면 카카오톡 창을 앞으로 가져와 보낼 수 없어서 같은 일을 하는 PowerShell을 띄워 둔다
  const awake =
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', WIN_KEEP_AWAKE], { stdio: 'ignore', windowsHide: true })
      : spawn('caffeinate', ['-d'], { stdio: 'ignore' });
  awake.on('error', () => {});
  let seen = null; // 지금까지 본 글 가운데 가장 뒤 줄 번호
  // 지난번에 확인했을 때 창에 있던 줄 수
  let lastCount = 0;

  // 꺼질 때까지 1.5초마다 되풀이한다
  while (active()) {
    // 다음 확인까지 기다릴 시간. 오류가 나면 5초로 늘린다
    let wait = intervalMs;
    try {
      // 방의 마지막 글 몇 개를 읽는다. 읽는 사이에 꺼졌으면 그만둔다
      const cur = await adapter.peek(room);
      if (!active()) break;
      status.lastCheck = new Date().toISOString();
      status.state = 'ok';
      status.message = `"${room}" 방을 지켜보는 중`;
      // 창 맨 끝에는 빈 줄이 하나 있어서 줄 수가 아니라 글의 줄 번호로 새 글을 가린다.
      // 처음 확인했거나 창이 새로 열려 줄 수가 줄었으면, 지금 있는 글은 모두 본 것으로 친다.
      const newest = cur.rows.length ? cur.rows[cur.rows.length - 1].index : -1;
      const reset = seen === null || cur.count < lastCount;
      const fresh = reset ? [] : cur.rows.filter((r) => r.index > seen);
      seen = reset ? newest : Math.max(seen, newest);
      lastCount = cur.count;
      // 새로 올라온 글을 하나씩 본다
      for (const row of fresh) {
        // 찾을 말이 없는 글과, 내가 보낸 글과 똑같은 글은 건너뛴다. 윈도우는 글자 인식이 괄호·띄어쓰기를 틀리기도 해서 그것을 빼고 견준다
        if (!squash(row.text).includes(squash(keyword)) || similar(squash(row.text), squash(message))) continue;
        // 첫 화면에 보여줄 기록: 시각, 글 앞부분 80자, 보냈는지, 못 보낸 사유, 받는 사람
        const event = { at: new Date().toISOString(), text: row.text.replace(/\s+/g, ' ').slice(0, 80), sent: false, note: '', to: '' };
        try {
          // 보낼 곳이 개인톡이면 글 올린 사람에게, 아니면 같은 방에 보낸다. 내가 올린 글에는 보내지 않는다
          if (target === 'direct') {
            if (!row.sender) throw new Error('내가 올린 글이라 보내지 않았습니다.');
            event.to = (await adapter.direct(room, message, row.text)).to;
          } else await adapter.send(room, message);
          // 보냈다고 표시하고, 글을 발견한 뒤 보내기까지 걸린 시간을 적는다
          event.sent = true;
          event.ms = Date.now() - new Date(event.at).getTime();
          console.log(`[카톡] "${event.text}" 에 ${event.to ? `${event.to}님에게 개인톡을` : '답장을'} 보냈습니다.`);
        } catch (e) {
          // 보내지 못했으면 사유를 기록에 남긴다
          event.note = e.message;
          console.error(`[카톡] 답장을 보내지 못했습니다: ${e.message}`);
        }
        // 기록을 맨 앞에 넣고 최근 10개만 남긴다
        status.events.unshift(event);
        status.events.length = Math.min(status.events.length, 10);
      }
    } catch (e) {
      // 방을 읽지 못한 경우: 사유를 화면에 보여주고 5초 뒤 다시 시도한다
      if (!active()) break;
      status.state = 'error';
      status.message = e.message;
      wait = 5000;
    }
    await sleep(wait);
  }
  // 지켜보기가 끝나면 화면 꺼짐 방지도 끈다
  awake.kill();
}
