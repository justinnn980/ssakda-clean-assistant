// 견적 계산 규칙. 서버와 승인 화면이 같은 파일을 쓴다. 금액은 AI가 아니라 이 코드가 계산한다.

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const ceilMan = (won) => Math.ceil(won / 10000) * 10000;

export function ladderCost(cfg, hours) {
  const h = num(hours);
  if (!h || h <= 0) return 0;
  const p = cfg.단가표;
  return p.사다리차_첫1시간 + (Math.ceil(h) - 1) * p.사다리차_추가1시간;
}

// AI 분석 결과로 견적 입력값의 초깃값을 만든다. 모르는 값은 null로 둔다.
export function defaultInputs(cfg, a) {
  const workers = num(a.workers);
  const tons = num(a.load_tons);
  const ladder = a.ladder_needed === 'yes' ? num(a.ladder_hours) ?? 1 : 0;
  return {
    vehicles: num(a.vehicles),
    workers,
    ladderHours: a.ladder_needed === 'unknown' ? null : ladder,
    hiredWorkers: workers === null ? null : Math.max(0, workers - (cfg.원가.사장님_직접작업 ? 1 : 0)),
    disposalCost: tons === null ? null : Math.round(tons * cfg.원가.폐기물_처리비_1톤당),
    fuel: cfg.원가.기름값,
    meal: cfg.원가.식대,
    otherCost: 0,
    marginType: a.job_category === 'waste_small' ? 'small' : 'general',
  };
}

// 두 방식의 예상 견적을 계산한다. 필요한 값이 비어 있으면 해당 방식은 null.
export function calc(cfg, input) {
  const p = cfg.단가표;
  const vehicles = num(input.vehicles);
  const workers = num(input.workers);
  const ladderKnown = num(input.ladderHours) !== null;
  const ladder = ladderCost(cfg, input.ladderHours);

  let table = null;
  if (vehicles !== null && workers !== null && ladderKnown) {
    table = {
      min: vehicles * p.차량_1톤_최소 + workers * p.작업자_1인_최소 + ladder,
      max: vehicles * p.차량_1톤_최대 + workers * p.작업자_1인_최대 + ladder,
      ladder,
    };
  }

  let cost = null;
  const hired = num(input.hiredWorkers);
  const disposal = num(input.disposalCost);
  if (hired !== null && disposal !== null && ladderKnown) {
    const total =
      hired * cfg.원가.고용_인건비_1인 + disposal + (num(input.fuel) ?? 0) + (num(input.meal) ?? 0) + (num(input.otherCost) ?? 0) + ladder;
    const m = cfg.이익률;
    const [lo, hi] = input.marginType === 'small' ? [m.소형_최소, m.소형_최대] : [m.일반, m.일반];
    cost = {
      total,
      marginMin: lo,
      marginMax: hi,
      min: ceilMan(total / (1 - lo)),
      max: ceilMan(total / (1 - hi)),
      ladder,
    };
  }
  return { table, cost };
}

export function won(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

export function rangeText(r) {
  if (!r) return '현장 확인 필요';
  return r.min === r.max ? won(r.min) : `${won(r.min)} ~ ${won(r.max)}`;
}
