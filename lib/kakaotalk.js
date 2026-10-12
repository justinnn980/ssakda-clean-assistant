// 카카오톡 채팅방에 정해 둔 말(예: [방문견적])이 든 새 글이 올라오면 바로 답을 보낸다.
// 카카오톡에는 이런 용도의 공식 연동이 없어서 이 컴퓨터의 카카오톡 창을 직접 읽고 조작한다.
// 답은 글 올린 사람에게 개인톡으로 보내거나(direct), 시험용으로 같은 방에 보낸다(room).
// 창 조작은 운영체제마다 달라 지금은 맥용만 있다(scripts/kakaotalk-mac.js). 윈도우용은 같은 peek·send·direct를 만들어 끼우면 된다.
// AI 분석은 거치지 않는다. 일감은 1분 안에 마감되기도 해서 글자가 들어 있는지만 보고 즉시 보낸다.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAC_SCRIPT = path.join(ROOT, 'scripts', 'kakaotalk-mac.js');

function mac(...args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', MAC_SCRIPT, ...args], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error(`카카오톡 창을 읽지 못했습니다: ${String(err.message).split('\n')[0]}`));
      try {
        const out = JSON.parse(stdout);
        out.error ? reject(new Error(out.error)) : resolve(out);
      } catch {
        reject(new Error('카카오톡 창에서 받은 내용을 읽지 못했습니다.'));
      }
    });
  });
}

const adapter =
  process.platform === 'darwin'
    ? {
        peek: (room) => mac('peek', room),
        send: (room, text) => mac('send', room, text),
        direct: (room, text, rowText) => mac('direct', room, text, rowText),
      }
    : null;

export const status = { state: 'off', message: '', lastCheck: null, events: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let generation = 0;

export function stop() {
  generation += 1;
  status.state = 'off';
  status.message = '';
}

// room 방을 지켜보다가 keyword가 든 새 글이 오면 message를 보낸다. 켜기 전에 있던 글에는 반응하지 않는다.
// target이 direct면 글 올린 사람에게 개인톡으로, room이면 같은 방에 보낸다.
export async function start({ room, keyword, message, target = 'direct', intervalMs = 1500 }) {
  const gen = ++generation;
  const active = () => gen === generation;
  if (!adapter) {
    status.state = 'error';
    status.message = '이 컴퓨터(윈도우 등)에서는 아직 카카오톡 조작이 준비되지 않았습니다. 지금은 맥에서만 됩니다.';
    return;
  }
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
  let lastCount = 0;

  while (active()) {
    let wait = intervalMs;
    try {
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
      for (const row of fresh) {
        if (!row.text.includes(keyword) || row.text.trim() === message.trim()) continue;
        const event = { at: new Date().toISOString(), text: row.text.replace(/\s+/g, ' ').slice(0, 80), sent: false, note: '', to: '' };
        try {
          if (target === 'direct') {
            if (!row.sender) throw new Error('내가 올린 글이라 보내지 않았습니다.');
            event.to = (await adapter.direct(room, message, row.text)).to;
          } else await adapter.send(room, message);
          event.sent = true;
          event.ms = Date.now() - new Date(event.at).getTime();
          console.log(`[카톡] "${event.text}" 에 ${event.to ? `${event.to}님에게 개인톡을` : '답장을'} 보냈습니다.`);
        } catch (e) {
          event.note = e.message;
          console.error(`[카톡] 답장을 보내지 못했습니다: ${e.message}`);
        }
        status.events.unshift(event);
        status.events.length = Math.min(status.events.length, 10);
      }
    } catch (e) {
      if (!active()) break;
      status.state = 'error';
      status.message = e.message;
      wait = 5000;
    }
    await sleep(wait);
  }
  awake.kill();
}
