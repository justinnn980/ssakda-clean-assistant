// 맥용 카카오톡 창을 읽고 조작한다. node가 아니라 osascript로 실행한다:
//   osascript -l JavaScript scripts/kakaotalk-mac.js rooms
//   osascript -l JavaScript scripts/kakaotalk-mac.js peek <방 이름>
//   osascript -l JavaScript scripts/kakaotalk-mac.js send <방 이름> <보낼 글>
//   osascript -l JavaScript scripts/kakaotalk-mac.js direct <방 이름> <보낼 글> <일감 글 본문> [dry]
// macOS '손쉬운 사용' 권한이 필요하고, direct는 '화면 기록' 권한도 필요하다. 결과는 JSON 한 줄로 돌려준다.
// 맥의 기능을 불러온다: 화면·마우스·창 목록(CoreGraphics), 기본 도구(Foundation), 그림에서 글자 읽기(Vision)
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
ObjC.import('Vision');

// osascript가 이 파일을 실행하면 가장 먼저 부르는 함수. 명령(rooms, peek, send, direct)에 따라 일을 하고 결과를 JSON 한 줄로 돌려준다
function run(argv) {
  // 명령 뒤에 붙은 값들: 명령, 방 이름, 보낼 글, 일감 글 본문, 시험 표시
  const [cmd, room, text, rowText, flag] = argv;
  try {
    // 실행 중인 카카오톡을 찾는다. 켜져 있지 않으면 그렇다고 알린다
    const proc = Application('System Events').processes.byName('KakaoTalk');
    if (!proc.exists()) return JSON.stringify({ error: '카카오톡이 켜져 있지 않습니다.' });
    if (cmd === 'rooms') return JSON.stringify(roomList(proc));
    if (cmd === 'peek') return JSON.stringify(peek(proc, room));
    if (cmd === 'send') return JSON.stringify(send(roomWindow(proc, room), text));
    if (cmd === 'direct') return JSON.stringify(direct(proc, room, text, rowText, flag === 'dry'));
    return JSON.stringify({ error: `알 수 없는 명령: ${cmd}` });
  } catch (e) {
    // 오류가 났을 때: 권한이 없어서 난 오류면 어디서 허용하는지 알려주고, 아니면 오류 문구를 그대로 돌려준다
    const denied = /-1719|-25211|보조 접근|assistive/i.test(String(e.message));
    return JSON.stringify({ error: denied ? "카카오톡 화면을 읽을 권한이 없습니다. 시스템 설정의 '손쉬운 사용'에서 허용해 주세요." : String(e.message) });
  }
}

// 화면에서 값을 읽다가 실패하면 오류 대신 빈 글자를 돌려준다 (창 구조가 조금 달라도 멈추지 않게)
const val = (f) => {
  try {
    const v = f();
    return v === null || v === undefined ? '' : String(v);
  } catch (e) {
    return '';
  }
};

// 채팅 목록 창. 창만 닫혀 있으면 Dock 아이콘을 누른 것처럼 다시 연다.
function mainWindow(proc) {
  const main = proc.windows.byName('카카오톡');
  // 채팅 목록 창이 없으면 카카오톡을 다시 열고 3초까지 기다린다
  if (!main.exists()) {
    const app = Application('KakaoTalk');
    try {
      app.reopen();
    } catch (e) {}
    app.activate();
    for (let n = 0; n < 15 && !main.exists(); n++) delay(0.2);
  }
  if (!main.exists()) throw new Error('카카오톡 창이 닫혀 있습니다. 카카오톡 창을 열어 주세요.');
  return main;
}

// 채팅 목록의 한 줄을 열어 name 이름의 채팅방 창을 돌려준다. 열리지 않으면 null.
function openRow(proc, main, row, name) {
  // 다른 채팅방 창이 앞에 있으면 Enter가 그 창으로 가므로, 채팅 목록 창을 맨 앞으로 올린 뒤 누른다
  Application('KakaoTalk').activate();
  main.actions.byName('AXRaise').perform();
  delay(0.3);
  // 그 줄을 고르고 Enter(키 번호 36)를 눌러 방을 연다
  row.selected = true;
  delay(0.2);
  Application('System Events').keyCode(36);
  // 그 이름의 창이 뜰 때까지 3초까지 기다린다
  for (let n = 0; n < 15 && !proc.windows.byName(name).exists(); n++) delay(0.2);
  return proc.windows.byName(name).exists() ? proc.windows.byName(name) : null;
}

// 채팅 목록 한 줄의 글자들: [방 이름, (단체방이면 인원 수), 시각 …]. 단체방인지는 둘째 글자가 숫자인지로 가린다.
const rowTexts = (row) => row.uiElements[0].staticTexts.value().map(String);
const isGroup = (texts) => /^\d+$/.test(texts[1] || '');

// 채팅방 창을 찾는다. 닫혀 있으면 채팅 목록에서 그 방을 열어 준다(이때만 카카오톡이 잠깐 앞으로 나온다).
function roomWindow(proc, room) {
  // 이미 열려 있으면 그 창을 쓴다
  if (proc.windows.byName(room).exists()) return proc.windows.byName(room);
  // 채팅 목록의 위에서 60줄까지 방 이름이 같은 줄을 찾아 연다
  const main = mainWindow(proc);
  const rows = main.scrollAreas[0].tables[0].rows();
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    if (val(() => rows[i].uiElements[0].staticTexts[0].value()) !== room) continue;
    const win = openRow(proc, main, rows[i], room);
    if (win) return win;
    break;
  }
  throw new Error(`"${room}" 채팅방을 찾지 못했습니다. 카카오톡을 '채팅' 탭으로 두고 방 이름을 확인해 주세요.`);
}

// 이름이 name인 1:1 채팅방이 이미 있으면 그 창을 돌려준다(없으면 null). 단체방은 건너뛴다.
// 오픈채팅방에서는 프로필로 대화를 새로 걸 수 없어서, 전에 대화해 둔 방으로 보낼 때 쓴다.
function existingChat(proc, name) {
  // 이미 열려 있으면 그 창을 쓴다 (원래 열려 있었다고 표시한다)
  if (proc.windows.byName(name).exists()) return { win: proc.windows.byName(name), wasOpen: true };
  const main = mainWindow(proc);
  let rows;
  try {
    rows = main.scrollAreas[0].tables[0].rows();
  } catch (e) {
    throw new Error("카카오톡 창이 '채팅' 탭이 아니어서 1:1 채팅방을 찾지 못했습니다.");
  }
  // 채팅 목록의 위에서 60줄까지 본다. 이름이 같고 단체방이 아닌 줄을 찾아 연다
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    let texts;
    try {
      texts = rowTexts(rows[i]);
    } catch (e) {
      continue;
    }
    if (texts[0] !== name || isGroup(texts)) continue;
    const win = openRow(proc, main, rows[i], name);
    return win ? { win, wasOpen: false } : null;
  }
  return null;
}

// 설정 화면에서 방을 고를 수 있게 채팅 목록의 방 이름을 돌려준다. 마지막 글 내용은 읽지 않는다.
// 창을 일부러 띄우지는 않는다. 채팅 목록이 보이지 않으면 그렇다고 알려준다.
function roomList(proc) {
  let rows;
  try {
    rows = proc.windows.byName('카카오톡').scrollAreas[0].tables[0].rows();
  } catch (e) {
    throw new Error("카카오톡 창을 '채팅' 탭으로 열어 두면 방 목록에서 고를 수 있습니다.");
  }
  // 채팅 목록은 한 줄 읽는 데 0.1초쯤 걸려서 최근 40개만 읽고, 오픈채팅 표시는 단체방에서만 확인한다
  const rooms = [];
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    let texts;
    try {
      texts = rowTexts(rows[i]);
    } catch (e) {
      continue;
    }
    // 이름이 없는 줄은 건너뛴다
    if (!texts[0]) continue;
    // 인원 수(1:1이면 0)와 오픈채팅방 표시가 있는지를 함께 적는다
    const members = isGroup(texts) ? Number(texts[1]) : 0;
    const open = members > 0 && rows[i].uiElements[0].images.description().some((d) => String(d).includes('openchat'));
    rooms.push({ name: texts[0], members, open });
  }
  return { rooms };
}

// 글 한 줄에서 올린 사람 이름을 읽는다. 다른 사람 글에는 프로필 사진이 있고 이름이 그 바로 오른쪽(가장 왼쪽 글자)에 있다.
// 내가 올린 글에는 프로필 사진이 없어서 빈 글자를 돌려준다.
function senderOf(cell) {
  // 프로필 사진 버튼이 없으면 내가 올린 글이다
  if (!cell.buttons.whose({ description: '프로필' })().length) return '';
  // 줄 안의 글자들 가운데 가장 왼쪽에 있는 것이 올린 사람 이름이다
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
  // 마지막 8줄을 보고, 글 본문이 있는 줄만 줄 번호·본문·올린 사람과 함께 모은다
  for (let i = Math.max(0, rows.length - 8); i < rows.length; i++) {
    const cell = rows[i].uiElements[0];
    const body = val(() => cell.textAreas[0].value());
    if (body) recent.push({ index: i, text: body, sender: senderOf(cell) });
  }
  return { count: rows.length, rows: recent };
}

// 채팅방 창에 글을 보낸다. 입력 칸에 쓰던 글이 있으면 보낸 뒤 되돌려 놓는다.
function send(win, text) {
  // 창에서 메시지 입력 칸을 찾는다
  let input = null;
  for (const a of win.scrollAreas()) {
    // 평소에는 '메시지 입력', 답장을 쓰는 중이면 '답장 메시지 입력'
    if (val(() => a.textAreas[0].description()).endsWith('메시지 입력')) input = a.textAreas[0];
  }
  if (!input) throw new Error('메시지 입력 칸을 찾지 못했습니다.');
  // 쓰던 글을 기억해 두고, 보낼 글을 입력 칸에 넣는다
  const draft = val(() => input.value());
  input.value = text;
  delay(0.15);
  // 전송 버튼이 눌릴 수 없는 상태면 쓰던 글을 되돌리고 그만둔다
  const button = win.buttons.byName('전송');
  if (!button.enabled()) {
    input.value = draft;
    throw new Error('전송 버튼이 눌리지 않는 상태입니다.');
  }
  // 전송 버튼을 누르고, 입력 칸이 비워졌는지로 실제로 보내졌는지 확인한다
  button.click();
  delay(0.3);
  const left = val(() => input.value());
  if (left === text) {
    input.value = draft;
    throw new Error('전송을 눌렀지만 글이 보내지지 않았습니다.');
  }
  // 쓰던 글이 있었으면 되돌려 놓는다
  if (draft) input.value = draft;
  return { sent: true };
}

// ---------- 글 올린 사람에게 개인톡 ----------
// 프로필 사진과 프로필 창은 접근성 정보로 눌리지 않아서 실제 마우스 누름을 쓰고,
// 프로필 창 안의 "1:1 채팅" 버튼은 화면에서 그 글자를 찾아 누른다(옆의 통화 버튼을 잘못 누르지 않기 위해서다).

// 화면의 (x, y) 자리를 실제 마우스로 누른다: 그 자리로 옮기고, 누르고, 떼고, 마우스를 원래 있던 자리로 돌려놓는다
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
  // 화면에 보이는 모든 창의 목록을 받아, 카카오톡의 일반 창만 남기고 번호·이름 유무·위치·크기를 추린다
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
  return list
    .filter((w) => (w.kCGWindowOwnerName === 'KakaoTalk' || w.kCGWindowOwnerName === '카카오톡') && w.kCGWindowLayer === 0)
    .map((w) => ({ id: w.kCGWindowNumber, named: Boolean(w.kCGWindowName), x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height }));
}

// 그림 파일에서 needle 글자가 있는 곳을 찾는다. 위치는 그림 크기에 대한 비율이고 y는 아래에서부터 잰다.
function findText(file, needle) {
  // 한국어와 영어 글자를 읽도록 맡긴다
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLanguages = $(['ko-KR', 'en-US']);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(file), $.NSDictionary.dictionary);
  if (!handler.performRequestsError($([request]), null)) return null;
  // 읽어 낸 글자 덩어리를 하나씩 보며, 빈칸을 뺀 글자에 찾는 말이 들어 있으면 그 자리를 돌려준다
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

// 프로필 사진을 눌러 1:1 채팅 창을 연다. 열지 못하면 사유를 담아 던진다.
function chatViaProfile(proc, win, room, cell, sender) {
  // 화면 찍기 같은 명령을 실행할 수 있게 준비한다
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  // 프로필 사진 버튼과, 채팅방 창·사진의 위치와 크기
  const photo = cell.buttons.whose({ description: '프로필' })()[0];
  const wp = win.position();
  const ws = win.size();
  const pp = photo.position();
  const ps = photo.size();
  // 사진이 창의 위쪽 제목 부분이나 아래쪽 입력 칸에 가려 있으면 누르지 않는다
  if (pp[1] < wp[1] + 60 || pp[1] + ps[1] > wp[1] + ws[1] - 110) throw new Error('일감 글이 채팅방 화면 밖에 있어 프로필을 누르지 못했습니다.');

  // 누르기 전에 떠 있던 창들을 기억해 두고, 프로필 사진 한가운데를 누른다
  const before = screenWindows().map((w) => w.id);
  const openBefore = proc.windows().map((w) => val(() => w.name()));
  mouseClick(pp[0] + ps[0] / 2, pp[1] + ps[1] / 2);
  // 새로 뜬 이름 없는 창(프로필 창)을 3초까지 기다린다
  let popup = null;
  for (let n = 0; n < 15 && !popup; n++) {
    delay(0.2);
    popup = screenWindows().find((w) => !before.includes(w.id) && !w.named);
  }
  if (!popup) throw new Error('프로필 창이 뜨지 않았습니다.');
  delay(0.5);

  // 프로필 창 아래쪽(버튼이 있는 띠)만 찍어서 "1:1 채팅" 글자의 위치를 찾는다
  const strip = Math.min(150, popup.h);
  const top = popup.y + popup.h - strip;
  const shot = ObjC.unwrap($.NSTemporaryDirectory()) + `ssakda-profile-${popup.id}.png`;
  app.doShellScript(`/usr/sbin/screencapture -x -R ${popup.x},${top},${popup.w},${strip} '${shot}'`);
  // 찍은 그림에서 "1:1채팅" 글자를 찾고, 그림 파일은 바로 지운다
  const hit = findText(shot, '1:1채팅');
  app.doShellScript(`/bin/rm -f '${shot}'`);
  if (!hit) throw new Error('프로필 창에서 "1:1 채팅" 버튼을 찾지 못했습니다(화면 기록 권한이 없을 수도 있습니다).');
  // 찾은 글자의 한가운데를 누른다 (그림 안의 비율을 화면 위치로 바꿔서)
  mouseClick(popup.x + (hit.x + hit.w / 2) * popup.w, top + (1 - (hit.y + hit.h / 2)) * strip);

  // 1:1 채팅 창: 올린 사람 이름의 창, 또는 새로 열린 창 하나
  let chat = null;
  // 4초까지 기다린다
  for (let n = 0; n < 20 && !chat; n++) {
    delay(0.2);
    if (sender !== room && proc.windows.byName(sender).exists()) chat = proc.windows.byName(sender);
    else {
      const fresh = proc.windows().filter((w) => !openBefore.includes(val(() => w.name())));
      if (fresh.length === 1) chat = fresh[0];
    }
  }
  if (!chat) throw new Error('1:1 채팅 창이 열리지 않았습니다.');
  // 열린 창과, 그 창이 원래 열려 있던 것인지를 함께 돌려준다
  return { win: chat, wasOpen: openBefore.includes(val(() => chat.name())) };
}

// room 방에서 본문이 rowText인 글을 올린 사람에게 1:1 채팅으로 text를 보낸다.
// 일반 단체방에서는 그 사람의 프로필에서 1:1 채팅을 연다. 오픈채팅방(프로필이 열리지 않는다)이거나 프로필로 열지 못하면,
// 그 사람과 이미 만들어 둔 1:1 채팅방을 채팅 목록에서 이름으로 찾아 보낸다.
// 단계마다 확인하고, 보낼 창을 얻지 못하면 아무 글도 보내지 않고 사유를 돌려준다. dry면 1:1 채팅 창을 여는 데까지만 한다.
function direct(proc, room, text, rowText, dry) {
  // 지켜보는 방의 창을 찾아 맨 앞으로 올린다
  const win = roomWindow(proc, room);
  Application('KakaoTalk').activate();
  win.actions.byName('AXRaise').perform();
  delay(0.3);

  // 마지막 12줄에서 본문이 같은 일감 글을 아래에서부터 찾는다
  const rows = win.scrollAreas[0].tables[0].rows();
  let cell = null;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 12) && !cell; i--) {
    const c = rows[i].uiElements[0];
    if (val(() => c.textAreas[0].value()) === rowText) cell = c;
  }
  if (!cell) throw new Error('일감 글을 다시 찾지 못했습니다.');
  // 올린 사람 이름을 읽는다. 내 글이면 보내지 않는다
  const sender = senderOf(cell);
  if (!sender) throw new Error('내가 올린 글이라 보내지 않았습니다.');

  // 오픈채팅방 창에는 위쪽에 '댓글' 버튼이 있다
  const openChat = win.buttons.whose({ description: '댓글' })().length > 0;
  // 보낼 1:1 창(chat), 어떤 방법으로 열었는지(via), 프로필로 열지 못한 사유(why)
  let chat = null;
  let via = '';
  let why = openChat ? '오픈채팅방이라 프로필로는 대화를 걸 수 없습니다.' : '';
  // 일반 단체방이면 먼저 프로필에서 1:1 채팅을 열어 본다
  if (!openChat) {
    try {
      chat = chatViaProfile(proc, win, room, cell, sender);
      via = 'profile';
    } catch (e) {
      why = String(e.message);
    }
  }
  // 그렇게 열지 못했으면 채팅 목록에서 이름이 같은 기존 1:1 방을 찾는다. 그것도 없으면 보내지 않는다
  if (!chat) {
    chat = existingChat(proc, sender);
    via = 'list';
    if (!chat) throw new Error(`${why} "${sender}"님과 만들어 둔 1:1 채팅방도 채팅 목록에서 찾지 못했습니다.`);
  }
  // 열린 창이 지켜보는 방 자체라면 잘못 보내는 것이므로 멈춘다
  if (val(() => chat.win.name()) === room) throw new Error('1:1 채팅 창이 아니라 지켜보는 방이 열려 보내지 않았습니다.');
  // 시험(dry)이면 창을 연 데까지만 하고, 아니면 글을 보낸다
  const result = dry ? { sent: false, opened: true, to: sender, via } : { ...send(chat.win, text), to: sender, via };
  // 이번에 새로 연 창이면 닫아서 화면을 원래대로 둔다
  if (!chat.wasOpen) {
    try {
      chat.win.buttons.whose({ description: '닫기 버튼' })()[0].click();
    } catch (e) {}
  }
  return result;
}
