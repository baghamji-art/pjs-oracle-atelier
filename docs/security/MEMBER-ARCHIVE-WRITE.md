# 보관함 서버 저장 준비 — 2026-09-09

> 후속 [상담 전송·관리자 답변 서버 경로](CONSULT-WRITE.md)도 별도 점검용으로 추가했다.
> 각각 독립된 비활성화 설정을 유지하며, 기존 UI/운영 DB 연결 전환은 아직 수행하지 않았다.

## 완료 범위 / 아직 하지 않은 작업

기준 커밋 `7d12b43`, 시작 시 작업 트리 깨끗함. 보관함 추가·수정·삭제 API와
단일 기록을 원자적으로 변경하는 PostgreSQL 함수 초안을 구현했다.
**운영 DB 함수 설치, 환경변수 변경, 기존 브라우저 저장 연결 교체, 배포는 하지 않았다.**
화면/디자인/문구/애니메이션/기존 로그인·회원·상담 데이터는 변경하지 않았다.
SQL은 문서 폴더에만 있고 Netlify 빌드나 npm 테스트가 운영 DB에 자동 실행하지 않는다.

소스 백업:
`/Users/pj7/Documents/Codex/2026-09-01/git/backups/archive-write-54TL2T/source.tar.gz`

SHA-256: `c4377e45ac9a279b33d040b7c5d0e1d84dafdceced6f8ac3414eb7d951d54e0a`

## API와 기존 필드 호환

POST `/.netlify/functions/member-archive`:

```json
{"action":"create","readingId":"client-stable-id","record":{"id":"client-stable-id","time":123,"q":"질문","score":"★★★☆☆","favorite":false,"cards":["정방향","역방향","정방향"]}}
```

```json
{"action":"patch","readingId":"client-stable-id","revision":"조회 API에서 받은 43자 revision","patch":{"favorite":true}}
```

```json
{"action":"delete","readingId":"client-stable-id","revision":"조회 API에서 받은 43자 revision"}
```

- 기존 관리자 세션 + 본인 회원 세션 + 테스트 ID 목록을 모두 검사한다.
- 별도 `MEMBER_ARCHIVE_WRITE_MODE=rehearsal`이 있어야 쓰기를 시도한다.
  기본값은 비활성화이며, 읽기 점검만 활성화해도 쓰기는 열리지 않는다.
- 회원 ID는 서명된 세션에서 결정한다. body/query의 userId, 회원 배열, 권한,
  결제, 비밀번호, 임의 테이블/URL, 기록 ID 변경은 허용하지 않는다.
- create에는 재시도마다 같은 readingId와 같은 record를 사용한다. ID가 같은 기존
  기록을 다른 내용으로 덮어쓰는 create는 거부한다.
- patch는 명시한 리딩 필드만 바꾼다. 원본의 미확인 메타데이터는 보존하고,
  id/time/다른 리딩/회원 상태/관리자 메모는 바꾸지 않는다.
- 기존 별점 문자열, 카드 문자열 목록, AI 리포트 문자열, 저장 HTML,
  destinyReflection의 type/memo/time을 지원한다. 문자열·전체 요청 크기는 제한한다.
- 조회 API에 record별 HMAC revision을 추가했다. 회원 ID와 원본 전체 기록에 묶이며
  민감한 원본 메타데이터를 공개하지 않는다. 기존 화면은 새 API를 아직 쓰지 않는다.
- 별점 문자열과 reflection은 새 조회 API에도 보존하도록 보완했다.

저장 HTML은 원문 문자열로 보관한다. 실행 가능한 HTML이라고 신뢰하면 안 되며,
이후 화면 연결에서도 기존 `PJArchiveSecurity.restore`를 사용해야 한다.

## 동시 저장과 재시도

`sql/archive-write-v1.sql`의 `pjo_archive_apply_v1`은 다음을 한 트랜잭션에서 처리한다.

1. 기존 main 행을 SELECT FOR UPDATE로 잠근 후 최신 회원 배열을 읽는다.
2. 대상 회원이 하나인지, 인증 때의 자격 증명·상태가 여전히 같은지,
   회원/관리자 세션 및 이용 기간이 만료되지 않았는지 확인한다.
3. 같은 소유자의 해당 기록만 비교·교체한다. 다른 회원이나 같은 회원의 다른
   기록이 먼저 변경돼도 최신 내용을 보존한다.
4. 이미 똑같이 저장/삭제됐다면 unchanged, 내용이 먼저 바뀌었으면 conflict를 반환한다.
5. 기존 members 중 해당 기록과 updated_at만 수정한다. logs/guest_codes/다른
   회원 필드를 클라이언트의 오래된 스냅샷으로 덮어쓰지 않는다.

함수는 SECURITY INVOKER, 고정 search_path, service_role 전용 EXECUTE이며,
PUBLIC/anon/authenticated의 실행 권한을 제거한다. 새 테이블/열/RLS 변경이나
기존 함수 덮어쓰기는 하지 않는다. 같은 이름의 함수가 있으면 설치가 실패하므로
내용 확인 없이 OR REPLACE로 바꾸지 않는다.

근거: [PostgreSQL 행 잠금](https://www.postgresql.org/docs/current/explicit-locking.html),
[Supabase 함수 권한](https://supabase.com/docs/guides/database/functions).

**제한:** 기존 브라우저/관리자의 전체 main 행 upsert가 계속 허용되면, 함수가 끝난
다음 그 오래된 쓰기가 데이터를 덮을 수 있다. 함수 하나로 기존 쓰기의 위험까지 해결되지
않는다. 따라서 전체 쓰기 경로 전환·직접 접근 차단 전에는 운영용으로 활성화하지 않는다.

같은 기록에 대한 오래된 revision은 409 ARCHIVE_CONFLICT다. 자동으로 재시도하며
덮어쓰지 말고 다시 조회해 사용자 의도를 확인해야 한다. patch를 성공 후 같은 옛 revision으로
다시 보내도 충돌할 수 있다. create와 이미 사라진 기록의 delete는 중복 적용하지 않는다.

DB 응답 유실/시간 초과/응답 이후 세션 만료는 ARCHIVE_WRITE_UNCONFIRMED다.
**저장되지 않았다는 뜻이 아니다.** 이미 커밋됐을 수 있으므로 읽어서 확인해야 한다.
원본 DB 오류나 자격 증명은 반환하지 않고, 일반 table PATCH/upsert로 우회하지 않는다.

기존 프런트엔드는 60개 이후 오래된 기록을 잘라내지만 새 경로는 ARCHIVE_FULL로 멈춘다.
자동 삭제로 운영 데이터가 사라지는 일을 피하기 위한 잠정 동작이다. 기존 UI의 행동은
아직 변경하지 않았으며, 연결 전 보관 한도·삭제 정책을 사용자와 확정해야 한다.

## 검증

- 기존 54 + 신규 9 = **자동 테스트 63개 통과**. 비밀키 리터럴 검사 이상 없음.
- 별도 PGlite 0.5.8 인메모리 PostgreSQL SQL 통합 테스트 1개 통과. 한 테스트 안에서
  실제 함수 설치, anon/authenticated 실행 거부, 다른 회원/다른 기록 변경 보존,
  중복 create/delete, 오래된 update 거부, 인증 필드 변경/만료 후 거부,
  60개 한도, 잘못된 history, main 부재 시 생성 금지를 검증했다.
- 실제 회원/비밀번호/Supabase/유료 AI에 요청하지 않았다. 다운로드한 PGlite만
  임시 폴더에 놓았으며 운영 package 의존성은 추가하지 않았다.
- PGlite는 단일 연결이다. **실제 PostgreSQL의 두 세션 동시 잠금/대기, 운영
  Supabase RPC 캐시/권한/시간 제한, Safari 쿠키 왕복은 아직 검증하지 않았다.**
- outputs와 netlify.toml이 기준 커밋과 동일한지 Git으로 검사한다.

일반 테스트: `npm run test:security`

로컬 SQL 테스트는 별도 PGlite 설치 경로만 지정한다 (DB URL을 받지 않음):

```sh
PJO_TEST_PGLITE_PATH=/path/to/pglite/dist/index.cjs npm run test:archive:sql
```

이번 로컬 경로: `/private/tmp/pjo-archive-db-beiv2y/package/dist/index.cjs`
테스트 전용 tarball sha512:
`9fdb6c6d43a1c31d9ea4ad55d191bd02be121d6523bb4e1d866cd95e24815f006895e3af21f6a5b37dcd01a5a06a041500be116efc7f3edb2edcffa9034f5fe9`

## 다음 단계 / 수동 승인 경계

1. 상담 전송·가입·관리자 수정도 같은 원자적 접근 원칙으로 준비한다.
2. 운영 DB가 아닌 별도 시험 환경에서 함수 설치와 다중 세션 충돌 시험, 저장
   필드/한도 호환성·백업 복원·테스트 계정의 화면 연결을 검증한다.
3. 운영 전환 일정과 권한/비밀번호 처리 승인을 받은 뒤 배포·직접 DB 접근 차단을
   조율한다. 이전 클라이언트가 다시 whole-row 쓰기를 할 수 없어야 한다.

**지금 운영 Supabase에 SQL을 실행하거나 MEMBER_ARCHIVE_WRITE_MODE를 켜지 않는다.**
활성화 전까지 새 코드만 커밋/배포해도 쓰기는 비활성화되어 기존 UI 흐름이 유지된다.
