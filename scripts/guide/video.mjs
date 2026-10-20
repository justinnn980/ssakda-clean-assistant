// 가이드 영상 다시 만들기: public/guide/install.mp4, daily.mp4 (+ 첫 장면 그림). 먼저 shots.mjs로 사진을 만든다.
// 준비: 맥의 say(한국어 음성 '유나'), Homebrew ffmpeg(libx264, aac). 장면마다 읽어 줄 말(say)과 자막(cap)은 아래 videos에서 고친다.
// 실행: node scripts/guide/video.mjs <작업 폴더>
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright-core');
const SP = process.argv[2];
const GUIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/guide');
const WORK = `${SP}/video`;
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const FONT = "-apple-system, 'Apple SD Gothic Neo', sans-serif";
const img = (f) => `data:image/jpeg;base64,${fs.readFileSync(`${GUIDE}/${f}`).toString('base64')}`;

// 영상 두 편. say는 읽어 줄 말, cap은 화면 아래 자막(짧게), shot은 화면 사진(없으면 제목 화면)
const videos = {
  install: {
    title: '처음 설치하기',
    scenes: [
      { say: '싹다클린 AI 비서를 처음 설치하는 방법입니다. 사장님 컴퓨터의 크롬에서, 처음 한 번만 하면 됩니다.', cap: '컴퓨터의 크롬에서 처음 한 번만 하면 됩니다' },
      { shot: '1-download.jpg', say: '먼저 크롬에서 비서 사이트에 들어가, 위쪽의 안내 버튼을 누르고, 확장 파일 받기를 누릅니다.', cap: '비서 사이트 → 안내 → <b>확장 파일 받기</b>' },
      { shot: '2-unzip.jpg', say: '받은 파일을 마우스 오른쪽 버튼으로 누르고, 모두 압축 풀기를 누른 뒤, 압축 풀기 버튼을 누릅니다. 같은 이름의 폴더가 생기는데, 이 폴더는 지우지 마세요.', cap: '오른쪽 클릭 → <b>모두 압축 풀기</b> → <b>압축 풀기</b>' },
      { shot: '3-devmode.jpg', say: '크롬 주소창에 크롬 확장 프로그램 주소를 넣고 엔터를 누릅니다. 안내 페이지의 주소 복사 버튼을 누른 뒤 붙여 넣으면 편합니다. 그리고 오른쪽 위의 개발자 모드를 켭니다.', cap: '주소창에 <b>chrome://extensions</b> → <b>개발자 모드</b> 켜기' },
      { shot: '4-load.jpg', say: '왼쪽 위에 새로 나타난, 압축해제된 확장 프로그램 로드를 누릅니다.', cap: '<b>압축해제된 확장 프로그램 로드</b>' },
      { shot: '5-pick-folder.jpg', say: '방금 압축을 푼 폴더를 한 번 누르고, 폴더 선택을 누릅니다.', cap: '압축을 푼 폴더 → <b>폴더 선택</b>' },
      { shot: '6-installed.jpg', say: '이렇게 싹다클린 AI 비서가 보이면 설치가 끝났습니다.', cap: '싹다클린 AI 비서가 보이면 끝' },
      { shot: '7-site-ok.jpg', say: '비서 사이트로 돌아와 새로고침하면, 안내 페이지 맨 위에 설치되어 있다고 나옵니다. 매일 쓰는 법은 다음 영상에서 알려 드릴게요.', cap: '비서 사이트 새로고침 → "설치되어 있습니다"' },
    ],
  },
  daily: {
    title: '매일 쓰는 법',
    scenes: [
      { say: '싹다클린 AI 비서를 매일 쓰는 방법입니다.', cap: '켜기만 누르면 AI 비서가 숨고 채팅을 맡습니다' },
      { shot: '8-turn-on.jpg', say: '컴퓨터의 크롬에서 비서 사이트를 열고, 숨고 채팅 자동 응대의 켜기를 누릅니다. 이미 켜져 있으면 창 열기를 누르세요.', cap: '숨고 채팅 자동 응대 → <b>켜기</b> (켜져 있으면 <b>창 열기</b>)' },
      { shot: '9-soomgo-login.jpg', say: '숨고 창이 열립니다. 로그인 화면이 나오면, 평소처럼 숨고에 로그인하세요. 아래쪽에 싹다클린 AI 비서 표시가 보입니다.', cap: '숨고 창에서 평소처럼 <b>로그인</b>' },
      { shot: '10-running.jpg', say: '비서 사이트에 PC 크롬에서 숨고 채팅 확인 중이라고 나오면 잘 되고 있는 것입니다. 숨고 창은 닫지 말고 아래로 내려 두세요.', cap: '"PC 크롬에서 숨고 채팅 확인 중" → 잘 되고 있음' },
      { shot: '11-draft.jpg', say: '새 채팅방이 생기면 그 방이 새 탭으로 열리고, 잠시 뒤 채팅창에 AI가 쓴 첫 응대가 써집니다. 읽어 보고, 괜찮으면 전송을 눌러 주세요.', cap: '채팅창에 써진 답장을 읽어 보고 <b>전송</b>' },
      { say: '휴대폰으로 비서 사이트에 들어가면, 잘 되고 있는지 보고 켜고 끌 수 있습니다. 문제가 생기면 안내 페이지의 문제가 생기면 칸을 봐 주세요.', cap: '휴대폰으로 상태 확인 · 켜고 끄기 / 문제가 생기면 → 안내 페이지' },
    ],
  },
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, v] of Object.entries(videos)) {
  const parts = [];
  for (const [i, s] of v.scenes.entries()) {
    const n = String(i).padStart(2, '0');
    // 장면 그림 (1280x720): 위 제목 줄, 가운데 화면 사진, 아래 자막
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const body = s.shot
      ? `<div style="position:absolute;left:0;right:0;top:58px;bottom:118px;display:flex;align-items:center;justify-content:center;background:#e9eceb"><img src="${img(s.shot)}" style="max-width:1240px;max-height:530px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18)"></div>`
      : `<div style="position:absolute;left:0;right:0;top:58px;bottom:118px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#e7f3f1,#f4f6f5)"><div style="width:120px;height:120px;border-radius:30px;background:#0f766e;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:44px">AI</div><div style="margin-top:26px;font-size:54px;font-weight:800;color:#0f766e">싹다클린 AI 비서</div><div style="margin-top:10px;font-size:40px;font-weight:700;color:#17201e">${v.title}</div></div>`;
    await page.setContent(`<html><body style="margin:0;width:1280px;height:720px;position:relative;font-family:${FONT};overflow:hidden;background:#fff">
      <div style="position:absolute;left:0;right:0;top:0;height:58px;background:#0f766e;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 26px;font-size:24px;font-weight:700"><span>싹다클린 AI 비서 · ${v.title}</span><span>${s.shot ? `${i} / ${v.scenes.filter((x) => x.shot).length}` : ''}</span></div>
      ${body}
      <div style="position:absolute;left:0;right:0;bottom:0;height:118px;display:flex;align-items:center;justify-content:center;padding:0 40px;text-align:center;font-size:34px;line-height:1.35;color:#17201e;background:#fff;border-top:1px solid #dfe5e3"><span>${s.cap}</span></div>
    </body></html>`);
    await page.screenshot({ path: `${WORK}/${name}-${n}.png` });
    await page.close();
    // 음성 → 영상 조각 (음성 길이 + 0.8초, 최소 3초)
    execFileSync('say', ['-v', 'Yuna', '-r', '165', '-o', `${WORK}/${name}-${n}.aiff`, s.say]);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${WORK}/${name}-${n}.aiff`]).toString());
    const len = Math.max(3, dur + 0.8).toFixed(2);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '15', '-i', `${WORK}/${name}-${n}.png`, '-i', `${WORK}/${name}-${n}.aiff`,
      '-af', 'apad', '-t', len, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '15',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', '44100', `${WORK}/${name}-${n}.mp4`]);
    parts.push(`file '${WORK}/${name}-${n}.mp4'`);
  }
  fs.writeFileSync(`${WORK}/${name}.txt`, parts.join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${WORK}/${name}.txt`, '-c', 'copy', '-movflags', '+faststart', `${GUIDE}/${name}.mp4`]);
  // 영상을 누르기 전에 보여 줄 첫 장면 그림
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${WORK}/${name}-00.png`, '-q:v', '4', `${GUIDE}/${name}-poster.jpg`]);
  const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${GUIDE}/${name}.mp4`]).toString());
  console.log(`${name}.mp4: ${total.toFixed(1)}초, ${(fs.statSync(`${GUIDE}/${name}.mp4`).size / 1024).toFixed(0)}KB`);
}
await browser.close();
