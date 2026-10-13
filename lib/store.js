// 문의 한 건을 data/inquiries/<id>/inquiry.json 과 사진 파일로 저장한다.
// 파일·폴더 다루기, 무작위 값 만들기, 경로 다루기
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 모든 자료를 두는 data 폴더 (이 프로그램 폴더 바로 아래)
export const DATA_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data');
// 문의들이 들어가는 폴더
const INQ_DIR = path.join(DATA_DIR, 'inquiries');

// 문의 번호의 모양: 날짜8자리-시각6자리-무작위4글자 (예: 20261013-153012-a1b2)
const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/;

// 문의 번호로 그 문의의 폴더 경로를 만든다. 번호가 정해진 모양이 아니면 거절해서 다른 폴더를 건드리지 못하게 한다
export function inquiryDir(id) {
  if (!ID_RE.test(id)) throw new Error('잘못된 문의 번호입니다.');
  return path.join(INQ_DIR, id);
}

// 지금 날짜·시각에 무작위 4글자를 붙여 새 문의 번호를 만든다
export function newId() {
  const d = new Date();
  // 한 자리 숫자 앞에 0을 붙여 두 자리로 만든다 (9 → 09)
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

// 문의를 저장한다. 고친 시각을 적고, 임시 파일에 다 쓴 다음 이름을 바꿔서 저장 도중 꺼져도 파일이 깨지지 않게 한다
export async function save(inquiry) {
  const dir = inquiryDir(inquiry.id);
  await mkdir(dir, { recursive: true });
  inquiry.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, 'inquiry.json.tmp');
  await writeFile(tmp, JSON.stringify(inquiry, null, 2));
  await rename(tmp, path.join(dir, 'inquiry.json'));
  return inquiry;
}

// 문의 번호로 저장된 문의를 읽는다
export async function load(id) {
  return JSON.parse(await readFile(path.join(inquiryDir(id), 'inquiry.json'), 'utf8'));
}

// 모든 문의를 읽어 최근에 고친 순서로 돌려준다
export async function list() {
  await mkdir(INQ_DIR, { recursive: true });
  // 문의 번호 모양인 폴더만 고른다
  const ids = (await readdir(INQ_DIR)).filter((n) => ID_RE.test(n));
  const all = [];
  for (const id of ids) {
    try {
      all.push(await load(id));
    } catch {
      // 저장이 끝나지 않은 폴더는 건너뛴다
    }
  }
  // 고친 시각이 늦은 것이 앞에 오도록 줄 세운다
  return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// data:image/...;base64 형식의 사진을 문의 폴더에 저장하고 파일명을 돌려준다.
export async function saveImages(id, dataUrls) {
  const dir = inquiryDir(id);
  await mkdir(dir, { recursive: true });
  const names = [];
  // 사진마다 형식을 확인하고, 파일 이름을 정해 저장한다
  for (const url of dataUrls || []) {
    // JPG, PNG, WEBP가 아니면 받지 않는다
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!m) throw new Error('사진 형식을 읽을 수 없습니다. (JPG, PNG, WEBP만 가능)');
    // 파일 이름: photo-시각-무작위4글자.확장자
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `photo-${Date.now()}-${randomBytes(2).toString('hex')}.${ext}`;
    // 글자로 된 사진 내용을 원래의 파일 내용으로 되돌려 저장한다
    await writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'));
    names.push(name);
  }
  return names;
}
