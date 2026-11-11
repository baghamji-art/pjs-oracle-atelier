# 상담 전송·관리자 답변 서버 경로 — 2026-09-09

## 이번 단계의 범위

회원 새 상담/추가 질문과 관리자 답변을 서버 API로 준비했다. 기존 보관함 작업은
커밋 전 상태였으므로 그대로 이어받았고, 관련 파일이나 사용자 변경을 되돌리지 않았다.
**기존 화면 연결, 운영 DB 함수 설치, 환경변수 설정, 배포는 수행하지 않았다.**

변경 전 전체 소스 백업:
`/Users/pj7/Documents/Codex/2026-09-01/git/backups/consult-write-5tpVyX/source.tar.gz`

SHA-256: `1ae55fa59a95543bfd8586975ab9ab612089eca99a7a1aa43d7963d9284884d2`

## 기능과 권한

두 API 모두 POST/허용 Origin/JSON만 받으며, 기존 관리자 점검 게이트를 통과해야 한다.
읽기·보관함 활성화와 독립적으로 `MEMBER_CONSULT_WRITE_MODE=rehearsal`이 필요하다.
기본 비활성화다. 일반 사용자에게 공개된 운영 모드는 아직 없다.

회원: `/.netlify/functions/member-consult`

```json
{"action":"create","consultId":"consult_stable_id","messageId":"message_stable_id","message":"상담 질문","lang":"ko"}
```

추가 질문은 같은 consultId에 action `reply`와 새 messageId를 보낸다.
본인 회원 세션·현재 계정 상태를 확인하고 소유자 ID와 `user` 역할을 서버에서 정한다.
다른 회원 ID, 역할, 시간, 로그 배열, 첨부 필드 등은 입력받지 않는다.

관리자: `/.netlify/functions/admin-consult`

```json
{"action":"reply","memberId":"phz","consultId":"consult_stable_id","messageId":"answer_stable_id","message":"관리자 답변","lang":"ko"}
```

관리자 세션과 테스트 대상 목록을 확인하고 역할을 `admin`으로 고정한다.
회원의 비밀번호나 회원 세션을 요구하지 않는다. 관리자도 없는 상담을 새로 만들 수 없다.
기존 기능과 같이 만료 회원의 기존 상담에 답변할 수 있지만, 회원을 활성화하거나 기간을
늘리지 않는다. 대상은 반드시 `MEMBER_REHEARSAL_IDS` 안의 존재하는 회원이어야 한다.

message/줄바꿈/언어는 원문으로 보존한다. 빈 메시지, NUL, 16,000 UTF-8 바이트를 넘는
본문은 거부한다. lang은 ko/en/zh, 상담·메시지 ID는 영숫자/밑줄/하이픈 1–128자로 제한한다.
HTML 문자열이어도 일반 메시지 텍스트이며, 화면 연결 시 기존처럼 escape/textContent로 표시해야 한다.

## 원자적 저장과 중복 방지

`sql/consult-write-v1.sql`은 새 `pjo_consult_append_v1` 함수를 준비한다.

- main 행을 잠그고 최신 members/logs를 읽는다. 전송 전 인증 스냅샷과 현재 계정,
  세션 만료를 잠금 획득 후 다시 확인한다.
- 기존 기록의 소유자가 다르면 거부한다. 예전 UI가 consultId 하나로 그룹화하므로
  다른 소유자가 쓰는 consultId의 새 상담 생성도 허용하지 않는다.
- 최신 logs 배열에 **메시지 한 건만** 추가한다. members/history/guest_codes는 바꾸지 않는다.
- 기존 로그 필드 id/userId/action/consultId/role/message/time/lang을 유지하고,
  **새 메시지에만 messageId를 추가**해 재시도를 식별한다. 기존 로그를 변환하지 않는다.
- 중복 판단 범위는 소유자 + 서버 지정 역할 + messageId다. 같은 ID/내용/상담/언어이면
  unchanged와 원래 시간을 반환한다. 다른 내용/상담에 같은 ID를 재사용하면 충돌한다.
- 전송 시각은 DB가 결정한다. 같은 상담의 직전 시각보다 최소 1ms 뒤를 사용하여
  빠른 질문·답변이 같은 밀리초에 도착해도 읽기 순서가 뒤집히지 않게 한다.
- 200개/240개로 오래된 로그를 자르지 않는다. logs 10,000개 또는 main의 members+logs
  JSON 약 7MiB 한도에 도달하면 저장을 거부하고 기존 자료를 보존한다. 이는 임시 저장
  구조의 안전 한도이며 운영에 연결하기 전 보존 정책/용량을 별도로 확정해야 한다.
- main이 없거나 잘못된 구조이면 새로 만들거나 초기화하지 않는다.

함수는 SECURITY INVOKER와 고정 search_path를 사용하고 service_role만 실행하도록 한다.
PUBLIC/anon/authenticated는 실행할 수 없다. 새 테이블/열이나 기존 RLS 정책 변경은 없다.
기존 함수 이름이 충돌하면 설치가 실패한다. 확인 없이 OR REPLACE로 덮어쓰지 않는다.

읽기 API는 본인 메시지의 messageId를 선택적으로 반환한다. ID가 없는 이전 메시지도
그대로 읽는다. 회원 계정·비밀번호·관리자 메모·다른 회원 메시지는 전송 응답에 포함하지 않는다.

## 오류와 전환 제한

- CONSULT_CONFLICT: 새 ID로 무작정 반복하지 말고 기존 전송 내용을 확인한다.
- CONSULT_NOT_FOUND: 없는 상담 또는 접근 불가 상담. 다른 회원의 자료는 반환하지 않는다.
- CONSULT_STORAGE_FULL: 과거 상담을 자동 삭제하지 않는다. 운영 보존/저장 구조 검토가 필요하다.
- CONSULT_WRITE_UNCONFIRMED: **저장되지 않았다는 뜻이 아니다.** 응답 유실이나 세션
  만료 직전에 이미 커밋됐을 수 있다. 같은 messageId/본문으로 확인·재시도한다.
  API가 자동 재시도하거나 일반 table upsert로 우회하지 않는다.

타임아웃은 응답 본문 읽기까지 포함하며, DB 오류/키/메시지 원문을 로그나 오류 응답에
노출하지 않는다. 모든 응답은 JSON/no-store/Vary: Cookie/noindex다.

**기존 브라우저/관리자의 전체 main 행 저장 경로는 아직 남아 있다.** 이것이 나중에
실행되면 새 메시지를 덮거나 재시도 식별 정보를 지울 수 있다. 새 함수만 설치해서는
해결되지 않는다. 모든 쓰기 경로 전환과 직접 DB 접근 차단을 함께 준비해야 한다.
브라우저에만 남아 있고 서버 logs에서 잘린 예전 상담도 이번 작업으로 복구된 것이 아니다.

## 검증 결과

- 일반 보안 회귀 테스트: 기존 63 + 상담 8 = **71개 통과**.
- 로컬 PGlite SQL 통합 테스트: 보관함 1 + 상담 1 = **2개 통과**.
- 상담 SQL 시험에서 실제 함수 실행 권한, 본인/타인 상담 분리, 중복 전송,
  같은 retry ID의 다른 내용 거부, 질문·답변 순서, 기존 로그 240개 보존,
  회원/게스트 데이터 보존, 만료/차단/비밀번호 변경, 용량 초과/잘못된 main을 검증했다.
- 운영 DB/실제 회원/유료 LLM에 접속하지 않았다. 가짜 데이터와 인메모리 DB만 사용했다.
- `outputs/`, Netlify 배포 경로는 수정하지 않았다. 비밀키 리터럴 검사 이상 없음.

```sh
npm run test:security
PJO_TEST_PGLITE_PATH=/path/to/pglite/dist/index.cjs npm run test:consult:sql
```

이번 SQL 엔진은 앞 단계에서 받은 PGlite 0.5.8 임시 설치를 재사용했다. 운영 dependency를
추가하지 않았다. PGlite는 단일 연결이므로 실제 다중 PostgreSQL 세션의 잠금 대기,
배포된 Supabase RPC와 Safari 화면 왕복까지 검증한 것은 아니다.

## 다음 단계와 수동 작업 경계

다음 구현 영역은 회원가입·승인·이용권 변경 등 관리자/회원 데이터 변경 경로다.
실제 회원의 결제·승인 정책은 코드에서 임의로 바꾸지 않는다.

별도 시험 환경에서 SQL 설치, 백업 복원, 다중 세션 충돌, 테스트 계정 전체 화면 연결을
검증하고 전환 승인을 받은 후 운영 배포/권한 차단을 조율해야 한다.

**지금 운영 Supabase에 SQL을 실행하거나 MEMBER_CONSULT_WRITE_MODE를 켜지 않는다.**
현재 단계 코드를 커밋/배포하는 것만으로는 새 쓰기나 기존 사용자 동작이 활성화/변경되지 않는다.
