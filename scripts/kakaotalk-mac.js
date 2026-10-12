// 맥용 카카오톡 창을 읽고 조작한다. node가 아니라 osascript로 실행한다:
//   osascript -l JavaScript scripts/kakaotalk-mac.js peek <방 이름>
//   osascript -l JavaScript scripts/kakaotalk-mac.js send <방 이름> <보낼 글>
//   osascript -l JavaScript scripts/kakaotalk-mac.js direct <방 이름> <보낼 글> <일감 글 본문> [dry]
// macOS '손쉬운 사용' 권한이 필요하고, direct는 '화면 기록' 권한도 필요하다. 결과는 JSON 한 줄로 돌려준다.
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.import('Vision');

function run(argv) {
  const [cmd, room, text, rowText, flag] = argv;
  try {
    const proc = Application('System Events').processes.byName('KakaoTalk');
    if (!proc.exists()) return JSON.stringify({ error: '카카오톡이 켜져 있지 않습니다.' });
    if (cmd === 'peek') return JSON.stringify(peek(proc, room));
    if (cmd === 'send') return JSON.stringify(send(roomWindow(proc, room), text));
    if (cmd === 'direct') return JSON.stringify(direct(proc, room, text, rowText, flag === 'dry'));
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
    // 다른 채팅방 창이 앞에 있으면 Enter가 그 창으로 가므로, 채팅 목록 창을 맨 앞으로 올린 뒤 누른다
    Application('KakaoTalk').activate();
    main.actions.byName('AXRaise').perform();
    delay(0.3);
    rows[i].selected = true;
    delay(0.2);
    Application('System Events').keyCode(36);
    for (let n = 0; n < 15 && !proc.windows.byName(room).exists(); n++) delay(0.2);
    if (proc.windows.byName(room).exists()) return proc.windows.byName(room);
    break;
  }
  throw new Error(`"${room}" 채팅방을 찾지 못했습니다. 카카오톡을 '채팅' 탭으로 두고 방 이름을 확인해 주세요.`);
}

// 글 한 줄에서 올린 사람 이름을 읽는다. 다른 사람 글에는 프로필 사진이 있고 이름이 그 바로 오른쪽(가장 왼쪽 글자)에 있다.
// 내가 올린 글에는 프로필 사진이 없어서 빈 글자를 돌려준다.
function senderOf(cell) {
  if (!cell.buttons.whose({ description: '프로필' })().length) return '';
  let name = '';
  let left = Infinity;
  for (const t of cell.staticTexts()) {
    const x = t.position()[0];
    if (x < left) {
      left = x;
      name = val(() => t.value());
    }
  }
  return name;
}

// 방의 마지막 글 몇 개를 읽는다. count는 지금까지 창에 불러온 줄 수이고, 각 글의 index는 그 줄 번호다.
// 줄 번호가 지난번 count 이상인 글이 새로 온 글이다. 글이 연달아 올라와도 하나씩 빠짐없이 처리하려고 여러 개를 돌려준다.
// 답장(댓글)은 답장으로 쓴 글만 읽힌다. 인용된 원래 글은 읽히지 않으므로 "마감" 같은 답장이 일감 글로 잡히지 않는다.
function peek(proc, room) {
  const win = roomWindow(proc, room);
  const rows = win.scrollAreas[0].tables[0].rows();
  const recent = [];
  for (let i = Math.max(0, rows.length - 8); i < rows.length; i++) {
    const cell = rows[i].uiElements[0];
    const body = val(() => cell.textAreas[0].value());
    if (body) recent.push({ index: i, text: body, sender: senderOf(cell) });
  }
  return { count: rows.length, rows: recent };
}

// 채팅방 창에 글을 보낸다. 입력 칸에 쓰던 글이 있으면 보낸 뒤 되돌려 놓는다.
function send(win, text) {
  let input = null;
  for (const a of win.scrollAreas()) {
    // 평소에는 '메시지 입력', 답장을 쓰는 중이면 '답장 메시지 입력'
    if (val(() => a.textAreas[0].description()).endsWith('메시지 입력')) input = a.textAreas[0];
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

// ---------- 글 올린 사람에게 개인톡 ----------
// 프로필 사진과 프로필 창은 접근성 정보로 눌리지 않아서 실제 마우스 누름을 쓰고,
// 프로필 창 안의 "1:1 채팅" 버튼은 화면에서 그 글자를 찾아 누른다(옆의 통화 버튼을 잘못 누르지 않기 위해서다).

function mouseClick(x, y) {
  const here = $.CGEventGetLocation($.CGEventCreate(null));
  const p = $.CGPointMake(x, y);
  const post = (type, at) => $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, at, $.kCGMouseButtonLeft));
  post($.kCGEventMouseMoved, p);
  delay(0.08);
  post($.kCGEventLeftMouseDown, p);
  delay(0.06);
  post($.kCGEventLeftMouseUp, p);
  delay(0.15);
  post($.kCGEventMouseMoved, here);
}

// 화면에 떠 있는 카카오톡 창. 프로필 창은 접근성 창 목록에 나오지 않아 운영체제 창 목록에서 찾는다.
function screenWindows() {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
  return list
    .filter((w) => (w.kCGWindowOwnerName === 'KakaoTalk' || w.kCGWindowOwnerName === '카카오톡') && w.kCGWindowLayer === 0)
    .map((w) => ({ id: w.kCGWindowNumber, named: Boolean(w.kCGWindowName), x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height }));
}

// 그림 파일에서 needle 글자가 있는 곳을 찾는다. 위치는 그림 크기에 대한 비율이고 y는 아래에서부터 잰다.
function findText(file, needle) {
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLanguages = $(['ko-KR', 'en-US']);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(file), $.NSDictionary.dictionary);
  if (!handler.performRequestsError($([request]), null)) return null;
  const found = request.results;
  for (let i = 0; i < found.count; i++) {
    const item = found.objectAtIndex(i);
    const text = ObjC.unwrap(item.topCandidates(1).objectAtIndex(0).string).replace(/\s/g, '');
    if (!text.includes(needle)) continue;
    const box = item.boundingBox;
    return { x: box.origin.x, y: box.origin.y, w: box.size.width, h: box.size.height };
  }
  return null;
}

// room 방에서 본문이 rowText인 글을 올린 사람에게 1:1 채팅으로 text를 보낸다.
// 단계마다 확인하고, 하나라도 어긋나면 아무 글도 보내지 않고 사유를 돌려준다. dry면 1:1 채팅 창을 여는 데까지만 한다.
function direct(proc, room, text, rowText, dry) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const win = roomWindow(proc, room);
  Application('KakaoTalk').activate();
  win.actions.byName('AXRaise').perform();
  delay(0.3);

  const rows = win.scrollAreas[0].tables[0].rows();
  let cell = null;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 12) && !cell; i--) {
    const c = rows[i].uiElements[0];
    if (val(() => c.textAreas[0].value()) === rowText) cell = c;
  }
  if (!cell) throw new Error('일감 글을 다시 찾지 못했습니다.');
  const sender = senderOf(cell);
  if (!sender) throw new Error('내가 올린 글이라 보내지 않았습니다.');

  const photo = cell.buttons.whose({ description: '프로필' })()[0];
  const wp = win.position();
  const ws = win.size();
  const pp = photo.position();
  const ps = photo.size();
  if (pp[1] < wp[1] + 60 || pp[1] + ps[1] > wp[1] + ws[1] - 110) throw new Error('일감 글이 채팅방 화면 밖에 있어 프로필을 누르지 못했습니다.');

  const before = screenWindows().map((w) => w.id);
  const openBefore = proc.windows().map((w) => val(() => w.name()));
  mouseClick(pp[0] + ps[0] / 2, pp[1] + ps[1] / 2);
  let popup = null;
  for (let n = 0; n < 15 && !popup; n++) {
    delay(0.2);
    popup = screenWindows().find((w) => !before.includes(w.id) && !w.named);
  }
  if (!popup) throw new Error('프로필 창이 뜨지 않았습니다. 오픈채팅방에서는 프로필이 열리지 않습니다.');
  delay(0.5);

  // 프로필 창 아래쪽(버튼이 있는 띠)만 찍어서 "1:1 채팅" 글자의 위치를 찾는다
  const strip = Math.min(150, popup.h);
  const top = popup.y + popup.h - strip;
  const shot = ObjC.unwrap($.NSTemporaryDirectory()) + `ssakda-profile-${popup.id}.png`;
  app.doShellScript(`/usr/sbin/screencapture -x -R ${popup.x},${top},${popup.w},${strip} '${shot}'`);
  const hit = findText(shot, '1:1채팅');
  app.doShellScript(`/bin/rm -f '${shot}'`);
  if (!hit) throw new Error('프로필 창에서 "1:1 채팅" 버튼을 찾지 못했습니다. 대화를 걸 수 없는 상대이거나 화면 기록 권한이 없을 수 있습니다.');
  mouseClick(popup.x + (hit.x + hit.w / 2) * popup.w, top + (1 - (hit.y + hit.h / 2)) * strip);

  // 1:1 채팅 창: 올린 사람 이름의 창, 또는 새로 열린 창 하나
  let chat = null;
  for (let n = 0; n < 20 && !chat; n++) {
    delay(0.2);
    if (sender !== room && proc.windows.byName(sender).exists()) chat = proc.windows.byName(sender);
    else {
      const fresh = proc.windows().filter((w) => !openBefore.includes(val(() => w.name())));
      if (fresh.length === 1) chat = fresh[0];
    }
  }
  if (!chat || val(() => chat.name()) === room) throw new Error('1:1 채팅 창이 열리지 않았습니다.');
  const wasOpen = openBefore.includes(val(() => chat.name()));
  const result = dry ? { sent: false, opened: true, to: sender } : { ...send(chat, text), to: sender };
  // 이번에 새로 연 창이면 닫아서 화면을 원래대로 둔다
  if (!wasOpen) {
    try {
      chat.buttons.whose({ description: '닫기 버튼' })()[0].click();
    } catch (e) {}
  }
  return result;
}
