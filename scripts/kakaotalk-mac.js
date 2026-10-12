// 맥용 카카오톡 창을 읽고 조작한다. node가 아니라 osascript로 실행한다:
//   osascript -l JavaScript scripts/kakaotalk-mac.js peek <방 이름>
//   osascript -l JavaScript scripts/kakaotalk-mac.js send <방 이름> <보낼 글>
// macOS '손쉬운 사용' 권한이 필요하다. 결과는 JSON 한 줄로 돌려준다.
function run(argv) {
  const [cmd, room, text] = argv;
  try {
    const proc = Application('System Events').processes.byName('KakaoTalk');
    if (!proc.exists()) return JSON.stringify({ error: '카카오톡이 켜져 있지 않습니다.' });
    if (cmd === 'peek') return JSON.stringify(peek(proc, room));
    if (cmd === 'send') return JSON.stringify(send(proc, room, text));
    return JSON.stringify({ error: `알 수 없는 명령: ${cmd}` });
  } catch (e) {
    const denied = /-1719|-25211|보조 접근|assistive/i.test(String(e.message));
    return JSON.stringify({ error: denied ? "카카오톡 화면을 읽을 권한이 없습니다. 시스템 설정의 '손쉬운 사용'에서 허용해 주세요." : String(e.message) });
  }
}

const val = (f) => {
  try {
    const v = f();
    return v === null || v === undefined ? '' : String(v);
  } catch (e) {
    return '';
  }
};

// 채팅방 창을 찾는다. 닫혀 있으면 채팅 목록에서 그 방을 열어 준다(이때만 카카오톡이 잠깐 앞으로 나온다).
function roomWindow(proc, room) {
  if (proc.windows.byName(room).exists()) return proc.windows.byName(room);
  const main = proc.windows.byName('카카오톡');
  if (!main.exists()) {
    // 창만 닫혀 있는 경우: Dock 아이콘을 누른 것처럼 다시 연다
    const app = Application('KakaoTalk');
    try {
      app.reopen();
    } catch (e) {}
    app.activate();
    for (let n = 0; n < 15 && !main.exists(); n++) delay(0.2);
  }
  if (!main.exists()) throw new Error('카카오톡 창이 닫혀 있습니다. 카카오톡 창을 열어 주세요.');
  const rows = main.scrollAreas[0].tables[0].rows();
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    if (val(() => rows[i].uiElements[0].staticTexts[0].value()) !== room) continue;
    rows[i].selected = true;
    Application('KakaoTalk').activate();
    delay(0.4);
    Application('System Events').keyCode(36);
    for (let n = 0; n < 15 && !proc.windows.byName(room).exists(); n++) delay(0.2);
    if (proc.windows.byName(room).exists()) return proc.windows.byName(room);
    break;
  }
  throw new Error(`"${room}" 채팅방을 찾지 못했습니다. 카카오톡을 '채팅' 탭으로 두고 방 이름을 확인해 주세요.`);
}

// 방의 마지막 글을 읽는다. count는 지금까지 창에 불러온 줄 수로, 새 글이 왔는지 가리는 데 쓴다.
function peek(proc, room) {
  const win = roomWindow(proc, room);
  const rows = win.scrollAreas[0].tables[0].rows();
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
    const cell = rows[i].uiElements[0];
    const body = val(() => cell.textAreas[0].value());
    if (!body) continue;
    const labels = cell.staticTexts().map((t) => val(() => t.value()));
    return { count: rows.length, text: body, labels };
  }
  return { count: rows.length, text: '', labels: [] };
}

// 방에 글을 보낸다. 입력 칸에 쓰던 글이 있으면 보낸 뒤 되돌려 놓는다.
function send(proc, room, text) {
  const win = roomWindow(proc, room);
  const areas = win.scrollAreas();
  let input = null;
  for (const a of areas) {
    if (val(() => a.textAreas[0].description()) === '메시지 입력') input = a.textAreas[0];
  }
  if (!input) throw new Error('메시지 입력 칸을 찾지 못했습니다.');
  const draft = val(() => input.value());
  input.value = text;
  delay(0.15);
  const button = win.buttons.byName('전송');
  if (!button.enabled()) {
    input.value = draft;
    throw new Error('전송 버튼이 눌리지 않는 상태입니다.');
  }
  button.click();
  delay(0.3);
  const left = val(() => input.value());
  if (left === text) {
    input.value = draft;
    throw new Error('전송을 눌렀지만 글이 보내지지 않았습니다.');
  }
  if (draft) input.value = draft;
  return { sent: true };
}
