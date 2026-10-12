// 노트북에 설치된 Claude Code(구독)를 헤드리스로 호출해 문의를 분석한다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const decodedRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 윈도우에서는 설치 프로그램이 넣어 주는 claude.exe를 직접 쓴다. npm으로 설치한 claude.cmd는 이 방식으로 실행되지 않는다.
const WIN_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const claudeBin = () => process.env.CLAUDE_BIN || (process.platform === 'win32' && existsSync(WIN_CLAUDE) ? WIN_CLAUDE : 'claude');

const str = { type: 'string' };
const nullableNum = { type: ['number', 'null'] };
const list = { type: 'array', items: str };

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'summary', 'region', 'job_type', 'job_category', 'volume_text', 'load_tons', 'workers', 'vehicles',
    'ladder_needed', 'ladder_hours', 'night', 'unknowns', 'photo_observations', 'estimate_ready', 'risk_level',
    'review_reasons', 'reply_need_info', 'reply_with_estimate',
  ],
  properties: {
    title: { ...str, description: '목록에 보일 짧은 제목. 예: 평택 안중읍 34평 청소·곰팡이' },
    summary: { ...str, description: '① 고객 요청 요약' },
    region: { ...str, description: '② 지역. 모르면 "미확인"' },
    job_type: { ...str, description: '③ 작업 종류' },
    job_category: { type: 'string', enum: ['waste_small', 'waste_general', 'cleaning', 'mixed', 'other'] },
    volume_text: { ...str, description: '④ 예상 폐기물 양과 그 근거. 해당 없으면 "해당 없음"' },
    load_tons: { ...nullableNum, description: '1톤 차량 기준 적재 비율. 판단 불가면 null' },
    workers: { ...nullableNum, description: '⑤ 필요한 인원. 판단 불가면 null' },
    vehicles: { ...nullableNum, description: '⑥ 1톤 차량 대수. 판단 불가면 null' },
    ladder_needed: { type: 'string', enum: ['yes', 'no', 'unknown'], description: '⑦ 사다리차 필요 여부' },
    ladder_hours: nullableNum,
    night: { type: 'string', enum: ['yes', 'no', 'unknown'], description: '⑧ 야간 여부' },
    unknowns: { ...list, description: '⑨ 추가로 확인해야 할 사항' },
    photo_observations: { ...list, description: '사진에서 본 것. 사진이 없으면 빈 배열' },
    estimate_ready: { type: 'boolean', description: '차량·인원·양이 견적을 낼 만큼 확인됐는가' },
    risk_level: { type: 'string', enum: ['low', 'review', 'high'] },
    review_reasons: list,
    reply_need_info: str,
    reply_with_estimate: str,
  },
};

function buildPrompt(inquiry) {
  const lines = ['아래는 숨고 문의 한 건의 전체 기록이다. 규칙에 따라 분석하고 답변 초안을 작성하라.', ''];
  inquiry.messages.forEach((m, i) => {
    const who = m.from === 'owner' ? '사장님이 보낸 답변/메모' : '고객 문의·답장';
    lines.push(`<기록 번호="${i + 1}" 구분="${who}" 시각="${m.at}">`);
    if (m.text) lines.push(m.text);
    for (const f of m.images || []) lines.push(`[사진 파일: ./${f}]`);
    lines.push('</기록>', '');
  });
  return lines.join('\n');
}

function runClaude(args, input, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('AI 분석 시간이 초과되었습니다.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Claude Code를 실행하지 못했습니다: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Claude Code 오류(${code}): ${(err || out).slice(0, 500)}`));
      resolve(out);
    });
    child.stdin.end(input);
  });
}

export async function analyze(inquiry, inquiryDir) {
  const system = await readFile(path.join(decodedRoot, 'prompt.md'), 'utf8');
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--json-schema', JSON.stringify(SCHEMA),
    '--strict-mcp-config',
    '--no-session-persistence',
    '--allowedTools', 'Read',
    '--tools', 'Read',
  ];
  if (process.env.CLAUDE_MODEL) args.unshift('--model', process.env.CLAUDE_MODEL);

  const raw = await runClaude(args, buildPrompt(inquiry), inquiryDir, 5 * 60 * 1000);
  const envelope = JSON.parse(raw);
  if (envelope.is_error) throw new Error(`AI 분석 실패: ${String(envelope.result).slice(0, 300)}`);
  let data = envelope.structured_output;
  if (!data) {
    const text = String(envelope.result || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error('AI 응답에서 분석 결과를 찾지 못했습니다.');
    data = JSON.parse(text.slice(start, end + 1));
  }
  for (const key of SCHEMA.required) {
    if (!(key in data)) throw new Error(`AI 응답에 ${key} 항목이 없습니다.`);
  }
  return data;
}
