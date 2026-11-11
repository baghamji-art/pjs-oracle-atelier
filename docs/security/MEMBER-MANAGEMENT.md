# 회원가입과 관리자 이용권 변경 서버 경로

2026-10-15 기준. 사용자가 확정한 정책은 **가입 즉시 일반 회원으로 영구 이용**이다.
승인 대기를 새로 강제하지 않는다. 이번 구현은 서버 경로와 로컬 검증까지이며,
기존 화면 연결, 운영 DB 설치, 환경변수 변경, 배포는 포함하지 않는다.

## 가입 정책과 변경 범위

신규 가입은 서버가 `status=active`, `paid=true`, `tier=member`, `plan=permanent`,
`permanent=true`로 결정한다. 만료 값은 기존 화면과 같은 `4102444800000`을 사용한다.
이는 기존의 영구 이용 표시용 2100년 값이며 새로운 만료 정책을 도입한 것이 아니다.
클라이언트가 등급·승인 상태·권한·회원 배열을 함께 보내면 거부한다.

신규 비밀번호는 무작위 salt를 포함한 scrypt 해시로만 저장한다. 가입 재시도 식별용
`_registration` 메타데이터를 새 회원 JSON에 추가하지만 테이블이나 열은 변경하지 않는다.
기존 회원의 평문 비밀번호, 계정 상태, 이용권, 기록은 일괄 변환하지 않았다.
가입 API는 로그인 쿠키를 발급하지 않으므로 화면 연결 시 가입 성공 후 `member-login`을
호출해야 한다. `firstLoginAt`과 `lastLoginAt`은 새 가입 시 null이며 이번 단계에서
접속 시각 기록까지 구현한 것은 아니다.

## API와 접근 제한

모든 경로는 관리자 인증과 `MEMBER_ACCESS_MODE=rehearsal`, 명시적인
`MEMBER_REHEARSAL_IDS`를 요구한다. 일반 회원에게 공개하는 운영 모드는 아직 없다.
쓰기에는 별도로 `MEMBER_ACCOUNT_WRITE_MODE=rehearsal`이 필요하며 기본값은 disabled다.
가입은 `MEMBER_SIGNUP_POLICY=instant-permanent`도 필요하다. 기존 계정 대신 격리된
시험 DB의 가짜 계정만 대상으로 삼아야 한다.

| 경로 | 요청 | 처리 |
| --- | --- | --- |
| `member-register` | POST: id, password, requestId | 새 일반 회원 생성. 권한은 서버에서 고정 |
| `admin-member` | GET: memberId | 관리에 필요한 필드와 변경 확인용 revision만 반환 |
| `admin-member-update` | POST: action, memberId, revision, 작업별 값 | 승인·이용권·메모 중 한 작업만 실행 |

`approve`와 `set-entitlement`는 entitlement 객체의 plan, tier, permanent, expiresAt을
명시적으로 받는다. 허용 등급은 member/premium/vip이며 관리자 등급은 받지 않는다.
`approve`만 active/paid 상태와 승인 시각을 변경한다. `set-entitlement`는 기존 상태와
결제 표시를 유지하므로 만료·대기 상태를 자동으로 승인하지 않는다.
`set-memo`는 memo만 바꾼다. 회원 삭제, 비밀번호 재설정, 갱신 신청, 상태 변경 등
다른 기존 관리자 기능은 아직 이 경로로 옮기지 않았다.

관리 응답에는 비밀번호·해시·가입 재시도 메타데이터·보관함을 포함하지 않는다.
POST는 허용 Origin과 JSON만 받으며, 응답은 no-store로 처리한다. 서버 오류 본문이나
키를 응답에 내보내지 않고 자동 재시도 및 기존 전체 배열 저장으로의 우회도 하지 않는다.

## 충돌과 데이터 보존

`sql/member-management-v1.sql`은 service_role만 실행할 수 있는 두 새 함수를 만든다.
기존 이름이 있으면 실패하며 OR REPLACE로 덮어쓰지 않는다. 함수 설치 자체는 기존
테이블·열·RLS·회원 자료를 변경하지 않는다.

함수는 main 행을 잠근 뒤 최신 데이터를 읽고 해당 회원만 수정한다. 관리 정보나
비밀번호가 바뀌었으면 오래된 revision으로 덮어쓰지 않고 충돌을 반환한다. 새 보관함
기록과 다른 회원의 변경은 보존한다. 잠금과 실행 권한의 근거는
[PostgreSQL 행 잠금](https://www.postgresql.org/docs/current/explicit-locking.html)과
[Supabase 함수 권한](https://supabase.com/docs/guides/database/functions) 문서를 따른다.

같은 가입 requestId와 비밀번호로 재요청하면 기존 계정을 확인하고 새 해시로 교체하지
않는다. 다른 요청의 기존 ID와 삭제 기록이 남은 ID는 재사용하지 않는다. 가입 최대
10,000명, members+logs JSON 약 7MiB 제한을 적용하며 초과 시 기존 기록을 삭제하지 않는다.
관리 변경으로 이 크기를 넘는 경우도 저장하지 않는다.

`MEMBER_CONFLICT`는 최신 회원 정보를 다시 읽어야 한다는 뜻이다.
`MEMBER_WRITE_UNCONFIRMED`는 실패 확정이 아니다. 응답 유실 직전에 저장됐을 수 있다.
가입은 같은 requestId/내용으로 확인하고, 관리 변경은 다시 읽어 적용 여부를 확인한다.
`MEMBER_STORAGE_FULL`이면 저장 구조와 용량을 검토해야 한다.

## 파일과 검증

새 서버 파일은 `member-register.js`, `admin-member.js`, `admin-member-update.js`,
`lib/member-management.cjs`, `lib/member-account-rpc.cjs`다. SQL 초안과 단위/SQL 테스트를
추가했고 `.env.example` 및 `package.json`의 테스트 명령을 갱신했다.
기존 상담·보관함 단계의 미커밋 변경은 보존했다.

- 보안 회귀 테스트 79개 통과. 신규 회원 관리 테스트 8개 포함.
- 로컬 PGlite SQL 통합 테스트 4개 통과. 가입 API → SQL 저장 → 로그인 → 세션 검증 포함.
- 권한 상승 입력, 만료 세션, 오래된 관리 정보, 중복 가입, 용량 초과, 기존 회원·상담·기록
  보존을 검증했다. 실제 회원이나 운영 DB에는 쓰지 않았다.
- 비밀키 리터럴 검사와 `git diff --check` 통과. `outputs/`와 `netlify.toml`은 HEAD 대비
  변경 없음. 디자인·반응형·버튼·카드 데이터·배포 경로를 수정하지 않았다.

```sh
npm run test:security
PJO_TEST_PGLITE_PATH=/path/to/pglite/dist/index.cjs npm run test:member-management:sql
```

PGlite 0.5.8은 임시 위치에서만 사용하며 운영 의존성을 추가하지 않았다. 단일 연결
시험이므로 실제 다중 PostgreSQL 세션의 잠금 대기와 운영 Supabase RPC, Safari 화면
왕복까지 검증한 것은 아니다.

변경 전 복구용 백업:
`/Users/pj7/Documents/Codex/2026-09-01/git/backups/member-management-goCg6j/source.tar.gz`

SHA-256: `bf9bc99189ff90181099b7de980c177fcd7b180c2f3c5bd81ab004f4be280a29`

## 운영 전환 전에 남은 일

현재 브라우저에는 전체 main 행 읽기·쓰기와 평문 인증 경로가 남아 있다. 이 경로가
새 서버 변경을 다시 덮어쓸 수 있고, 기존 영구 이용 보정 코드도 기간 변경을 되돌릴 수
있다. 따라서 **새 함수만 설치하거나 플래그만 켜서 운영 전환하면 안 된다.**

남은 관리자 변경 기능과 사용자 화면을 서버 경로로 연결하고, 기존 인증·전체 배열 저장을
제거하는 전환안을 함께 검증해야 한다. 기존 자격 증명 전환, 접속 시각 기록, 요청 제한,
격리 환경의 백업 복원·다중 세션·모바일 테스트, 직접 DB 접근 차단을 완료한 뒤 운영
배포와 권한 변경을 조율한다. 실제 사용자 가입에 관리자 쿠키를 요구하는 시험용 제한도
공개 가입용 보호 장치를 갖춘 별도 경로로 교체해야 한다.

**현재 Critical 보안 문제가 모두 해결된 상태는 아니다. 운영 Supabase SQL 실행이나
Netlify 플래그 변경은 아직 요청하지 않는다.**
