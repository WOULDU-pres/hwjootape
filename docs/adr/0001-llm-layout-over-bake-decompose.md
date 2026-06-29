# ADR-0001 — 덱 생성: "통짜 굽고 분해" 대신 "LLM이 레이아웃 설계 + 진짜 텍스트"

- Status: Accepted (2026-06-27)
- Supersedes: `.omc/plans/2026-06-26-bananatape-deck-generator.md`의 척추(통짜 bake → OCR 분해)

## Context

기존 덱 파이프라인은 god-tibo(gpt-5.x)가 **텍스트까지 박힌 통짜 슬라이드 이미지**를 굽고 →
Apple Vision OCR로 그 텍스트 위치를 되읽고 → `clean-bg.py`로 글자를 지운 뒤 →
편집가능 텍스트박스를 다시 얹는 구조였다(approach A).

실사용 결과 사용자가 보고한 문제:

- 텍스트가 엉뚱한 위치에 들어간다 (`heuristics.ts`의 OCR bbox→정규화 좌표가 CJK에서 흔들림).
- 분해 결과가 나쁘다 (제목="가장 큰 OCR 박스", 불릿=위→아래 순서 매핑이라는 순수 기하 휴리스틱).
- 디자인이 망가진다 (`clean-bg.py`의 median+blur 인페인팅이 원본을 뭉갬).
- 10장을 요청해도 1장만 나온다 (`deck/page.tsx`가 `parseOutline(...)[0]`로 첫 장만 사용).

이 문제들은 전부 **"raster로 굽고 → OCR로 되읽는 lossy 왕복"** 한 곳에서 비롯된다.
2026-06-26 계획 리뷰에서 architect/critic이 이미 경고했던 실패 모드다(당시엔 사용자가
"AI가 만든 응집된 레이아웃을 먼저 승인" 가치를 위해 A를 고수).

새로 확인한 사실: god-tibo 백엔드(`chatgpt.com/backend-api/codex`)는 OpenAI Responses API다.
현재 코드는 `tool_choice: image_generation`을 강제해 이미지 아이템만 추출하지만
(`god-tibo-provider.ts:111-112,161-163`), 같은 엔드포인트에서 **텍스트/JSON 출력**도 받을 수 있다.
즉 gpt-5.5를 "이미지 생성기"가 아니라 "레이아웃 설계자"로 쓸 수 있다.

## Decision

왕복을 제거하고 **compose-from-structure**로 전환한다(LLM이 설계, 텍스트는 항상 진짜):

1. 아웃라인 → **gpt-5.5가 슬라이드별 레이아웃 JSON**을 설계(테마 선택 + 아키타입 + 콘텐츠 배치 +
   선택적 이미지존). 색·좌표를 백지에서 발명하지 않고 **큐레이션된 테마**를 채운다.
2. 사용자 아웃라인 문자열을 **진짜 편집가능 텍스트박스**로 그 좌표에 렌더(OCR 없음, CJK 깨짐 없음).
3. god-tibo(gpt-5.5)는 **표시된 이미지존만** 채운다. 텍스트 뒤 풀블리드 금지. 일부 슬라이드는 텍스트 전용.
4. 흐름은 **2단계**: ① 아웃라인→전 슬라이드 레이아웃 즉시 렌더(이미지 생성 비용 0, 승인 게이트) →
   ② 승인 후 god-tibo가 이미지존 병렬 채움 → 편집가능 `.pptx` + 충실 PNG.
5. 멀티페이지가 자연히 성립(아웃라인 N장 루프). `[0]` 버그 제거.

기존 OCR/decompose/clean-bg/SAM3 코드는 **크리티컬 패스에서 분리**한다(파일은 보존, 되돌리기 가능).

## Consequences

- (+) 텍스트 오배치·분해 품질·디자인 뭉갬이 **근본에서 사라진다**(왕복 자체를 없앰).
- (+) 멀티페이지가 기본. 백엔드 export(build-pptx.py/render-png.py)는 이미 멀티슬라이드 지원이라 그대로 둔다.
- (+) 한글 텍스트가 항상 선명(렌더 시점에 진짜 폰트로 그림).
- (−) 사용자가 "AI가 구운 한 장의 그림"을 승인하던 게이트는 사라지고 **렌더된 레이아웃 프리뷰 승인**으로 대체.
- (−) 새 의존: gpt-5.5의 레이아웃 JSON 품질. 테마 시스템·레이아웃 designer를 새로 만들어야 함.
- (−) `heuristics.ts`/`ocr-runner.ts`/`clean-bg.py`/SAM3 경로는 당분간 죽은(보존된) 코드로 남음.

## Risks / open

- gpt-5.5가 한국어 실아웃라인에 대해 **일관되게 쓸 만한 레이아웃 JSON**을 내는가 → vertical slice에서 검증.
- gpt-5.5 모델 id를 백엔드가 수용하는지 미검증(`generateImage`가 거부 시 throw) → /ultraqa에서 라이브 확인.
