// 싹다클린 AI 비서 사이트에서 돈다. 사이트가 확장이 설치된 것(과 버전)을 알 수 있게 표시하고,
// 사이트의 켜기·끄기·창 열기를 확장 본체(background.js)에 전한다. 이 사이트 주소를 확장의 서버 주소로 알려 준다.
document.documentElement.dataset.ssakdaExt = chrome.runtime.getManifest().version;
chrome.runtime.sendMessage({ cmd: 'hello', server: location.origin }).catch(() => {});
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'ssakda-site') return;
  const { cmd, chatId } = e.data;
  chrome.runtime
    .sendMessage({ cmd, chatId, server: location.origin })
    .then((r) => r, (err) => ({ error: err.message }))
    .then((r) => window.postMessage({ source: 'ssakda-ext', cmd, ok: Boolean(r?.ok), error: r?.error || '' }, location.origin));
});
