/**
 * reasoning.js — 코드 주도 추론 엔진 v4 (Gemini API 전용)
 *
 * 프롬프트로 "생각해 줘"라고 부탁하는 대신, 추론의 단계·순서·분기·재시도를 이 파일의 코드가 직접 결정하고
 * 각 단계마다 Gemini를 호출한다.
 *
 *   ① 분석(구조화 JSON)            : 유형·난이도·함정을 스키마로 받는다
 *   ② 풀이 (시드 고정 샘플링)       : 전략별 풀이를 병렬 생성. 앞의 2개가 일치하면 나머지는 생략(신뢰도 기반 스케줄링)
 *   ③ 합의도 계산                  : 정규화한 결론을 코드로 비교
 *   ④ 검증
 *        - 코드 문제: Gemini 코드 실행 도구로 실제 테스트를 돌린 뒤 판정
 *        - 그 밖: 구조화된 비평가 호출
 *   ⑤ 반박 (선택)                  : 결론을 무너뜨릴 반례를 찾는다
 *   ⑥ 오류 수정 루프 (선택)         : 검증·반박 결과를 입력으로 재풀이
 *   ⑦ 최종 답용 contents 구성       : server.js가 이 contents로 스트리밍 응답을 만든다
 *
 * DeepInfer에서 가져온 아이디어
 *   - Structured outputs(so_args json schema) → Gemini responseSchema로 형식을 API 레벨에서 강제
 *   - seq_seed 고정 샘플링 → 질문마다 고정 seed로 재현 가능한 풀이
 *   - Confidence-scheduled verification → 합의가 높으면 추가 계산을 쓰지 않고, 낮을 때만 검증·반박 예산을 쓴다
 */
'use strict';
const crypto = require('crypto');
const TOOLS = require('./tool_registry');

// 추론 정도. cost = 하루 질문 한도에서 차감되는 횟수, budget = Gemini 사고 토큰 예산
const LEVELS = {
  // 생각(다단계 추론)은 유지하되, 호출 수·사고토큰·타임아웃을 줄여 체감 속도를 올린다
  low:    { label: '낮음', samples: 1, plan: false, refute: false, revise: 0, budget: 0,    cost: 2, timeout: 20_000, desc: '빠른 풀이 1회 + 짧은 검증' },
  medium: { label: '보통', samples: 1, plan: false, refute: false, revise: 0, budget: 512,  cost: 3, timeout: 35_000, desc: '풀이 1회 + 검증 (분석 생략으로 속도 우선)' },
  high:   { label: '높음', samples: 2, plan: true,  refute: false, revise: 0, budget: 1024, cost: 5, timeout: 55_000, desc: '짧은 분석 + 풀이 최대 2회 + 검증' },
  max:    { label: '최대', samples: 2, plan: true,  refute: true,  revise: 1, budget: 2048, cost: 7, timeout: 80_000, desc: '분석 + 풀이 2회 + 검증·반박 + 수정 1회' }
};
const info = () => Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, { label: v.label, cost: v.cost, desc: v.desc }]));

const TEMPS = [0.2, 0.5, 0.8, 0.35, 0.6];
const HARD_GRACE_MS = 6_000;    // 선택 단계 마감 뒤 대기 (짧게)
const MIN_STAGE_MS = 5_000;     // 남은 시간이 이보다 적으면 추가 단계 생략
const SEED_MOD = 2147483647;    // Gemini seed는 int32 범위

const STRATEGIES = [
  { n: '직접 풀이',   p: '가장 표준적인 방법으로 조건을 빠짐없이 반영해 단계별로 푼다.' },
  { n: '역방향 검산', p: '결론을 가정하고 거꾸로 따져 보며 푼다. 답이 나오면 원래 조건에 다시 대입해 확인한다.' },
  { n: '반례 탐색',   p: '일반적인 답이 깨지는 경계·예외·반례를 먼저 찾아본 뒤, 그것까지 통과하는 답을 구한다.' },
  { n: '다른 관점',   p: '앞의 접근과 완전히 다른 방법(다른 공식·다른 알고리즘·다른 논증)으로 푼다.' },
  { n: '함정 회피',   p: '이 유형에서 흔한 오답과 함정을 먼저 3개 나열하고, 각각을 피하는지 확인하며 푼다.' }
];

const CODE_RE = /```|코드|함수|구현|버그|에러|컴파일|스크립트|알고리즘|정규식|python|javascript|typescript|java|c\+\+|sql|regex|function|class|\bdef\b|\bapi\b/i;

// ---------- 구조화 출력 스키마 (형식을 프롬프트가 아니라 API가 강제) ----------
const STR = { type: 'STRING' }, INT = { type: 'INTEGER' }, BOOL = { type: 'BOOLEAN' };
const STR_ARR = { type: 'ARRAY', items: STR };
const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['수학', '코드', '논리', '사실', '글쓰기', '기타'] },
    difficulty: { type: 'STRING', enum: ['쉬움', '보통', '어려움'] },
    key_question: STR, approach: STR, pitfalls: STR_ARR
  },
  required: ['kind', 'difficulty', 'key_question', 'approach', 'pitfalls']
};
const DRAFT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    steps: STR_ARR, answer: STR, final: STR, code: STR, self_check: STR_ARR, confidence: INT
  },
  required: ['steps', 'answer', 'final', 'confidence']
};
const CRITIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['OK', 'FIX'] },
    confidence: INT, correct_answer: STR, errors: STR_ARR, must_include: STR_ARR
  },
  required: ['verdict', 'confidence', 'correct_answer', 'errors']
};
const REFUTE_SCHEMA = {
  type: 'OBJECT',
  properties: { broken: BOOL, counterexample: STR, evidence: STR },
  required: ['broken', 'evidence']
};

// ---------- 시스템 지시 (역할만 짧게. 단계 순서는 코드가 정한다) ----------
const PLAN_SYS = '질문을 분류하고 핵심과 함정을 정리하라. 유형은 수학·코드·논리·사실·글쓰기·기타 중 하나.';
const DRAFT_SYS = '너는 신중한 해결사다. 조건을 빠짐없이 반영해 단계별로 풀고, 결론을 다른 방법으로 한 번 더 확인한 뒤 답하라. final은 결론을 비교 가능한 한 줄(40자 이내)로 쓴다.';
const CRITIC_SYS = '너는 엄격한 검증자다. 풀이를 믿지 말고 계산·사실·논리를 처음부터 다시 확인하라. 결론이 갈리면 스스로 풀어 어느 쪽이 맞는지 판정하라. 다수결로 맞다고 보지 마라.';
const REFUTE_SYS = '너는 반박 전문가다. 가장 유력한 결론을 무너뜨릴 반례·계산 오류·빠뜨린 조건을 찾아라. 실제로 확인되는 문제만 broken=true로 보고하라.';
const FIX_SYS = DRAFT_SYS + ' 주어진 검증·반박이 지적한 오류를 모두 바로잡아 처음부터 다시 풀어라.';
const EXEC_VERIFY_SYS = '너는 코드 검증자다. 후보 코드를 Python 하네스로 작성해 실행하라. 후보가 Python이 아니면 같은 로직을 Python으로 옮겨 실행하라. 정상·경계·오류 입력을 최소 3개 넣고 기대값과 비교하라. 마지막에 PASS 또는 FAIL과 실패한 입력을 요약하라.';
const CODE_RULES = '[코드 규칙] 요구사항·입출력·예외·복잡도 목표를 먼저 정하고, 완성된 실행 가능 코드(import 포함, 생략 표기 금지)를 code 필드에 넣어라. 흔한 버그(off-by-one, 빈 입력/null, 정수 오버플로, 가변 기본 인자, 공유 상태, await 누락, 타입 불일치)를 self_check에 점검 결과로 남겨라.';
const CODE_CRITIC_EXTRA = ' 코드라면 실행 검증 로그를 근거로 판정하고, 로그가 없거나 FAIL이면 FIX로 판정하라.';
const CODE_REFUTE_EXTRA = ' 코드라면 실패를 일으키는 구체적 입력을 찾아 그 입력에서 동작을 한 단계씩 추적하라.';
const FINAL_SYSTEM = `질문 끝에 [내부 검증 자료]가 붙어 있으면 그것을 참고해서 가장 정확한 최종 답을 써.
- 자료의 존재, 초안, 검증 과정은 절대 언급하지 마. 핵심 결론부터 말해.
- 풀이가 갈렸다면 검증 결과를 따르고, 확신도가 60 미만이거나 반박이 인정된 부분은 불확실하다고 솔직히 밝혀.
- 코드는 검증에서 지적된 문제를 모두 반영한 완성본으로 준다. 실행 검증 결과가 PASS인 코드를 우선한다.`;

// ---------- 유틸 ----------
const TOOL_CHECK_SYS = '너는 검증 담당이다. 제공된 도구로 후보 답의 핵심 계산과 검사를 직접 수행하라. 도구 결과와 후보가 일치하면 OK, 다르면 올바른 값과 이유를 적어라. 3줄 이내로 답하라.';
const textOf = c => (c.parts || []).map(p => p.text || '').join('');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + ' …(생략)' : (s || ''));
const tailClip = (s, n) => (s.length > n ? '…(앞부분 생략)\n' + s.slice(-n) : s);
const brief = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});
const seedOf = (s, i) => (parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16) + i * 7919) % SEED_MOD;
const parseJSON = t => {
  const m = String(t).match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : t); } catch { return null; }
};

// Gemini 응답 파트 → 텍스트 (코드 실행 파트도 로그로 펼친다)
const partsText = parts => parts.filter(p => !p.thought).map(p => {
  if (typeof p.text === 'string') return p.text;
  if (p.executableCode) return `[실행 코드]\n\`\`\`python\n${p.executableCode.code}\n\`\`\`\n`;
  if (p.codeExecutionResult) return `[실행 결과: ${p.codeExecutionResult.outcome}]\n${p.codeExecutionResult.output || ''}\n`;
  return '';
}).join('').trim();

// 사고 예산을 거부하는 모델은 'thinking' 관련 400일 때만 기억해 둔다
const noBudget = new Set();

async function gen({ base, key, model, contents, system, temperature, seed, signal, budget, schema, tools }) {
  const useBudget = budget && !noBudget.has(model) ? budget : 0;

  const post = async b => {
    for (let i = 0; ; i++) {
      const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          ...(tools ? { tools } : {}),
          generationConfig: {
            temperature,
            maxOutputTokens: Math.min(4096, (b || 0) + 2048),
            ...(seed != null ? { seed } : {}),
            ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
            ...(b ? { thinkingConfig: { thinkingBudget: b } } : {})
          }
        })
      });
      if (r.ok) return r.json();
      const bodyText = await r.text().catch(() => '');
      if ((r.status === 429 || r.status >= 500) && i < 2) {
        await sleep(400 * 2 ** i + Math.random() * 200, signal);
        continue;
      }
      const e = new Error(`Gemini ${r.status}`);
      e.status = r.status; e.body = bodyText;
      throw e;
    }
  };

  let j;
  try {
    j = await post(useBudget);
  } catch (e) {
    if (e.status === 400 && useBudget) {
      if (/thinking/i.test(e.body || '')) noBudget.add(model);
      j = await post(0);
    } else throw e;
  }
  const cand = (j.candidates || [])[0];
  const text = partsText(cand?.content?.parts || []);
  if (!text) { const e = new Error('empty response'); e.empty = true; throw e; }
  return text;
}

// 구조화 호출: 스키마를 통과한 JSON만 돌려준다
async function ask(opts, schema) {
  const t = await gen({ ...opts, schema });
  const j = parseJSON(t);
  if (!j) throw new Error('구조 파싱 실패');
  return j;
}

async function deepseek(contents, signal) {
  const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
  const DS_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
  const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
  const messages = contents.slice(-10).map(c => ({ role: c.role === 'model' ? 'assistant' : 'user', content: textOf(c) })).filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
  const r = await fetch(`${DS_BASE}/chat/completions`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: DS_MODEL, messages })
  });
  if (!r.ok) throw new Error('DeepSeek ' + r.status);
  const m = (await r.json()).choices?.[0]?.message;
  return m ? { reasoning: m.reasoning_content || '', answer: m.content || '' } : null;
}

// 합의도: 정규화한 한 줄 결론을 코드로 비교
const norm = s => String(s || '').toLowerCase().replace(/[\s.,!?'"`~*_()\[\]{}:;·。，、]/g, '');
function vote(ds) {
  const groups = new Map();
  for (const d of ds) { const k = norm(d.final); if (k) groups.set(k, [...(groups.get(k) || []), d]); }
  if (!groups.size) return null;
  const sorted = [...groups.values()].sort((x, y) => y.length - x.length);
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  return { top: sorted[0], topFinal: sorted[0][0].final, size: sorted[0].length, total, others: sorted.slice(1).map(g => g[0].final) };
}

function stepper(onStep) {
  const t0 = {};
  const emit = o => { try { onStep && onStep(o); } catch {} };
  return {
    start(id, label, detail) { t0[id] = Date.now(); emit({ id, label, state: 'start', detail }); },
    done(id, detail, label) { emit({ id, label, state: 'done', ms: Date.now() - (t0[id] || Date.now()), detail }); }
  };
}

const planText = p => `유형: ${p.kind} · 난이도: ${p.difficulty}\n핵심: ${p.key_question}\n접근: ${p.approach}\n주의: ${(p.pitfalls || []).join(' / ')}`;
const draftText = (d, i) => `### ${d.fixed ? '수정본' : '풀이'} ${i + 1}${d.strategy ? ' (' + d.strategy + ')' : ''}\n[단계]\n${clip((d.steps || []).map((s, k) => `${k + 1}. ${s}`).join('\n'), 3000)}\n[답]\n${clip(d.answer, 2500)}${d.code ? `\n[코드]\n${clip(d.code, 3000)}` : ''}\n[자가점검] ${(d.self_check || []).join(' / ')}\n[결론] ${d.final}`;
const critText = c => c ? [`판정: ${c.verdict} · 확신도 ${c.confidence}%`, `올바른 결론: ${c.correct_answer}`, ...(c.errors || []).map(e => `- 오류: ${e}`), ...(c.must_include || []).map(m => `- 포함: ${m}`)].join('\n') : '';
const refText = r => r ? `반박: ${r.broken ? '성공' : '실패'}\n근거: ${r.evidence}${r.counterexample ? `\n반례: ${r.counterexample}` : ''}` : '';

async function prepare({ base, key, model, contents, signal, level, onStep, owner, datasets }) {
  const L = level;
  const softEnd = Date.now() + L.timeout;
  const hard = new AbortController();
  const hardTimer = setTimeout(() => hard.abort(), L.timeout + HARD_GRACE_MS);
  const onAbort = () => hard.abort();
  if (signal) { if (signal.aborted) hard.abort(); else signal.addEventListener('abort', onAbort); }
  const left = () => softEnd - Date.now();
  const st = stepper(onStep);
  const aborted = () => hard.signal.aborted;

  try {
    const common = { base, key, model, contents, signal: hard.signal, budget: L.budget };
    const q = tailClip(contents.slice(-6).map(c => `[${c.role}] ${textOf(c)}`).join('\n'), 6000);
    const qOnly = [{ role: 'user', parts: [{ text: `## 질문\n${q}` }] }];
    const seed0 = seedOf(q, 0);

    // ① 분석 (구조화)
    let plan = null;
    if (L.plan) {
      st.start('plan', '문제 분류·분석');
      try {
        plan = await ask({ ...common, contents: qOnly, system: PLAN_SYS, temperature: 0.1, seed: seed0, budget: 0 }, PLAN_SCHEMA);
        st.done('plan', clip(planText(plan), 420));
      } catch (e) { if (aborted()) throw e; st.done('plan', '건너뜀'); }
    }
    const kind = plan?.kind || '';
    const isCode = kind ? kind === '코드' : CODE_RE.test(q);
    const doRefute = L.refute || (isCode && L.samples >= 3);
    const maxRevise = Math.max(L.revise, isCode && L.samples >= 3 ? 1 : 0);

    // ② 풀이 (시드 고정, 전략 분산)
    let ref = null;
    const draftOne = async i => {
      const S = STRATEGIES[i % STRATEGIES.length], id = 'draft' + i;
      const sys = [DRAFT_SYS, isCode ? CODE_RULES : '', `[이번 풀이의 전략: ${S.n}] ${S.p}`, plan && `[사전 분석]\n${planText(plan)}`].filter(Boolean).join('\n\n');
      st.start(id, L.samples > 1 ? `풀이 ${i + 1}/${L.samples} · ${S.n}` : '풀이');
      try {
        const d = await ask({ ...common, system: sys, temperature: TEMPS[i], seed: seedOf(q, i), budget: L.budget }, DRAFT_SCHEMA);
        if (!d.answer) throw new Error('빈 답');
        d.strategy = S.n;
        st.done(id, `${brief((d.steps || [])[0] || d.answer, 140)}\n→ 결론: ${brief(d.final || d.answer, 90)}`);
        return d;
      } catch (e) {
        if (aborted()) throw e;
        st.done(id, `실패 (${e.empty ? '빈 응답' : brief(e.message, 60)})`);
        return null;
      }
    };

    const dsJob = process.env.DEEPSEEK_API_KEY
      ? (st.start('ds', 'DeepSeek-R1 참고 풀이'), deepseek(contents, hard.signal).catch(() => null).then(r => { st.done('ds', r ? brief(r.answer, 120) : '건너뜀'); return r; }))
      : Promise.resolve(null);

    // 신뢰도 기반 스케줄링: 먼저 2개만 돌리고, 둘이 일치하면 나머지 생략 (코드는 실행 검증이 있으므로 항상 전부)
    const N = L.samples;
    // 코드가 아니면 1개만 먼저 돌리고, 합의되면 추가 생략 → 체감 속도 향상
    const firstN = Math.min(N, isCode ? N : 1);
    let drafts = (await Promise.all([...Array(firstN).keys()].map(draftOne))).filter(Boolean);
    const ds1 = vote(drafts);
    const converged = ds1 && ds1.size === ds1.total && ds1.size >= 2;
    if (N > firstN && !converged) {
      drafts.push(...(await Promise.all([...Array(N - firstN).keys()].map(k => draftOne(firstN + k)))).filter(Boolean));
    } else if (N > firstN) {
      st.start('early', '조기 종료'); st.done('early', `앞의 ${firstN}개 풀이가 일치 → 추가 풀이 생략`);
    }
    ref = await dsJob;

    if (!drafts.length && ref?.answer) drafts = [{ steps: [], answer: ref.answer, final: '', code: '', self_check: [], strategy: 'DeepSeek' }];
    if (!drafts.length && left() > MIN_STAGE_MS) {
      st.start('retry', '풀이 재시도');
      const d = await draftOne(0).catch(() => null);
      if (d) drafts.push(d);
      st.done('retry', d ? `→ 결론: ${brief(d.final || d.answer, 90)}` : '실패');
    }
    if (!drafts.length) throw new Error('풀이 생성 실패');

    // ③ 합의도
    let v = null;
    if (drafts.length > 1) {
      v = vote(drafts);
      if (v) {
        st.start('vote', '합의도');
        st.done('vote', v.size === v.total ? `✓ ${v.total}개 풀이 모두 일치: ${brief(v.topFinal, 80)}`
          : `⚠ ${v.size}/${v.total} 일치 — 다수: ${brief(v.topFinal, 60)}\n소수: ${brief(v.others.join(' / '), 80)}`);
      }
    }
    const voteLine = () => (v ? `합의도: ${v.size}/${v.total} 일치 · 다수 결론: ${v.topFinal}${v.others.length ? ' · 소수 결론: ' + v.others.join(' / ') : ''}` : '');
    const view = () => drafts.map((d, i) => draftText(d, i)).join('\n\n') + (ref ? `\n\n### 참고 풀이 (DeepSeek-R1)\n[답]\n${clip(ref.answer, 2500)}` : '');

    // ④⑤ 검증 ∥ 반박
    async function review(sfx) {
      const lead = v ? v.top[v.top.length - 1] : drafts[drafts.length - 1];
      const vid = 'verify' + sfx, rid = 'refute' + sfx;
      st.start(vid, sfx ? '재검증' : (isCode ? '실행 검증' : '검증'));

      const verifyP = (async () => {
        try {
          let c;
          if (isCode && lead.code) {
            // 코드 실행 도구로 실제 테스트 → 로그를 구조화 판정으로
            const log = await gen({
              ...common, contents: [{ role: 'user', parts: [{ text: `## 질문\n${q}\n\n## 후보 코드\n\`\`\`\n${lead.code}\n\`\`\`\n\n## 후보 설명\n${lead.answer}` }] }],
              system: EXEC_VERIFY_SYS, temperature: 0.1, budget: 0, tools: [{ codeExecution: {} }]
            });
            c = await ask({ ...common, contents: [{ role: 'user', parts: [{ text: `## 질문\n${q}\n\n## 실행 검증 로그\n${log}\n\n${voteLine()}` }] }], system: CRITIC_SYS + CODE_CRITIC_EXTRA, temperature: 0.1, budget: Math.min(L.budget || 0, 512) }, CRITIC_SCHEMA);
          } else {
            c = await ask({ ...common, contents: [{ role: 'user', parts: [{ text: `## 질문\n${q}\n\n${voteLine()}\n\n## 풀이들\n${view()}` }] }], system: CRITIC_SYS, temperature: 0.2, budget: L.budget }, CRITIC_SCHEMA);
          }
          st.done(vid, `${c.verdict === 'FIX' ? '⚠ 오류/불일치 발견' : '✓ 문제 없음'} · 확신도 ${c.confidence}%\n${brief(c.correct_answer, 130)}`);
          return c;
        } catch (e) {
          if (aborted()) throw e;
          st.done(vid, '건너뜀'); return null;
        }
      })();

      // 신뢰도 스케줄링: 합의가 완전하고 반박 대상이 확실하면 반박 생략
      const confident = v && v.size === v.total;
      let refuteP = Promise.resolve(null);
      if (doRefute && !(confident && sfx === '')) {
        st.start(rid, sfx ? '재반박' : '반박 시도');
        refuteP = ask({ ...common, contents: [{ role: 'user', parts: [{ text: `## 질문\n${q}\n\n## 가장 유력한 결론\n${lead.final || '(한 줄 결론 없음)'}\n\n## 그 풀이\n${clip(lead.answer, 3000)}${lead.code ? `\n\n## 코드\n${clip(lead.code, 3000)}` : ''}` }] }], system: REFUTE_SYS + (isCode ? CODE_REFUTE_EXTRA : ''), temperature: 0.4, seed: seedOf(q, 90 + Number(sfx || 0)), budget: 0 }, REFUTE_SCHEMA)
          .then(r => { st.done(rid, `${r.broken ? '⚠ 반박 성공' : '✓ 반박 실패(결론 유지)'}\n${brief(r.evidence, 130)}`); return r; },
                e => { if (aborted()) throw e; st.done(rid, '건너뜀'); return null; });
      }

      const [c, r] = await Promise.all([verifyP, refuteP]);
      const fix = c?.verdict === 'FIX' || !!r?.broken;
      return { text: [critText(c), refText(r)].filter(Boolean).join('\n\n'), fix, conf: c ? c.confidence : null };
    }

    let rv = await review('');

    // ⑥ 오류 수정 루프 (코드가 조건을 판단하고, 모델은 수정만 한다)
    for (let r = 1; r <= maxRevise && rv.fix; r++) {
      if (left() < MIN_STAGE_MS) break;
      const fid = 'fix' + r;
      st.start(fid, `오류 수정 ${r}/${maxRevise}`);
      try {
        const d = await ask({
          ...common, system: FIX_SYS + (isCode ? ' ' + CODE_RULES : ''), temperature: 0.3, seed: seedOf(q, 50 + r), budget: L.budget,
          contents: [{ role: 'user', parts: [{ text: `## 질문\n${q}\n\n## 기존 풀이들\n${view()}\n\n## 검증·반박 결과\n${rv.text}` }] }]
        }, DRAFT_SCHEMA);
        d.fixed = true; d.strategy = '수정';
        if (d.answer) drafts.push(d);
        st.done(fid, d.answer ? `→ 결론: ${brief(d.final || d.answer, 90)}` : '빈 수정본');
      } catch (e) {
        if (aborted()) throw e;
        st.done(fid, '실패'); break;
      }
      v = vote(drafts) || v;
      if (left() < MIN_STAGE_MS / 2) { rv = { ...rv, fix: true }; break; }
      rv = await review(String(r));
    }

    // 5) 도구 검증: 질문 의도에 맞는 추론 도구(수학·코딩·데이터)로 후보를 실제 계산·검사
    let toolText = '';
    const intent = TOOLS.classify(q).intent;
    const groups = TOOLS.groupsFor(intent, L);
    if (groups.length && !aborted() && left() > MIN_STAGE_MS) {
      st.start('tools', `도구 검증 (${groups.join('·')})`);
      try {
        const lead0 = v ? v.top[v.top.length - 1] : drafts[drafts.length - 1];
        const dsNote = datasets && datasets.length
          ? `\n\n사용 가능한 데이터셋: ${datasets.map(d => `${d.id}(${d.name})`).join(', ')}`
          : '';
        const candidate = `## 질문\n${q}\n\n## 후보 답\n${clip(lead0.answer, 2500)}${lead0.code ? `\n\n## 후보 코드\n${clip(lead0.code, 3000)}` : ''}${dsNote}\n\n도구로 핵심 계산·검사를 직접 수행하라.`;
        const tr = await TOOLS.runToolLoop({
          base, key, model, system: TOOL_CHECK_SYS, groups, mode: 'ANY', maxRounds: 2, temperature: 0.1,
          signal: hard.signal, owner,
          contents: [{ role: 'user', parts: [{ text: candidate }] }]
        });
        toolText = tr.text || '';
        st.done('tools', `${tr.trace.length}회 도구 호출 · ${brief(toolText, 120)}`);
      } catch (e) {
        if (aborted()) throw e;
        st.done('tools', '건너뜀');
      }
    }

    // ⑦ 최종 답 작성용 contents
    const answers = drafts.map((d, i) => `- ${d.fixed ? '수정본' : '풀이'} ${i + 1}: ${clip(d.answer, 2200)}`).join('\n') + (ref ? `\n- DeepSeek: ${clip(ref.answer, 2200)}` : '');
    const note = `[내부 검증 자료 — 언급 금지]\n${plan ? `분석:\n${planText(plan)}\n\n` : ''}${answers}\n\n${voteLine()}\n확신도: ${rv.conf ?? '알 수 없음'}${rv.fix ? ' · 마지막 검토에서도 문제가 남아 있음' : ''}\n\n검증 결과:\n${clip(rv.text || '(없음)', 3500)}\n${toolText ? `\n[도구 검증 결과]\n${clip(toolText, 1500)}` : ''}\n[자료 끝]`;

    const out = contents.map(c => ({ ...c, parts: c.parts.map(p => ({ ...p })) }));
    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.parts.length) {
      const tp = last.parts.find(p => typeof p.text === 'string');
      if (tp) tp.text += '\n\n' + note; else last.parts.push({ text: note });
    } else {
      out.push({ role: 'user', parts: [{ text: note }] });
    }

    return {
      contents: out,
      system: FINAL_SYSTEM,
      stats: { drafts: drafts.length, agree: v ? `${v.size}/${v.total}` : null, confidence: rv.conf, unresolved: rv.fix, deepseek: !!ref, code: isCode }
    };
  } finally {
    clearTimeout(hardTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { prepare, LEVELS, info };
