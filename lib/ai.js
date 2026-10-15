// 노트북에 설치된 AI 프로그램을 화면 없이 호출해 문의를 분석한다. API 키 없이 그 프로그램에 로그인된 구독을 쓴다.
// 설정에서 고른 쪽을 쓴다: Codex CLI(ChatGPT 구독) 또는 Claude Code(Claude 구독).
// 다른 프로그램을 실행하는 기능
import { spawn } from 'node:child_process';
// 파일 확인·읽기·쓰기, 임시 폴더, 컴퓨터 정보, 경로를 다루는 기능
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 이 프로그램이 들어 있는 폴더 (lib 폴더의 한 칸 위)
const decodedRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 윈도우에서는 설치 프로그램이 넣어 주는 claude.exe를 직접 쓴다. npm으로 설치한 claude.cmd는 이 방식으로 실행되지 않는다.
const WIN_CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
// 쓸 claude 프로그램: .env의 CLAUDE_BIN이 있으면 그것, 윈도우에 claude.exe가 있으면 그것, 아니면 그냥 claude
const claudeBin = () => process.env.CLAUDE_BIN || (process.platform === 'win32' && existsSync(WIN_CLAUDE) ? WIN_CLAUDE : 'claude');

// 아래 SCHEMA에서 되풀이해 쓰는 형식: 글자, 숫자(모르면 null), 글자 목록
const str = { type: 'string' };
const nullableNum = { type: ['number', 'null'] };
const list = { type: 'array', items: str };

// AI가 돌려줘야 하는 답의 모양. 여기 적힌 항목을 빠짐없이, 정해진 형식으로 채워야 한다
export const SCHEMA = {
  type: 'object',
  // 여기에 없는 항목은 넣지 못하게 한다
  additionalProperties: false,
  // 반드시 있어야 하는 항목들
  required: [
    'title', 'summary', 'region', 'job_type', 'job_category', 'volume_text', 'load_tons', 'workers', 'vehicles',
    'ladder_needed', 'ladder_hours', 'night', 'unknowns', 'photo_observations', 'estimate_ready', 'risk_level',
    'review_reasons', 'reply_need_info', 'reply_with_estimate',
  ],
  // 항목마다의 형식과 뜻
  properties: {
    title: { ...str, description: '목록에 보일 짧은 제목. 예: 평택 안중읍 34평 청소·곰팡이' },
    summary: { ...str, description: '① 고객 요청 요약' },
    region: { ...str, description: '② 지역. 모르면 "미확인"' },
    job_type: { ...str, description: '③ 작업 종류' },
    // 작업 분류: 소형 수거, 일반 수거, 청소, 섞인 작업, 업무 아님
    job_category: { type: 'string', enum: ['waste_small', 'waste_general', 'cleaning', 'mixed', 'other'] },
    volume_text: { ...str, description: '④ 예상 폐기물 양과 그 근거. 해당 없으면 "해당 없음"' },
    load_tons: { ...nullableNum, description: '1톤 차량 기준 적재 비율. 판단 불가면 null' },
    workers: { ...nullableNum, description: '⑤ 필요한 인원. 판단 불가면 null' },
    vehicles: { ...nullableNum, description: '⑥ 1톤 차량 대수. 판단 불가면 null' },
    ladder_needed: { type: 'string', enum: ['yes', 'no', 'unknown'], description: '⑦ 사다리차 필요 여부' },
    // 사다리차를 쓰는 시간. 모르면 null
    ladder_hours: nullableNum,
    night: { type: 'string', enum: ['yes', 'no', 'unknown'], description: '⑧ 야간 여부' },
    unknowns: { ...list, description: '⑨ 추가로 확인해야 할 사항' },
    photo_observations: { ...list, description: '사진에서 본 것. 사진이 없으면 빈 배열' },
    estimate_ready: { type: 'boolean', description: '차량·인원·양이 견적을 낼 만큼 확인됐는가' },
    // 위험도: 일반, 확인 필요, 사장님 검토 필수
    risk_level: { type: 'string', enum: ['low', 'review', 'high'] },
    // 사장님이 검토해야 하는 사유들
    review_reasons: list,
    // 정보를 더 묻는 답변
    reply_need_info: str,
    // 견적을 안내하는 답변. 금액 자리는 {{견적}}으로 남긴다
    reply_with_estimate: str,
  },
};

// 채팅 자동 응대에서 AI가 돌려줘야 하는 답의 모양
export const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'region', 'service', 'summary', 'send', 'skip_reason', 'reply'],
  properties: {
    title: { ...str, description: '목록에 보일 짧은 제목. 예: 수원 영통 32평 거주 청소' },
    region: { ...str, description: '지역. 모르면 "미확인"' },
    service: { ...str, description: '고객이 요청한 서비스. 예: 거주 청소' },
    summary: { ...str, description: '고객이 요청서와 채팅에 남긴 내용 요약' },
    send: { type: 'boolean', description: '첫 응대 메시지를 지금 보내도 되는가' },
    skip_reason: { ...str, description: 'send가 false면 그 사유, true면 빈 글' },
    reply: { ...str, description: '고객에게 보낼 첫 응대 메시지' },
  },
};

// 일의 종류마다 쓰는 업무 규칙 파일과 답의 모양: quote(문의 분석과 견적), chat(채팅 첫 응대)
const KINDS = { quote: { prompt: 'prompt.md', schema: SCHEMA }, chat: { prompt: 'prompt-chat.md', schema: CHAT_SCHEMA } };

// AI에게 줄 글을 만든다. 문의에 쌓인 글과 사진을 주고받은 순서대로, 누가 쓴 것인지 표시해 늘어놓는다
function buildPrompt(inquiry) {
  const lines = ['아래는 숨고 문의 한 건의 전체 기록이다. 규칙에 따라 분석하고 답변 초안을 작성하라.', ''];
  // 글 하나마다 번호, 누가 썼는지, 시각을 적고 그 안에 본문과 사진 파일 이름을 넣는다
  inquiry.messages.forEach((m, i) => {
    const who = { owner: '사장님이 보낸 답변/메모', room: '숨고 채팅방 화면에서 읽은 글(요청서와 지금까지의 대화)' }[m.from] || '고객 문의·답장';
    lines.push(`<기록 번호="${i + 1}" 구분="${who}" 시각="${m.at}">`);
    if (m.text) lines.push(m.text);
    for (const f of m.images || []) lines.push(`[사진 파일: ./${f}]`);
    lines.push('</기록>', '');
  });
  return lines.join('\n');
}

// AI 프로그램을 실행하고 표준 출력을 돌려준다. name은 오류 문구에 쓴다.
function run(name, command, args, input, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    // 프로그램을 실행한다. cwd는 실행할 폴더(문의 폴더)다
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // 프로그램이 내놓는 글과 오류 글을 모아 둘 곳
    let out = '';
    let err = '';
    // 정해 둔 시간(5분)이 지나도 끝나지 않으면 강제로 끄고 오류로 알린다
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('AI 분석 시간이 초과되었습니다.'));
    }, timeoutMs);
    // 프로그램이 글을 내놓을 때마다 모은다
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // 프로그램을 실행조차 못 했을 때 (설치돼 있지 않은 경우 등)
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${name}를 실행하지 못했습니다: ${e.message}`));
    });
    // 프로그램이 끝났을 때: 오류로 끝났으면 오류 글의 끝부분 500자를, 잘 끝났으면 내놓은 글을 돌려준다
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${name} 오류(${code}): ${(err || out).trim().slice(-500)}`));
      resolve(out);
    });
    // 준비한 글(문의 내용)을 프로그램에 넣어 주고 입력을 닫는다
    child.stdin.end(input);
  });
}

// AI가 내놓은 글에서 첫 { 부터 마지막 } 까지를 떼어 내 분석 결과로 바꾼다 (앞뒤에 다른 말이 붙어 있어도 되게)
function parseResult(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('AI 응답에서 분석 결과를 찾지 못했습니다.');
  return JSON.parse(text.slice(start, end + 1));
}

// Claude Code(Claude 구독)로 분석한다. 사진은 Claude가 Read 도구로 직접 연다.
async function analyzeWithClaude(inquiry, inquiryDir, system, schema) {
  // claude에 주는 옵션: 화면 없이 한 번만 답하기, 답을 JSON으로, 업무 규칙, 답의 모양, 다른 연결 도구 끄기, 대화 기록 남기지 않기, 파일 읽기 도구만 허용
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
    '--strict-mcp-config',
    '--no-session-persistence',
    '--allowedTools', 'Read',
    '--tools', 'Read',
  ];
  // .env에 CLAUDE_MODEL이 있으면 그 모델을 쓴다
  if (process.env.CLAUDE_MODEL) args.unshift('--model', process.env.CLAUDE_MODEL);

  // 문의 폴더에서 실행하고 5분까지 기다린다
  const raw = await run('Claude Code', claudeBin(), args, buildPrompt(inquiry), inquiryDir, 5 * 60 * 1000);
  // claude가 준 결과 묶음을 풀어 본다. 오류 표시가 있으면 실패로 처리하고, 없으면 정해진 모양의 분석 결과를 꺼낸다
  const envelope = JSON.parse(raw);
  if (envelope.is_error) throw new Error(`AI 분석 실패: ${String(envelope.result).slice(0, 300)}`);
  return envelope.structured_output || parseResult(String(envelope.result || ''));
}

// 윈도우에서 npm으로 설치한 codex는 codex.cmd라서 직접 실행되지 않는다. 그 안의 codex.js를 node로 실행한다.
function codexCommand() {
  // .env에 CODEX_BIN이 있으면 그것을 쓴다
  if (process.env.CODEX_BIN) return [process.env.CODEX_BIN, []];
  // 윈도우에서 npm으로 설치한 codex.js가 있으면 node로 그 파일을 실행한다
  const winEntry = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (process.platform === 'win32' && existsSync(winEntry)) return [process.execPath, [winEntry]];
  // 그 밖에는 그냥 codex 명령을 쓴다
  return ['codex', []];
}

// Codex CLI(ChatGPT 구독)로 분석한다. 업무 규칙은 따로 넣는 자리가 없어 요청 글 앞에 붙이고, 사진은 첨부로 넘긴다.
async function analyzeWithCodex(inquiry, inquiryDir, system, schema) {
  // 답의 모양 파일과 결과 파일을 둘 임시 폴더를 만든다 (끝나면 지운다)
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ssakda-ai-'));
  try {
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'result.json');
    await writeFile(schemaFile, JSON.stringify(schema));
    // 문의에 붙은 사진 파일 이름을 모두 모은다
    const images = inquiry.messages.flatMap((m) => m.images || []);
    const [command, prefix] = codexCommand();
    // codex에 주는 옵션: 사진 첨부, 한 번만 실행하고 기록 남기지 않기, 읽기 전용, 답의 모양 파일, 마지막 답을 적을 파일, 실행할 폴더
    const args = [
      ...prefix,
      'exec',
      // 사진 옵션은 뒤따르는 값을 모두 사진으로 읽으므로, 한 장씩 넘기고 그 뒤에 다른 옵션을 둔다
      ...images.flatMap((f) => ['--image', path.join(inquiryDir, f)]),
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      '--output-schema', schemaFile,
      '--output-last-message', outFile,
      '--cd', inquiryDir,
    ];
    // .env에 CODEX_MODEL이 있으면 그 모델을 쓴다
    if (process.env.CODEX_MODEL) args.push('--model', process.env.CODEX_MODEL);
    // 사진이 있으면 첨부돼 있다는 안내를 덧붙인다
    const note = images.length ? `\n\n사진 ${images.length}장은 이 요청에 첨부되어 있다. 기록에 나온 순서와 같다. 파일을 따로 열 필요는 없다.` : '';
    // 업무 규칙(prompt.md) + 문의 내용 + 안내를 한 글로 합친다
    const prompt = `${system}\n\n---\n\n${buildPrompt(inquiry)}${note}\n\n명령을 실행하거나 파일을 고치지 말고, 분석 결과만 정해진 형식으로 답하라.`;
    // 실행하고, codex가 결과 파일에 적어 둔 답을 읽어 분석 결과로 바꾼다
    await run('Codex(ChatGPT)', command, args, prompt, inquiryDir, 5 * 60 * 1000);
    return parseResult(await readFile(outFile, 'utf8'));
  } finally {
    // 성공하든 실패하든 임시 폴더를 지운다
    await rm(tmp, { recursive: true, force: true });
  }
}

// 설정 화면에서 고를 수 있는 AI와 화면에 보이는 이름
export const PROVIDERS = { codex: 'ChatGPT (Codex)', claude: 'Claude' };

// 문의 한 건을 분석한다. provider는 설정에서 고른 AI, kind는 일의 종류(quote 문의 분석, chat 채팅 첫 응대)
export async function analyze(inquiry, inquiryDir, provider = 'codex', kind = 'quote') {
  const { prompt, schema } = KINDS[kind];
  // 업무 규칙(prompt.md, prompt-chat.md)은 분석할 때마다 새로 읽는다. 그래서 규칙을 고치면 다음 분석부터 바로 적용된다
  const system = await readFile(path.join(decodedRoot, prompt), 'utf8');
  // 고른 AI로 분석한다
  const data = provider === 'claude' ? await analyzeWithClaude(inquiry, inquiryDir, system, schema) : await analyzeWithCodex(inquiry, inquiryDir, system, schema);
  // 꼭 있어야 하는 항목이 하나라도 빠졌으면 실패로 처리한다
  for (const key of schema.required) {
    if (!(key in data)) throw new Error(`AI 응답에 ${key} 항목이 없습니다.`);
  }
  return data;
}
