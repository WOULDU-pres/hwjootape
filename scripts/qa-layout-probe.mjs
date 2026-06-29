#!/usr/bin/env node
// Standalone probe: can the private codex backend (god-tibo) act as a LAYOUT DESIGNER
// using model gpt-5.5? Unlike qa-codex-size-probe.mjs, we DO NOT force the
// image_generation tool — we want a TEXT/JSON answer and parse the message output item.
//
// Usage:  node scripts/qa-layout-probe.mjs [runs]
//         RUNS=5 node scripts/qa-layout-probe.mjs
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

const RUNS = Number(process.argv[2] ?? process.env.RUNS ?? 3) || 3;
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

const ARCHETYPES = ['title', 'section', 'bullets', 'bullets-image-right', 'quote', 'closing'];

const OUTLINE = [
  '1) 표지: 2026년 사업 전략',
  '2) 시장 개요 (불릿 3개: 시장 규모, 성장률, 주요 경쟁사)',
  '3) 우리의 강점 (불릿 3개)',
  '4) 핵심 제품 라인업 (이미지 곁들임)',
  '5) 2025 성과 요약 (불릿 4개: 매출, 신규고객, 리텐션, NPS)',
  '6) 2026 목표 (불릿 3개)',
  '7) 전략 방향 1: 제품 (이미지 곁들임)',
  '8) 전략 방향 2: 시장 확장',
  '9) 실행 로드맵 (분기별 4개)',
  '10) 마무리: 함께 만들 미래',
];

const THEME =
  '이 덱은 16:9 비즈니스 프레젠테이션 테마다. ' +
  `각 슬라이드의 archetype은 다음 중에서만 고른다: ${ARCHETYPES.join(', ')}. ` +
  '- title: 표지/커버 슬라이드. ' +
  '- section: 섹션 구분 슬라이드. ' +
  '- bullets: 제목 + 불릿 목록 (이미지 없음). ' +
  '- bullets-image-right: 제목 + 불릿 + 우측 이미지 영역. ' +
  '- quote: 인용/강조 문구 슬라이드. ' +
  '- closing: 마무리/감사 슬라이드.';

const PROMPT = [
  '너는 슬라이드 레이아웃 디자이너다. 아래 아웃라인의 각 항목을 16:9 캔버스의 슬라이드 하나로 설계하라.',
  '',
  THEME,
  '',
  '출력 규칙 (반드시 지킬 것):',
  '- 오직 하나의 JSON 객체만 출력한다. 산문, 설명, 마크다운 코드펜스(```)를 절대 쓰지 마라.',
  '- JSON 형태:',
  '  {"slides":[{"archetype":"title|section|bullets|bullets-image-right|quote|closing","title":"문자열","bullets":["..."],"imageZone":{"x":0~1,"y":0~1,"w":0~1,"h":0~1} 또는 null}]}',
  '- 좌표(x,y,w,h)는 16:9 캔버스에서 0..1로 정규화된 값이다. (x,y)는 좌상단, (w,h)는 너비/높이.',
  '- 텍스트만 있는 슬라이드는 imageZone을 null로 둔다.',
  '- imageZone은 제목 영역과 절대 겹치면 안 된다 (제목은 보통 캔버스 상단을 차지한다).',
  '- 모든 좌표는 0 이상 1 이하이며, x+w<=1, y+h<=1 이어야 한다.',
  `- slides 배열의 길이는 아웃라인 항목 수와 정확히 같아야 한다 (총 ${OUTLINE.length}개).`,
  '- bullets가 없는 archetype(title/section/quote/closing 등)이면 bullets는 빈 배열로 둔다.',
  '',
  '아웃라인:',
  ...OUTLINE,
].join('\n');

async function loadAuth() {
  const data = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf-8');
  const auth = JSON.parse(data);
  const token = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!token || !accountId) throw new Error('Missing access_token or account_id in ~/.codex/auth.json');
  return { token, accountId };
}

// SSE parser — mirrors qa-codex-size-probe.mjs.
function parseSseText(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const chunks = normalized.split(/\n\n+/).map((v) => v.trim()).filter(Boolean);
  const events = [];
  for (const block of chunks) {
    let evType = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) evType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const dataText = dataLines.join('\n');
    let data = null;
    if (dataText) {
      try { data = JSON.parse(dataText); } catch { /* skip malformed */ }
    }
    events.push({ event: evType, data });
  }
  return events;
}

// Collect the output[] array from either SSE (response.completed) or plain JSON.
function collectOutputItems(responseText, contentType) {
  const trimmed = responseText.trimStart();
  const shouldParseAsSse =
    (contentType ?? '').includes('text/event-stream') ||
    trimmed.startsWith('event:') ||
    trimmed.startsWith('data:');

  if (shouldParseAsSse) {
    const events = parseSseText(responseText);
    const items = [];
    for (const ev of events) {
      const data = ev?.data;
      if (data?.type === 'response.completed' && Array.isArray(data.response?.output)) {
        items.push(...data.response.output);
      }
    }
    // Fallback: some streams emit response.output_item.done with item payloads.
    if (items.length === 0) {
      for (const ev of events) {
        const item = ev?.data?.item;
        if (item && typeof item === 'object') items.push(item);
      }
    }
    return { items, events };
  }

  // Plain JSON body with an output array.
  try {
    const payload = JSON.parse(responseText);
    const items = Array.isArray(payload?.output) ? payload.output : [];
    return { items, events: [] };
  } catch {
    return { items: [], events: [] };
  }
}

// Extract the assistant TEXT from the message output item's text content.
function extractAssistantText(items) {
  const texts = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      // Responses API text parts are typically output_text; accept any *_text with .text.
      if (typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'text' || /text/.test(part.type ?? ''))) {
        texts.push(part.text);
      }
    }
  }
  return texts.join('').trim();
}

// Strip leading/trailing markdown code fences if present.
function stripCodeFences(text) {
  let t = text.trim();
  // ```json\n ... \n```  or  ``` ... ```
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  // Loose: strip a leading fence line and a trailing fence line independently.
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
  if (t.endsWith('```')) t = t.replace(/\n?```$/, '');
  return t.trim();
}

function describeBackendError(events) {
  for (const ev of [...events].reverse()) {
    const data = ev?.data;
    if (!data) continue;
    const e = data.error || data.response?.error || data.item?.error;
    const directMessage = typeof data.message === 'string' ? data.message : undefined;
    if (!e && !directMessage) continue;
    const message = e?.message ?? directMessage ?? '';
    const code = e?.code ?? '';
    const type = e?.type ?? '';
    const details = [message, code ? `code=${code}` : null, type ? `type=${type}` : null]
      .filter(Boolean).join(' ');
    if (details) return details;
  }
  return null;
}

function bboxesWithinUnit(slides) {
  for (const s of slides) {
    const z = s?.imageZone;
    if (z == null) continue;
    const { x, y, w, h } = z;
    const nums = [x, y, w, h];
    if (nums.some((n) => typeof n !== 'number' || Number.isNaN(n))) return false;
    if (x < 0 || y < 0 || w < 0 || h < 0) return false;
    if (x > 1 || y > 1 || w > 1 || h > 1) return false;
    if (x + w > 1.0001 || y + h > 1.0001) return false;
  }
  return true;
}

async function probeRun(runIndex, auth) {
  const body = {
    model: 'gpt-5.5',
    instructions: '',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: PROMPT }],
      },
    ],
    // NOTE: deliberately NO tool_choice:image_generation — we want a text/JSON answer.
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  };

  const start = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'ChatGPT-Account-ID': auth.accountId,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      originator: 'codex_cli_rs',
      session_id: crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const responseText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  console.log(`\n--- RUN ${runIndex + 1}/${RUNS} ---`);
  console.log(`HTTP status: ${response.status} (${elapsed}s)`);

  if (!response.ok) {
    // VERBATIM backend error body so we learn whether gpt-5.5 is rejected.
    console.log('Backend error body (verbatim):');
    console.log(responseText);
    return { runIndex, ok: false, status: response.status };
  }

  const { items, events } = collectOutputItems(responseText, contentType);
  const text = extractAssistantText(items);

  if (!text) {
    const backendError = describeBackendError(events);
    console.log(`JSON parsed: NO (no assistant text found)`);
    if (backendError) console.log(`Backend error: ${backendError}`);
    const eventTypes = [...new Set(events.map((e) => e?.data?.type ?? e.event))].slice(0, 12);
    if (eventTypes.length) console.log(`Event types: ${eventTypes.join(', ')}`);
    const outputTypes = [...new Set(items.map((i) => i?.type ?? 'unknown'))];
    if (outputTypes.length) console.log(`Output item types: ${outputTypes.join(', ')}`);
    console.log('Raw response (first 1000 chars):');
    console.log(responseText.slice(0, 1000));
    return { runIndex, ok: false, status: response.status };
  }

  const cleaned = stripCodeFences(text);
  let parsed = null;
  let parseErr = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    parseErr = e;
  }

  if (!parsed) {
    console.log('JSON parsed: NO (JSON.parse failed)');
    console.log(`Parse error: ${parseErr?.message ?? 'unknown'}`);
    console.log('Assistant text (raw, first 1500 chars):');
    console.log(text.slice(0, 1500));
    return { runIndex, ok: false, status: response.status };
  }

  const slides = Array.isArray(parsed?.slides) ? parsed.slides : null;
  const slideCount = slides ? slides.length : 0;
  const countMatches = slideCount === OUTLINE.length;
  const bboxOk = slides ? bboxesWithinUnit(slides) : false;
  const archetypesValid = slides
    ? slides.every((s) => ARCHETYPES.includes(s?.archetype))
    : false;

  console.log('JSON parsed: YES');
  console.log(`Slide count: ${slideCount} (expected ${OUTLINE.length}) -> ${countMatches ? 'OK' : 'MISMATCH'}`);
  console.log(
    `Sanity: all bboxes within 0..1? ${bboxOk ? 'YES' : 'NO'}; ` +
    `archetypes all valid? ${archetypesValid ? 'YES' : 'NO'}`,
  );
  console.log('Pretty JSON:');
  console.log(JSON.stringify(parsed, null, 2));

  return {
    runIndex,
    ok: true,
    status: response.status,
    parsed: true,
    slideCount,
    countMatches,
    bboxOk,
    archetypesValid,
  };
}

async function main() {
  console.log('=== qa-layout-probe: can gpt-5.5 on the private codex backend act as a LAYOUT DESIGNER? ===');
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Model: gpt-5.5 (tool_choice NOT forced to image_generation)`);
  console.log(`Runs: ${RUNS}`);

  let auth;
  try {
    auth = await loadAuth();
  } catch (e) {
    console.error(`FATAL: could not load auth: ${e.message}`);
    process.exit(0); // probe: always exit 0
  }

  const results = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await probeRun(i, auth);
      results.push(r);
    } catch (e) {
      console.log(`\n--- RUN ${i + 1}/${RUNS} ---`);
      console.log(`Exception: ${e?.message ?? e}`);
      results.push({ runIndex: i, ok: false, exception: true });
    }
  }

  console.log('\n=== SUMMARY ===');
  const parsedOk = results.filter((r) => r.ok && r.parsed);
  const goodShape = parsedOk.filter((r) => r.countMatches && r.bboxOk && r.archetypesValid);
  console.log(`Runs: ${results.length}`);
  console.log(`Parsed valid JSON: ${parsedOk.length}/${results.length}`);
  console.log(`Correct shape (count + bbox + archetypes): ${goodShape.length}/${results.length}`);

  process.exit(0); // probe: always exit 0
}

main().catch((e) => {
  // Probe must not abort hard; report and exit 0.
  console.error('FATAL:', e?.message ?? e);
  process.exit(0);
});
