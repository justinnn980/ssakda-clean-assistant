// 숨고 페이지에서 AI 비서가 하는 일을 화면 아래쪽에 보여준다(banner). 확장이 살아 있는지 확인하는 ping에도 답한다.
// 목록 읽기·채팅방 읽기·써 넣기·전송은 page.js가 한다(background.js가 서버에서 최신본을 받아 숨고 화면에 넣는다).
// 지금 주소가 로그인 화면이면 로그인이 풀린 것으로 본다
const loggedOut = () => /\/(login|sign-?in|auth)/i.test(location.pathname);

// AI 비서가 하는 일을 화면 아래쪽에 작게 보여준다(빈 글이면 숨긴다). 누르는 데 방해되지 않게 한다
let bannerEl = null;
function banner({ text }) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px);padding:8px 14px;border-radius:999px;background:#0f766e;color:#fff;font:600 13px/1.4 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.documentElement.appendChild(bannerEl);
  }
  bannerEl.textContent = `싹다클린 AI 비서 · ${text}`;
  bannerEl.style.display = text ? 'block' : 'none';
  return { ok: true };
}

// background.js가 보낸 일을 하고 결과를 돌려준다
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const jobs = { ping: async () => ({ ok: true, loggedOut: loggedOut() }), banner: async (m) => banner(m) };
  const job = jobs[msg?.cmd];
  if (!job) return false;
  job(msg).then(reply, (e) => reply({ error: e.message }));
  return true;
});
