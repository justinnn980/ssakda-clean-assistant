// 카카오톡 '나에게 보내기' 공식 API로 사장님 본인에게 알림을 보낸다.
// 카카오 계정 비밀번호는 다루지 않는다. 사장님이 카카오 화면에서 직접 동의한 토큰만 저장한다.
// 파일 읽기·쓰기, 폴더 만들기, 경로 다루기, data 폴더 위치
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

// 카카오에서 받은 토큰(사장님 대신 알림을 보낼 수 있는 허가증)을 저장하는 파일
const TOKEN_FILE = path.join(DATA_DIR, 'kakao_token.json');

// .env에 적어 둔 카카오 앱의 REST API 키
const restKey = () => process.env.KAKAO_REST_KEY || '';
// 알림에 넣을 링크의 앞부분. 외부 접속 주소가 있으면 그 주소, 없으면 노트북 주소
const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3210}`).replace(/\/$/, '');
// 외부 주소는 켤 때마다 바뀔 수 있어 카카오 연결은 항상 노트북 주소로 한다.
// 서버는 주소가 고정(.env의 BASE_URL)이고 서버 앞에서 연결할 수 없으므로 그 주소로 한다 (카카오 앱 설정에 이 주소를 등록해야 한다)
const redirectUri = () =>
  process.env.SERVER_MODE === '1' && process.env.BASE_URL ? `${baseUrl()}/kakao/callback` : `http://localhost:${process.env.PORT || 3210}/kakao/callback`;

// 카카오 알림을 쓸 준비가 됐는지 (.env에 키가 있는지)
export const kakaoConfigured = () => Boolean(restKey());

// 사장님이 카카오 동의를 마쳐 토큰이 저장돼 있는지
export async function kakaoConnected() {
  try {
    return Boolean(JSON.parse(await readFile(TOKEN_FILE, 'utf8')).refresh_token);
  } catch {
    return false;
  }
}

// 카카오 동의 화면의 주소를 만든다. '카카오톡 메시지 전송' 권한만 요청한다
export function authorizeUrl() {
  const q = new URLSearchParams({ client_id: restKey(), redirect_uri: redirectUri(), response_type: 'code', scope: 'talk_message' });
  return `https://kauth.kakao.com/oauth/authorize?${q}`;
}

// 카카오에 토큰을 달라고(또는 새로 바꿔 달라고) 요청한다
async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: restKey(), ...params });
  // 카카오 앱에 보안 값(Client Secret)을 정해 두었으면 함께 보낸다
  if (process.env.KAKAO_CLIENT_SECRET) body.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  const json = await res.json();
  // 카카오가 거절하면 그 사유를 오류로 알린다
  if (!res.ok) throw new Error(`카카오 토큰 오류: ${json.error_description || json.error || res.status}`);
  return json;
}

// 받은 토큰을 파일에 저장한다. 새 갱신용 토큰이 오지 않았으면 전에 쓰던 것을 그대로 둔다
async function saveToken(json, previous = {}) {
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || previous.refresh_token,
    // 만료 시각. 끝나기 1분 전에 미리 새로 받도록 60초를 뺀다
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  // data 폴더에, 이 컴퓨터의 내 계정만 읽고 쓸 수 있게 저장한다
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
  return token;
}

// 동의 화면에서 돌아올 때 받은 코드를 토큰으로 바꿔 저장한다
export async function exchangeCode(code) {
  await saveToken(await tokenRequest({ grant_type: 'authorization_code', redirect_uri: redirectUri(), code }));
}

// 알림을 보낼 때 쓸 토큰을 돌려준다. 만료됐으면 갱신용 토큰으로 새로 받아 저장한다
async function accessToken() {
  let token = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
  if (Date.now() >= token.expires_at) {
    token = await saveToken(await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token }), token);
  }
  return token.access_token;
}

// 연결이 안 되어 있으면 조용히 건너뛴다. 알림 실패가 문의 처리를 막지 않게 한다.
export async function notify(text, linkPath = '/') {
  // 준비가 안 됐거나 연결되지 않았으면 아무것도 하지 않는다
  if (!kakaoConfigured() || !(await kakaoConnected())) return false;
  try {
    // 알림을 누르면 열릴 주소
    const url = `${baseUrl()}${linkPath}`;
    // 알림의 모양: 글(120자까지)과 주소, 그리고 '문의 열기' 단추
    const template = {
      object_type: 'text',
      text: `${text.slice(0, 120)}\n${url}`.slice(0, 200),
      link: { web_url: url, mobile_web_url: url },
      button_title: '문의 열기',
    };
    // 카카오의 '나에게 보내기'로 보낸다
    const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
    // 카카오가 거절했으면 오류로 넘긴다
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    // 알림을 보내지 못해도 프로그램은 멈추지 않고 기록만 남긴다
    console.error('[카카오 알림 실패]', e.message);
    return false;
  }
}
