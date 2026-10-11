// 문의 한 건을 data/inquiries/<id>/inquiry.json 과 사진 파일로 저장한다.
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const DATA_DIR = path.join(decodeURIComponent(path.dirname(path.dirname(new URL(import.meta.url).pathname))), 'data');
const INQ_DIR = path.join(DATA_DIR, 'inquiries');

const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/;

export function inquiryDir(id) {
  if (!ID_RE.test(id)) throw new Error('잘못된 문의 번호입니다.');
  return path.join(INQ_DIR, id);
}

export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export async function save(inquiry) {
  const dir = inquiryDir(inquiry.id);
  await mkdir(dir, { recursive: true });
  inquiry.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, 'inquiry.json.tmp');
  await writeFile(tmp, JSON.stringify(inquiry, null, 2));
  await rename(tmp, path.join(dir, 'inquiry.json'));
  return inquiry;
}

export async function load(id) {
  return JSON.parse(await readFile(path.join(inquiryDir(id), 'inquiry.json'), 'utf8'));
}

export async function list() {
  await mkdir(INQ_DIR, { recursive: true });
  const ids = (await readdir(INQ_DIR)).filter((n) => ID_RE.test(n));
  const all = [];
  for (const id of ids) {
    try {
      all.push(await load(id));
    } catch {
      // 저장이 끝나지 않은 폴더는 건너뛴다
    }
  }
  return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// data:image/...;base64 형식의 사진을 문의 폴더에 저장하고 파일명을 돌려준다.
export async function saveImages(id, dataUrls) {
  const dir = inquiryDir(id);
  await mkdir(dir, { recursive: true });
  const names = [];
  for (const url of dataUrls || []) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!m) throw new Error('사진 형식을 읽을 수 없습니다. (JPG, PNG, WEBP만 가능)');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `photo-${Date.now()}-${randomBytes(2).toString('hex')}.${ext}`;
    await writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'));
    names.push(name);
  }
  return names;
}
