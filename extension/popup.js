// 확장 아이콘 창: 확장 본체에게 지금 상태를 물어 보여주고, 숨고 창과 비서 사이트를 연다
const stateEl = document.getElementById('state');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
chrome.runtime.sendMessage({ cmd: 'status' }).then(({ status: s, server }) => {
  const [cls, text] =
    s.state === 'ok' ? ['on', `동작 중 · ${s.work || s.message}`]
    : s.state === 'login' ? ['wait', '숨고 로그인이 필요합니다. 숨고 창에서 로그인해 주세요.']
    : s.state === 'error' ? ['bad', s.message]
    : s.state === 'starting' ? ['wait', '숨고 창을 여는 중입니다.']
    : ['', '꺼져 있습니다. 비서 사이트에서 "켜기"를 누르면 시작합니다.'];
  stateEl.innerHTML = `<span class="dot ${cls}"></span>${esc(text)}`;
  document.getElementById('site').onclick = () => chrome.tabs.create({ url: server });
});
document.getElementById('open').onclick = () => chrome.runtime.sendMessage({ cmd: 'open' }).then(() => window.close());
