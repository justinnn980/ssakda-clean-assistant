// 카카오톡 채팅방에 정해 둔 말(예: [방문견적])이 든 새 글이 올라오면 바로 답을 보낸다.
// 카카오톡에는 이런 용도의 공식 연동이 없어서 이 컴퓨터의 카카오톡 창을 직접 읽고 조작한다.
// 답은 글 올린 사람에게 개인톡으로 보내거나(direct), 시험용으로 같은 방에 보낸다(room).
// 개인톡은 일반 단체방이면 그 사람의 프로필에서 1:1 채팅을 열어 보내고, 오픈채팅방이면 이미 만들어 둔 1:1 채팅방으로 보낸다.
// 창 조작은 운영체제마다 달라 지금은 맥용만 있다(scripts/kakaotalk-mac.js). 윈도우용은 같은 peek·send·direct를 만들어 끼우면 된다.
// AI 분석은 거치지 않는다. 일감은 1분 안에 마감되기도 해서 글자가 들어 있는지만 보고 즉시 보낸다.
// 다른 프로그램을 실행하는 기능과 경로를 다루는 기능
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 이 프로그램이 들어 있는 폴더와, 맥에서 카카오톡 창을 조작하는 스크립트의 위치
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAC_SCRIPT = path.join(ROOT, 'scripts', 'kakaotalk-mac.js');

// 맥용 스크립트를 실행하고 그 결과(JSON 한 줄)를 받아 온다. 15초(방 목록은 40초) 안에 끝나지 않으면 실패로 본다
function mac(...args) {
  return new Promise((resolve, reject) => {
    // 방 목록 읽기는 방이 많으면 오래 걸려서 넉넉히 기다린다
    execFile('osascript', ['-l', 'JavaScript', MAC_SCRIPT, ...args], { timeout: args[0] === 'rooms' ? 40000 : 15000 }, (err, stdout) => {
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

// 운영체제마다 다른 '창 조작' 부분을 끼우는 자리. 맥이면 맥용 스크립트를 쓰고, 그 밖(윈도우)은 아직 없어서 null이다
const adapter =
  process.platform === 'darwin'
    ? {
        // 채팅방 목록 읽기
        rooms: () => mac('rooms'),
        // 방의 마지막 글들 읽기
        peek: (room) => mac('peek', room),
        // 같은 방에 글 보내기
        send: (room, text) => mac('send', room, text),
        // 글 올린 사람에게 개인톡 보내기
        direct: (room, text, rowText) => mac('direct', room, text, rowText),
      }
    : null;

// 화면에 보여줄 상태: 상태(off, starting, ok, error), 안내 글, 마지막 확인 시각, 최근에 반응한 기록 10개
export const status = { state: 'off', message: '', lastCheck: null, events: [] };

// 정해진 시간만큼 기다린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 켜고 끌 때마다 올라가는 번호. 끄거나 설정을 바꾸면 돌고 있던 옛 지켜보기가 스스로 멈추게 하는 데 쓴다
let generation = 0;

// 설정 화면에서 고를 수 있게 이 컴퓨터 카카오톡의 채팅방 이름을 돌려준다.
// 읽는 데 몇 초 걸리므로 5분 동안은 읽어 둔 목록을 다시 쓴다.
let roomCache = { at: 0, list: [] };
export async function rooms() {
  // 윈도우처럼 창 조작이 없는 컴퓨터에서는 빈 목록
  if (!adapter) return [];
  if (Date.now() - roomCache.at > 5 * 60 * 1000) roomCache = { at: Date.now(), list: (await adapter.rooms()).rooms };
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
    status.message = '이 컴퓨터(윈도우 등)에서는 아직 카카오톡 조작이 준비되지 않았습니다. 지금은 맥에서만 됩니다.';
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
  // 개인톡은 화면의 프로필을 실제로 눌러서 보내므로, 지켜보는 동안 화면이 꺼지지 않게 한다
  const awake = spawn('caffeinate', ['-d'], { stdio: 'ignore' });
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
        // 찾을 말이 없는 글과, 내가 보낸 글과 똑같은 글은 건너뛴다
        if (!row.text.includes(keyword) || row.text.trim() === message.trim()) continue;
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
