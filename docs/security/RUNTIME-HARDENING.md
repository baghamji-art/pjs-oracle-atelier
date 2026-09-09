# Critical 서버 보강 작업 — 2026-09-09

기준 커밋: `c4af5d2`. 시작 시 작업 트리는 깨끗했다.
현재 작업은 로컬 수정이다. 자동 커밋·push·Netlify 배포·운영 DB 접근/변경을 하지 않았다.

코드 백업: `/Users/pj7/Documents/Codex/2026-09-01/git/backups/critical-server-hardening-tnHJ2s/source.tar.gz`

SHA-256: `84d4c65373a201d2ec4be4b9b13060e45fbe41510411ff1945843fa68be4454e`

## 이번에 수정한 것

### 실제 요청 처리 코드

- 관리자 로그인·로그아웃과 AI POST에 신뢰된 Origin 및 JSON Content-Type 검사를 추가했다.
  프로덕션 `https://pjtarot.netlify.app`과 서버 환경의 URL/DEPLOY_URL/DEPLOY_PRIME_URL만 신뢰한다.
  클라이언트 Host/X-Forwarded-Host로 허용 출처를 정하지 않는다.
  Origin 누락/null/외부 출처, 브라우저의 cross-site 요청, HTML 폼 요청을 거절한다.
  관리자 로그아웃 요청에도 JSON 헤더와 빈 JSON 본문을 넣었다. 로그인/로그아웃 버튼은 유지했다.
- AI의 wildcard CORS 응답을 제거했다. **Origin 검사는 회원 인증이 아니며 curl 등의
  비브라우저 클라이언트는 Origin을 위조할 수 있다.**
- 관리자 쿠키는 기존 발급 형식을 유지하면서 중복 쿠키, 잘못된 서명/nonce,
  미래 발급 시각, 비정상 만료시간, 과도한 크기를 거부한다.
  비밀번호/서명 비교는 고정 길이 digest를 timingSafeEqual로 비교한다.
  이 digest는 DB 비밀번호 해싱 전환이 아니다. 원래 20분 쿠키는 그대로 유효하다.
- LLM 응답 오류 원문·예외 메시지를 브라우저로 전달하지 않도록 바꿨다.
  비용/인증/호출 제한 오류에는 모델을 바꿔 재시도하지 않는다.
  명시적인 모델 오류에만 기존 모델 후보로 제한된 fallback을 수행한다.
- LLM 전체 fallback 및 응답 본문 읽기에 하나의 18초 제한을 적용했다.
  응답은 512 KiB, 리포트 텍스트는 64 KiB로 제한하고 잘못된 JSON/필드/미완성 응답은 거절한다.
  정상 리딩 프롬프트·모델 후보·출력 토큰·store:false 설정은 그대로 유지했다.
- `AI_READING_ENABLED=false`라는 선택적 비상 스위치를 추가했다. 기본값은 기존 AI 사용이다.
  비활성화하면 기존 DB 리딩 fallback으로 돌아가며 새 안내/화면을 만들지 않는다.
- 향후 전환용 `AI_REQUIRE_MEMBER_SESSION=true` 검사도 연결해 두었다. 기본은 비활성 상태다.
  **지금 켜면 기존 사용자에게 서버 회원 쿠키가 없어 AI 요청이 거절된다. 아직 켜지 않는다.**

OpenAI Docs를 사용해 오류 분류와 재시도 처리를 확인했다. 과금/할당량 오류에 대한
무조건 재시도는 접근을 복구하지 않는다는 [공식 오류 처리 문서](https://developers.openai.com/api/docs/guides/error-codes)를 참고했다.
실제 OpenAI 요청이나 키 조회는 하지 않았고 모든 provider 응답은 가짜 응답으로 검사했다.

### 배포 시 적용될 네트워크 방어

- `netlify.toml`: 기존 API 경로에 IP+도메인별 60초 기준 AI 12회, 관리자 로그인 5회 제한.
  별도 우회용 API 주소를 만들지 않았다. 두 규칙만 추가했고 기존 `/admin` 경로는 유지했다.
- `_headers`: MIME 추측 금지, 외부 프레임 삽입 금지, object/base 요소 제한, Referrer 정책.
  외부 사이트 iframe으로 앱 전체를 삽입하는 사용은 차단된다. 기존 코드에서 그러한 사용은 발견하지 않았다.
  inline JS/CSS/폰트/이미지 제한을 추가하지 않아 기존 렌더링을 유지한다.
  이것은 모든 XSS를 해결하는 완전한 CSP가 아니다.

**호출 제한의 로컬 설정/문법 확인은 Netlify 운영 적용 확인과 다르다.**
배포 후 Post-processing 로그에서 두 규칙이 인식됐는지 반드시 확인해야 한다.
유효하지 않은 규칙이 배포 자체를 실패시키지 않을 수 있다. 같은 공인 IP를 쓰는
정상 사용자들은 한도를 공유하며, 여러 IP에서의 공격이나 전체 비용 상한은 해결하지 않는다.
차단 반영에도 지연이 있을 수 있다.
[Netlify 공식 rate limiting 문서](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)

### 기존 데이터 보존

- 세 HTML 진입점의 cloudSaveState: DB 읽기 실패/행 없음/잘못된 배열 형식이면
  로컬 캐시를 서버에 upsert하지 않고 멈춘다. hydrate도 실패한 자료로 로컬을 교체하지 않는다.
  자동 DB 초기화/복구를 하지 않는다. 정상적으로 읽힌 main 행의 기존 저장 과정은 유지했다.
- 회원 합치기, 상담 로그/목록, 리뷰 집계에서 사용자 입력을 일반 객체의 키로 사용하는
  5곳을 프로토타입 없는 사전으로 바꿨다. `__proto__`, `constructor`, `toString` 같은
  값 때문에 자료가 누락되거나 상담/통계가 깨지지 않게 했다. 계정/질문 자체는 바꾸지 않았다.
- 이는 기존 main 행 전체 덮어쓰기의 **동시 수정 충돌 해결은 아니다**.
  안전한 서버 쓰기 경로와 원자적 수정/충돌 검증은 별도로 필요하다.

### 다음 전환을 위한 운영 확인

새 `GET /.netlify/functions/admin-migration-audit`는 기존 관리자 쿠키 확인 후
서버에서 회원 배열을 읽고 숫자 집계만 반환한다. ID/비밀번호/비밀번호 해시/메모/리딩은 반환하지 않는다.
query/body로 테이블·열·대상 ID를 지정할 수 없고 DB 쓰기도 하지 않는다.
새 회원 세션 키는 이 점검에 필요 없다. 이미 설정한 Supabase 서버 키와 관리자 키를 사용한다.

반환 예: `counts.total`, `counts.eligibleForPreparedAuth`, `counts.requiresReview`,
`counts.legacyPlaintextPassword`, `counts.invalidExpiryFormat`, 상태별 계정 수.
`dataAccessMigrationComplete:false`가 정상이다. 계정 상태는 전환 가능성 판단용이며
실제 승인/정지/갱신은 수행하지 않는다. malformed/중복 ID 등은 안전하게 오류로 멈춘다.

## 파일 목록

수정: `.env.example`, `netlify.toml`, `package.json`, `netlify/functions/_admin-session.js`,
`admin-auth.js`, `admin-logout.js`, `generate-reading.js`, `lib/member-auth.cjs`,
`outputs/_headers`, `outputs/index.html`, `outputs/admin.html`, `outputs/tarot-site-polished.html`,
`outputs/assets/admin-entry.js`, `tests/security-stage1.test.cjs`.

추가: `netlify/functions/admin-migration-audit.js`, `lib/request-security.cjs`,
`lib/bounded-json.cjs`, `scripts/security-scan.cjs`, `tests/runtime-security.test.cjs`, 이 문서.

## 검증 결과

- `npm run test:security`: **42개 자동 테스트 통과**, 배포 파일 비밀키 literal 검사 발견 0건.
  정규식 검사는 난독화 키·Git 과거 기록·운영 권한의 안전성을 증명하지 않는다.
- 3개 질문 유형의 실제 전송 JSON을 기준 커밋과 비교: 프롬프트·모델·토큰 설정 동일.
- 세 HTML의 script 본문 외 내용이 기준 커밋과 바이트 단위로 동일.
  모든 inline script 파싱 성공, 외부 CSS 변경 없음, index/복제본 동일.
- 네트워크를 차단한 가짜 회원 fixture의 390px/1280px 사용자·관리자 진입 화면과
  career/dating_possibility/past_life_connection 저장 리딩 DOM·위치·계산된 스타일 비교 통과.
  악성 HTML 차단, sanitizer 없음 시 실패 차단, 체크박스 유지 검사 통과.
  이 브라우저 비교 뒤에 사전 충돌 수정과 헤더 추가를 마무리했고, 해당 변경은 자동 테스트로 확인했다.
- TOML 파싱 및 두 rate 규칙 형식 확인, `git diff --check` 통과.
- 실제 iPhone Safari, 실제 계정 로그인/리딩 저장/상담, Netlify rate 차단,
  운영 신규 점검 URL은 아직 테스트하지 않았다. 운영 DB/유료 API 테스트 호출은 0회이다.

## Critical 현재 상태 — 아직 운영 전환 완료가 아니다

| 항목 | 이 단계의 개선 | 남은 핵심 |
|---|---|---|
| C1 공개 app_state | 읽기 실패 시 캐시 덮어쓰기 방지 | 공개 권한 회수 + 모든 데이터 경로 서버 전환 |
| C2 인증/권한 | 관리자 쿠키 강화·출처 검사·회원 호환성 점검 | 회원 서버 로그인 연결, 평문 비밀번호 이행, 사용자/관리자 쓰기 권한 검증, 세션 폐기 |
| C3 저장 HTML | 기존 복원 sanitizer 유지·추가 방어 헤더·문자열 충돌 방지 | 다른 HTML 삽입/위임 이벤트와 데이터 권한 전반 점검 |
| C4 LLM 비용 | edge 제한 설정·오류/응답 제한·재시도 제한·비상 스위치 | 운영 제한 적용 확인·실제 회원 인증·분산 회원별 할당량/전체 비용 상한 |

## 다음에 사용자가 할 일

1. GitHub Desktop에서 **이번 파일을 모두 함께** Commit → Push origin.
   HTML/서버/요청 helper를 일부만 배포하지 않는다. DB SQL이나 새 비밀키는 아직 추가하지 않는다.
2. Netlify 배포가 Published인지, Post-processing에 두 rate 규칙이 인식되는지 확인한다.
   설정값/키를 펼친 화면이 아니라 규칙 처리 부분만 확인한다.
3. 배포된 `/admin.html`에 로그인한 같은 브라우저에서
   `https://pjtarot.netlify.app/.netlify/functions/admin-migration-audit`를 연다.
4. 응답 JSON만 공유한다. 숫자 집계 또는 일반 오류 코드만 있어야 한다.
   회원 데이터/키/CSV 원본은 공유하지 않는다.

전환 검토가 필요한 계정 수를 확인하고 백업 복원 검증을 마친 뒤, 실제 계정·기록을
보존하는 서버 데이터 경로와 권한 전환을 이어간다. 지금 anon/RLS 정책을 먼저 닫으면
기존 서비스가 중단되므로 실행할 권한 변경 SQL은 제공/적용하지 않았다.

되돌릴 경우: 보안 강화 전 배포로 되돌리면 취약점도 돌아온다. 이후 사용자 변경을
확인한 뒤 이번 차이만 선택적으로 되돌리고, 백업으로 현재 디렉터리를 통째로 덮어쓰지 않는다.
