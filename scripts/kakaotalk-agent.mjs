// 카톡 일감 도우미: 카카오톡이 있는 PC에서 돌며, 서버(비서 사이트)의 '카톡 일감 잡기' 켜기·끄기와 설정을 받아 따른다.
// 서버에는 카카오톡이 없어서, 사이트에서 켜고 끄면 이 도우미가 몇 초 안에 받아 이 PC의 카카오톡을 지켜본다.
// 지켜보기 상태·최근 기록·방 목록은 서버에 알려 사이트에 보이게 한다. 실행: node scripts/kakaotalk-agent.mjs
//   --setup <서버 주소> <접속 비밀번호>  처음 한 번: 접속해 보고 맞으면 data/talk-agent.json에 저장한다
// 바탕화면의 '카톡 일감 도우미' 아이콘(scripts/start-kakaotalk-agent.ps1)이 이것을 창 없이 실행한다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kakaotalk from '../lib/kakaotalk.js';

// 프로그램 폴더와, 서버 주소·접속 비밀번호를 적어 두는 파일(저장소에 올리지 않는 data 폴더)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(DATA, 'talk-agent.json');

// 서버에 연락하는 간격, 방 목록을 다시 읽는 간격
const EVERY = 3000;
const ROOMS_EVERY = 30000;

// 정해진 시간만큼 기다린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 시각을 붙여 기록을 남긴다 (실행기가 data/talk-agent.log에 모은다)
const log = (...a) => console.log(new Date().toLocaleString('ko-KR'), ...a);

// 서버에 로그인해 표(쿠키)를 받는다. 비밀번호가 틀리면 사유를 담아 던진다
async function login(server, pin) {
  const res = await fetch(new URL('/api/login', server), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `서버에 로그인하지 못했습니다(${res.status}).`);
  const cookie = /ssak=[a-f0-9]{64}/.exec(res.headers.get('set-cookie') || '');
  if (!cookie) throw new Error('서버에서 로그인 표를 받지 못했습니다.');
  return cookie[0];
}

// 처음 한 번: 서버 주소와 비밀번호로 로그인해 보고, 되면 저장한다
if (process.argv[2] === '--setup') {
  const server = String(process.argv[3] || '').trim().replace(/\/+$/, '');
  const pin = String(process.argv[4] || '').trim();
  try {
    if (!/^https?:\/\/\S+$/.test(server) || !pin) throw new Error('서버 주소와 접속 비밀번호를 넣어 주세요.');
    await login(server, pin);
    await mkdir(DATA, { recursive: true });
    await writeFile(CONFIG, JSON.stringify({ server, pin }, null, 2));
    console.log('저장했습니다.');
    process.exit(0);
  } catch (e) {
    console.log(e.message);
    process.exit(1);
  }
}

// 저장해 둔 서버 주소와 비밀번호. 없으면 실행기에서 먼저 설정해야 한다
let config;
try {
  config = JSON.parse(await readFile(CONFIG, 'utf8'));
} catch {
  console.error('data/talk-agent.json이 없습니다. 바탕화면의 "카톡 일감 도우미"를 눌러 접속 비밀번호를 먼저 넣어 주세요.');
  process.exit(1);
}
await writeFile(path.join(DATA, 'talk-agent.pid'), String(process.pid));
log(`카톡 일감 도우미를 켰습니다. 서버: ${config.server}`);

let cookie = '';
// 마지막으로 따른 설정(켜짐 여부와 방·찾을 말·보낼 글·보낼 곳). 바뀔 때만 다시 시작한다
let applied = '';
// 방 목록을 마지막으로 읽은 시각과, 읽지 못했을 때의 사유
let roomsAt = 0;
let roomsNote = '';
// 서버가 마지막으로 알려 준 안내(다른 PC가 일하는 중 등)
let lastNote = '';

// 서버의 설정을 따른다: 켜져 있으면 그 설정으로 지켜보기를 (다시) 시작하고, 꺼져 있으면 멈춘다
function follow({ kakaoWatch, talk }) {
  const key = JSON.stringify([kakaoWatch, talk]);
  if (key === applied) return;
  applied = key;
  if (kakaoWatch) {
    log(`지켜보기 시작: 방 "${talk.room}", 찾을 말 "${talk.keyword}", 보낼 곳 ${talk.target}`);
    kakaotalk.start(talk);
  } else {
    log('지켜보기 끔');
    kakaotalk.stop();
  }
}

// 꺼질 때까지 몇 초마다 서버에 지금 상태를 알리고 설정을 받아 온다. 서버에 닿지 않으면 마지막 설정대로 계속 지켜본다
while (true) {
  try {
    if (!cookie) cookie = await login(config.server, config.pin);
    // 방 목록은 30초마다 새로 읽어 함께 보낸다(설정 화면에서 고르는 데 쓴다)
    // 이 PC의 이름도 보낸다(사이트에 보이고, 서버가 도우미를 한 PC에서만 일하게 하는 데 쓴다)
    const body = { ...kakaotalk.status, pc: os.hostname() };
    if (Date.now() - roomsAt > ROOMS_EVERY) {
      roomsAt = Date.now();
      try {
        body.rooms = await kakaotalk.rooms(true);
        roomsNote = '';
      } catch (e) {
        body.rooms = [];
        roomsNote = e.message;
      }
      body.roomsNote = roomsNote;
    }
    const res = await fetch(new URL('/api/talk/agent', config.server), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    // 로그인 표가 풀렸으면 다음 차례에 다시 로그인한다
    if (res.status === 401) {
      cookie = '';
      throw new Error('로그인이 풀려 다시 로그인합니다.');
    }
    if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
    const got = await res.json();
    // 다른 PC의 도우미가 일하는 중이면 그 사유를 한 번만 남긴다
    if (got.note && got.note !== lastNote) log(got.note);
    lastNote = got.note || '';
    follow(got);
  } catch (e) {
    log(`서버 연락 실패: ${e.message}`);
    await sleep(10000);
  }
  await sleep(EVERY);
}
