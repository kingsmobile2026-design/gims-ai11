'use strict';
// 사용자 요청 예측 도구 (통계·규칙 기반, 외부 호출 없음)
//  - classify: 요청의 의도 분류 (키워드 가중치 점수)
//  - predict_next_request: 지난 요청들의 의도 순서로 1차 마르코프 전이 확률 계산 (라플라스 평활 + 전체 빈도 혼합)
//  - predict_followups: 현재 요청에서 이어질 가능성이 높은 후속 요청 후보 순위화
//  - 의도별로 미리 준비해 둘 추론 도구 그룹(prefetch) 제안
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const OBJ = (properties, required) => ({ type: 'OBJECT', properties, required });
const STR_LIST = description => ({ type: 'ARRAY', items: { type: 'STRING' }, description });

const INTENTS = {
  math:     { '계산': 2, '방정식': 3, '적분': 3, '미분': 3, '확률': 3, '행렬': 3, '수학': 3, '소수': 2, '최대공약수': 3, '공식': 2, 'integral': 3, 'derivative': 3, 'equation': 3, 'solve': 2, 'math': 2, 'prime': 2, 'factorial': 2 },
  coding:   { '코드': 3, '함수': 2, '버그': 3, '에러': 2, '오류': 1, '컴파일': 3, '구현': 2, '알고리즘': 2, '리팩터': 3, '테스트': 2, '시간복잡도': 3, 'python': 3, 'javascript': 3, 'typescript': 3, 'java': 2, 'code': 3, 'function': 2, 'bug': 3, 'class': 2, 'compile': 3, 'refactor': 3, 'algorithm': 2, 'debug': 3, 'node': 2, 'express': 2 },
  data:     { '데이터': 3, 'csv': 3, '엑셀': 2, '집계': 3, '그룹': 2, '평균': 2, '통계': 3, '피벗': 3, '데이터셋': 3, '상관': 3, '이상치': 3, '시계열': 3, '결측': 3, 'dataset': 3, 'pivot': 3, 'aggregate': 2, 'json': 2, 'excel': 2, 'outlier': 3, 'missing': 2 },
  bigdata:  { '빅데이터': 3, '대용량': 3, '스트림': 3, '고유 개수': 3, '샘플링': 3, '분위수': 3, '근사': 2, 'big data': 3, 'hyperloglog': 3, 'bloom': 3, 'billion': 2, 'stream': 2, 'sketch': 3 },
  github:   { 'github': 3, '깃허브': 3, '레포': 3, '이슈': 2, '커밋': 3, 'pull request': 3, 'repo': 3, 'issue': 2, 'commit': 2, '풀리퀘스트': 3 },
  game:     { '게임': 3, '퍼즐': 2, '보드': 2, '캔버스': 2, '플레이어': 2, '레벨': 2, 'game': 3, 'canvas': 2, 'player': 2, 'level': 2 },
  writing:  { '글': 2, '작성': 3, '요약': 3, '번역': 3, '이메일': 3, '보고서': 3, '문장': 2, '에세이': 3, 'write': 3, 'summar': 3, 'translate': 3, 'essay': 2, 'email': 3 },
  security: { '보안': 3, '취약': 3, '해킹': 2, '인젝션': 3, '비밀번호': 2, 'xss': 3, 'security': 3, 'vulnerab': 3, 'injection': 3, 'secret': 2 },
  factual:  { '누구': 2, '언제': 2, '어디': 2, '무엇': 2, '최신': 3, '현재': 2, '뉴스': 3, '가격': 2, '날씨': 3, 'who': 2, 'when': 2, 'where': 2, 'latest': 3, 'news': 3, 'price': 2 }
};
const INTENT_LIST = [...Object.keys(INTENTS), 'other'];

// 의도 → 미리 준비할 추론 도구 그룹
const INTENT_GROUPS = {
  math: ['math'], coding: ['coding'], data: ['data'], bigdata: ['bigdata', 'data'],
  github: ['external'], game: ['coding'], writing: [], security: ['coding'], factual: [], other: []
};

const FOLLOW = {
  coding: ['이 코드의 시간 복잡도는?', '테스트 케이스를 추가해줘', '보안 취약점이 있는지 점검해줘', '엣지 케이스를 정리해줘', '더 간단하게 리팩터링해줘', '에러 원인을 단계별로 설명해줘'],
  math: ['풀이를 단계별로 검산해줘', '다른 방법으로도 확인해줘', '숫자를 바꿔서 같은 유형 문제를 만들어줘', '그래프로 보여줘'],
  data: ['이상치가 있는지 확인해줘', '결측값을 채워줘', '그룹별로 다시 집계해줘', '상관관계를 계산해줘', '시간에 따른 추세를 보여줘'],
  bigdata: ['고유 개수를 근사해줘', '상위 빈도 항목을 뽑아줘', '샘플링해서 요약해줘', '분위수를 계산해줘'],
  github: ['최근 이슈를 요약해줘', '해당 파일 내용을 보여줘', '최근 커밋 흐름을 정리해줘'],
  game: ['게임 규칙을 점검해줘', 'AI 상대를 더 강하게 만들어줘', '난이도 곡선을 조정해줘', '모바일에서도 되게 해줘'],
  writing: ['더 짧게 줄여줘', '존댓말로 바꿔줘', '핵심만 세 줄로 요약해줘'],
  security: ['수정 코드를 보여줘', '다른 취약점도 있는지 확인해줘'],
  factual: ['출처를 알려줘', '최신 정보로 다시 확인해줘', '더 자세히 설명해줘'],
  other: ['더 자세히 설명해줘', '예시를 들어줘']
};

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASCII_KW = /^[a-z0-9 .+\-#]+$/;
function countHits(text, kw) {
  const t = text.toLowerCase();
  if (ASCII_KW.test(kw)) {
    return (t.match(new RegExp(`(?:^|[^a-z0-9])${esc(kw)}(?=$|[^a-z0-9])`, 'g')) || []).length;
  }
  return t.split(kw.toLowerCase()).length - 1;
}

function classify(text) {
  const s = String(text || '').slice(0, 4000);
  const scores = {};
  for (const [intent, kws] of Object.entries(INTENTS)) {
    let sc = 0;
    for (const [kw, w] of Object.entries(kws)) sc += w * countHits(s, kw);
    scores[intent] = sc;
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  if (!total) return { intent: 'other', confidence: 0, scores };
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return { intent: top[0], confidence: Number((top[1] / total).toFixed(3)), scores };
}

function groupsFor(intent, level) {
  const g = [...(INTENT_GROUPS[intent] || [])];
  if (intent === 'coding' && level && level.refute) g.push('sandbox');
  return g;
}

const IMPL = {};

IMPL.intent_classify = ({ text }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 는 비어 있지 않은 문자열이어야 합니다');
  const r = classify(text);
  return { intent: r.intent, confidence: r.confidence, prefetchGroups: INTENT_GROUPS[r.intent] || [] };
};

IMPL.predict_next_request = ({ history = [], top = 3 }) => {
  if (!Array.isArray(history)) throw new Error('history 는 문자열 배열이어야 합니다');
  const labels = history.slice(-500).map(h => classify(String(h)).intent);
  const K = INTENT_LIST.length, alpha = 0.5, n = labels.length;
  const freq = Object.fromEntries(INTENT_LIST.map(s => [s, 0]));
  for (const l of labels) freq[l]++;
  const globalP = s => (freq[s] + alpha) / (n + alpha * K);
  const T = Object.fromEntries(INTENT_LIST.map(s => [s, Object.fromEntries(INTENT_LIST.map(t => [t, 0]))]));
  for (let i = 0; i + 1 < labels.length; i++) T[labels[i]][labels[i + 1]]++;
  const last = n ? labels[n - 1] : null;
  const row = last ? T[last] : null;
  const rowTotal = row ? Object.values(row).reduce((a, b) => a + b, 0) : 0;
  const lambda = rowTotal / (rowTotal + 5);   // 이 의도 뒤의 관측이 많을수록 전이 확률을 더 믿는다
  const probs = INTENT_LIST.map(s => {
    const rowP = row ? (row[s] + alpha) / (rowTotal + alpha * K) : globalP(s);
    return { intent: s, probability: Number((lambda * rowP + (1 - lambda) * globalP(s)).toFixed(4)) };
  }).sort((a, b) => b.probability - a.probability);
  const N = Math.min(Math.max(1, Number(top) || 3), INTENT_LIST.length);
  const predictions = probs.slice(0, N).map(p => ({ ...p, prefetchGroups: INTENT_GROUPS[p.intent] || [] }));
  return {
    observed: n, lastIntent: last,
    basis: n === 0 ? '기록 없음: 균등 분포' : rowTotal ? `마지막 의도(${last}) 뒤의 전이 ${rowTotal}회 기반` : '전체 빈도 기반 (전이 기록 부족)',
    predictions,
    note: '통계적 추정이며 실제 요청과 다를 수 있습니다. prefetchGroups 는 미리 준비해 둘 도구 그룹입니다'
  };
};

IMPL.predict_followups = ({ text, top = 5 }) => {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 는 비어 있지 않은 문자열이어야 합니다');
  const c = classify(text);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(t => t.length >= 2));
  const cands = [];
  for (const [intent, list] of Object.entries(FOLLOW)) {
    const base = intent === c.intent ? Math.max(0.3, c.confidence) : 0.1;
    for (const q of list) {
      const qt = q.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(t => t.length >= 2);
      const overlap = qt.filter(t => tokens.has(t)).length;
      cands.push({ question: q, intent, score: Number((base + 0.05 * overlap).toFixed(3)) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const N = Math.min(Math.max(1, Number(top) || 5), 10);
  return { currentIntent: c.intent, followups: cands.slice(0, N), note: '의도별 템플릿 기반 후보입니다' };
};

const DECL = [
  { name: 'intent_classify', description: '사용자 요청의 의도(수학, 코딩, 데이터, 빅데이터, GitHub, 게임, 글쓰기, 보안, 사실 질문, 기타)를 분류하고 미리 준비할 도구 그룹을 알려준다.',
    parameters: OBJ({ text: S('STRING', '분류할 사용자 요청') }, ['text']) },
  { name: 'predict_next_request', description: '지난 요청들의 의도 순서로 다음 요청의 의도 확률을 추정한다. 미리 준비할 도구 그룹을 제안.',
    parameters: OBJ({ history: STR_LIST('지난 사용자 요청들 (오래된 순)'), top: S('INTEGER', '상위 개수 (1~10)') }, ['history']) },
  { name: 'predict_followups', description: '현재 요청 다음에 나올 가능성이 높은 후속 요청 후보를 점수순으로 보여준다.',
    parameters: OBJ({ text: S('STRING', '현재 사용자 요청'), top: S('INTEGER', '후보 개수 (1~10)') }, ['text']) }
];

module.exports = { DECL, IMPL, classify, groupsFor, INTENT_GROUPS };
