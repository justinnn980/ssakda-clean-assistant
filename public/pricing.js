// 견적 계산 규칙. 서버와 승인 화면이 같은 파일을 쓴다. 금액은 AI가 아니라 이 코드가 계산한다.

// 값을 숫자로 바꾼다. 비어 있거나 숫자가 아니면 '모름'(null)으로 둔다
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// 만 원 단위로 올림한다 (예: 612,000원 → 620,000원)
const ceilMan = (won) => Math.ceil(won / 10000) * 10000;

// 사다리차 비용: 첫 1시간 금액 + 그 뒤로는 시간당 추가 금액. 30분 같은 자투리는 1시간으로 올린다. 쓰지 않으면 0원
export function ladderCost(cfg, hours) {
  const h = num(hours);
  if (!h || h <= 0) return 0;
  const p = cfg.단가표;
  return p.사다리차_첫1시간 + (Math.ceil(h) - 1) * p.사다리차_추가1시간;
}

// AI 분석 결과로 견적 입력값의 초깃값을 만든다. 모르는 값은 null로 둔다.
export function defaultInputs(cfg, a) {
  // AI가 낸 인원과 적재량(1톤 차량 기준 비율)
  const workers = num(a.workers);
  const tons = num(a.load_tons);
  // 사다리차 시간: 필요하다고 했는데 시간을 모르면 1시간, 필요 없으면 0시간
  const ladder = a.ladder_needed === 'yes' ? num(a.ladder_hours) ?? 1 : 0;
  return {
    // 1톤 차량 대수
    vehicles: num(a.vehicles),
    // 작업 인원
    workers,
    // 사다리차가 필요한지 모르면 비워 둔다
    ladderHours: a.ladder_needed === 'unknown' ? null : ladder,
    // 돈을 주고 부르는 인원: 사장님이 직접 일하면 한 명을 뺀다
    hiredWorkers: workers === null ? null : Math.max(0, workers - (cfg.원가.사장님_직접작업 ? 1 : 0)),
    // 폐기물 처리비: 적재량 × 1톤당 처리비
    disposalCost: tons === null ? null : Math.round(tons * cfg.원가.폐기물_처리비_1톤당),
    // 기름값과 식대는 config.json에 정해 둔 금액
    fuel: cfg.원가.기름값,
    meal: cfg.원가.식대,
    // 그 밖의 원가 (화면에서 직접 넣는다)
    otherCost: 0,
    // 이익률 기준: 소형 수거면 small, 그 밖에는 general
    marginType: a.job_category === 'waste_small' ? 'small' : 'general',
  };
}

// 두 방식의 예상 견적을 계산한다. 필요한 값이 비어 있으면 해당 방식은 null.
export function calc(cfg, input) {
  const p = cfg.단가표;
  // 입력값을 숫자로 바꾸고 사다리차 비용을 계산해 둔다
  const vehicles = num(input.vehicles);
  const workers = num(input.workers);
  const ladderKnown = num(input.ladderHours) !== null;
  const ladder = ladderCost(cfg, input.ladderHours);

  // 단가표 기준: 차량 대수 × 차량 단가 + 인원 × 작업자 단가 + 사다리차. 차량·인원·사다리차를 모두 알아야 계산한다
  let table = null;
  if (vehicles !== null && workers !== null && ladderKnown) {
    table = {
      min: vehicles * p.차량_1톤_최소 + workers * p.작업자_1인_최소 + ladder,
      max: vehicles * p.차량_1톤_최대 + workers * p.작업자_1인_최대 + ladder,
      ladder,
    };
  }

  // 원가 기준: 고용 인원·처리비·사다리차를 모두 알아야 계산한다
  let cost = null;
  const hired = num(input.hiredWorkers);
  const disposal = num(input.disposalCost);
  if (hired !== null && disposal !== null && ladderKnown) {
    // 총원가 = 고용 인건비 + 처리비 + 기름값 + 식대 + 기타 + 사다리차
    const total =
      hired * cfg.원가.고용_인건비_1인 + disposal + (num(input.fuel) ?? 0) + (num(input.meal) ?? 0) + (num(input.otherCost) ?? 0) + ladder;
    // 이익률: 소형 수거는 25~30%, 일반 작업은 40%
    const m = cfg.이익률;
    const [lo, hi] = input.marginType === 'small' ? [m.소형_최소, m.소형_최대] : [m.일반, m.일반];
    cost = {
      total,
      marginMin: lo,
      marginMax: hi,
      // 받을 금액 = 총원가 ÷ (1 − 이익률), 만 원 단위로 올림
      min: ceilMan(total / (1 - lo)),
      max: ceilMan(total / (1 - hi)),
      ladder,
    };
  }
  return { table, cost };
}

// 숫자를 "350,000원"처럼 적는다. 값이 없으면 "-"
export function won(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

// 고객에게 보내는 답변에 넣는 금액 표기. 예: 65만~80만 원
// 만 원으로 떨어지면 "65만", 아니면 "655,000"처럼 적는다
const manText = (n) => (n % 10000 === 0 ? `${(n / 10000).toLocaleString('ko-KR')}만` : n.toLocaleString('ko-KR'));
// 최소와 최대가 같으면 금액 하나만, 다르면 "최소~최대 원"으로 적는다
export const customerPrice = (r) => (r.min === r.max ? `${manText(r.min)} 원` : `${manText(r.min)}~${manText(r.max)} 원`);

// 사장님 화면과 알림에 쓰는 금액 표기. 예: 650,000원 ~ 800,000원. 계산되지 않았으면 "현장 확인 필요"
export function rangeText(r) {
  if (!r) return '현장 확인 필요';
  return r.min === r.max ? won(r.min) : `${won(r.min)} ~ ${won(r.max)}`;
}
