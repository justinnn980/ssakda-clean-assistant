// 카카오톡 '나에게 보내기' 공식 API로 사장님 본인에게 알림을 보낸다.
// 카카오 계정 비밀번호는 다루지 않는다. 사장님이 카카오 화면에서 직접 동의한 토큰만 저장한다.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const TOKEN_FILE = path.join(DATA_DIR, 'kakao_token.json');

const restKey = () => process.env.KAKAO_REST_KEY || '';
const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3210}`).replace(/\/$/, '');
// 외부 주소는 켤 때마다 바뀔 수 있어 카카오 연결은 항상 노트북 주소로 한다
const redirectUri = () => `http://localhost:${process.env.PORT || 3210}/kakao/callback`;

export const kakaoConfigured = () => Boolean(restKey());

export async function kakaoConnected() {
  try {
    return Boolean(JSON.parse(await readFile(TOKEN_FILE, 'utf8')).refresh_token);
  } catch {
    return false;
  }
}

export function authorizeUrl() {
  const q = new URLSearchParams({ client_id: restKey(), redirect_uri: redirectUri(), response_type: 'code', scope: 'talk_message' });
  return `https://kauth.kakao.com/oauth/authorize?${q}`;
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: restKey(), ...params });
  if (process.env.KAKAO_CLIENT_SECRET) body.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`카카오 토큰 오류: ${json.error_description || json.error || res.status}`);
  return json;
}

async function saveToken(json, previous = {}) {
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || previous.refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
  return token;
}

export async function exchangeCode(code) {
  await saveToken(await tokenRequest({ grant_type: 'authorization_code', redirect_uri: redirectUri(), code }));
}

async function accessToken() {
  let token = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
  if (Date.now() >= token.expires_at) {
    token = await saveToken(await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token }), token);
  }
  return token.access_token;
}

// 연결이 안 되어 있으면 조용히 건너뛴다. 알림 실패가 문의 처리를 막지 않게 한다.
export async function notify(text, linkPath = '/') {
  if (!kakaoConfigured() || !(await kakaoConnected())) return false;
  try {
    const url = `${baseUrl()}${linkPath}`;
    const template = {
      object_type: 'text',
      text: `${text.slice(0, 120)}\n${url}`.slice(0, 200),
      link: { web_url: url, mobile_web_url: url },
      button_title: '문의 열기',
    };
    const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    console.error('[카카오 알림 실패]', e.message);
    return false;
  }
}
