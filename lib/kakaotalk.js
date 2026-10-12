// 카카오톡 채팅방에 정해 둔 말(예: [방문견적])이 든 새 글이 올라오면 바로 답을 보낸다.
// 카카오톡에는 이런 용도의 공식 연동이 없어서 이 컴퓨터의 카카오톡 창을 직접 읽고 조작한다.
// 창 조작은 운영체제마다 달라 지금은 맥용만 있다(scripts/kakaotalk-mac.js). 윈도우용은 같은 peek·send를 만들어 끼우면 된다.
// AI 분석은 거치지 않는다. 일감은 1분 안에 마감되기도 해서 글자가 들어 있는지만 보고 즉시 보낸다.
import { execFile } from 'node:child_process';
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

const adapter = process.platform === 'darwin' ? { peek: (room) => mac('peek', room), send: (room, text) => mac('send', room, text) } : null;

export const status = { state: 'off', message: '', lastCheck: null, events: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let generation = 0;

export function stop() {
  generation += 1;
  status.state = 'off';
  status.message = '';
}

// room 방을 지켜보다가 keyword가 든 새 글이 오면 message를 보낸다. 켜기 전에 있던 글에는 반응하지 않는다.
export async function start({ room, keyword, message, intervalMs = 1500 }) {
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
  let last = null;

  while (active()) {
    let wait = intervalMs;
    try {
      const cur = await adapter.peek(room);
      if (!active()) return;
      status.lastCheck = new Date().toISOString();
      status.state = 'ok';
      status.message = `"${room}" 방을 지켜보는 중`;
      const key = `${cur.count}|${cur.labels.join('|')}|${cur.text}`;
      const isNew = last !== null && key !== last;
      last = key;
      if (isNew && cur.text.includes(keyword) && cur.text.trim() !== message.trim()) {
        const event = { at: new Date().toISOString(), text: cur.text.replace(/\s+/g, ' ').slice(0, 80), sent: false, note: '' };
        try {
          await adapter.send(room, message);
          event.sent = true;
          event.ms = Date.now() - new Date(event.at).getTime();
          console.log(`[카톡] "${event.text}" 에 답장을 보냈습니다.`);
        } catch (e) {
          event.note = e.message;
          console.error(`[카톡] 답장을 보내지 못했습니다: ${e.message}`);
        }
        status.events.unshift(event);
        status.events.length = Math.min(status.events.length, 10);
      }
    } catch (e) {
      if (!active()) return;
      status.state = 'error';
      status.message = e.message;
      wait = 5000;
    }
    await sleep(wait);
  }
}
