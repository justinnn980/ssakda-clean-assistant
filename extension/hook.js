// 숨고 페이지 안에서 숨고 화면과 같은 자리(MAIN)에서 돈다.
// 숨고 화면이 스스로 불러오는 채팅 목록과, 실시간 연결 표(로그인한 계정 번호가 들어 있다)의 답을 읽어 window.__ssakdaHook에 모아 둔다(page.js가 쓴다).
// 숨고에 요청을 새로 하거나 바꾸지 않고, 화면이 받은 답을 읽기만 한다.
(() => {
  // 읽을 답: 채팅방 목록(예: /api/v2.4/chats/?role=provider), 실시간 연결 표(/v1/accounts/web-socket/token)
  const CHATS_RE = /^https:\/\/api\.soomgo\.com\/(?:api\/)?v[\d.]+\/chats\/?\?/;
  const TOKEN_RE = /^https:\/\/api\.soomgo\.com\/v\d+\/accounts\/web-socket\/token/;
  const wanted = (url) => CHATS_RE.test(url) || TOKEN_RE.test(url);
  const store = (window.__ssakdaHook = window.__ssakdaHook || {});
  // 받은 답(JSON 글)을 모아 둔다
  const pass = (url, method, text) => {
    try {
      const body = JSON.parse(text);
      if (method === 'GET' && CHATS_RE.test(url) && Array.isArray(body?.results)) store.chats = body;
      else if (method === 'POST' && TOKEN_RE.test(url)) store.token = body;
    } catch {
      // JSON이 아니면 건너뛴다
    }
  };
  const abs = (u) => new URL(String(u), location.href).href;

  // fetch로 받는 답
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = abs(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (wanted(url)) res.clone().text().then((t) => pass(url, method, t), () => {});
    } catch {
      // 읽지 못해도 숨고 화면은 그대로 둔다
    }
    return res;
  };

  // XMLHttpRequest로 받는 답
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__ssakda = { method: String(method).toUpperCase(), url: abs(url) };
    } catch {
      this.__ssakda = null;
    }
    return open.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const info = this.__ssakda;
    if (info && wanted(info.url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === 'json') pass(info.url, info.method, JSON.stringify(this.response));
          else if (this.responseType === '' || this.responseType === 'text') pass(info.url, info.method, this.responseText);
        } catch {
          // 읽지 못해도 숨고 화면은 그대로 둔다
        }
      });
    }
    return send.apply(this, arguments);
  };
})();
