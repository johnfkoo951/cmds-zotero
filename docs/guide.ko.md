# CMDS Zotero 개발 버전 사용설명서
검증된 Zotero 식별자, 인용, 주석, 문헌 노트를 연구 볼트에 연결합니다. Zotero는 읽기 전용으로 다루고 사람이 쓴 노트는 보존합니다.

## 먼저 확인할 개발 상태
**0.3.0은 개발 버전이며 공개 플러그인 릴리스가 아닙니다.** **2026-09-14** 기준 공개 저장소에는 GitHub Release가 없고 Obsidian Community Plugins 목록에도 없습니다. **공개 `main`의 코드는 아직 0.2.0입니다. 이 설명서는 공개 복제로 받을 수 있는 코드가 아니라 미공개 로컬 0.3.0 개발본을 설명합니다.** 저장소 복제나 릴리스 다운로드로 0.3 기능을 받을 수는 없습니다. 별도 0.4 개발은 이 설명서나 설치 약속에 포함되지 않습니다.
과거 0.2 기준선은 Obsidian 1.13.7, Zotero 9.0.6, Better BibTeX 9.0.63에서 인덱스 재구축, APA 참고문헌, 텍스트/이미지 가져오기, 재가져오기 보존, 개명 노트 링크, 교차 볼트 검색을 시험했다고 기록합니다. **0.3의 모든 기능을 새로 검증했다는 뜻은 아닙니다.** 그룹 라이브러리 실사용, 대화형 인용 선택기, Hookmark 수신/왕복은 수동 확인이 필요합니다.
백업한 테스트 볼트에서 사용하고 본인 작업이 검증될 때까지 기존 연동을 유지합니다. ZotLit/Zotero Integration 전체 호환이나 기존 Nunjucks 템플릿의 즉시 교체를 제공하지 않습니다.

## 준비물과 용어
- **Obsidian 데스크톱 1.7.2 이상**. 모바일 미지원.
- 실행 중인 [Zotero](https://www.zotero.org/)와 [Better BibTeX](https://retorque.re/zotero-better-bibtex/). BBT는 이 플러그인이 사용하는 로컬 인용/메타데이터 기능을 제공하는 Zotero 추가 기능입니다.
- 기본 로컬 주소 `http://127.0.0.1:23119/better-bibtex`. Zotero Web API 키, native Local API 설정 변경, SQLite 접근, 별도 PDF 도구는 이 구현에서 필요 없습니다.
- 첫 시험용 자료 하나와 로컬 PDF, 비민감 텍스트 주석 하나. 이미지 주석 가져오기에는 읽을 수 있는 원본 이미지 파일도 필요합니다.
- **Node.js 22**는 빌드/유지보수 스크립트용이며 설치된 플러그인 사용의 별도 필수조건은 아닙니다. 플러그인은 MIT, Zotero 저장 서비스나 선택적 유료 Hookmark의 조건은 별도입니다.
**citekey**는 `Example2026` 같은 인용 라벨이며 영구 항목 식별자가 아닙니다. 정식 식별은 라이브러리 종류, 로컬 library ID, Zotero item key를 함께 사용합니다. 첨부와 주석에는 별도 ID가 있으며 부모 항목이 곧 PDF는 아닙니다.

## 로컬 시험용 빌드와 설치
아직 공개 릴리스 파일이나 공개된 0.3 소스는 없습니다. **공개 `main`을 복제하고 아래 명령을 실행하면 이 설명서의 0.3이 아니라 0.2 기준선이 빌드됩니다.** 공개 기준선을 시험하려면 [해당 버전의 README](https://github.com/johnfkoo951/cmds-zotero/blob/b58adb733bcd5bc0734ca2f31d6cb420fd8e8fbe/README.md)를 따릅니다.
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
먼저 빌드한 `manifest.json`을 확인합니다. 현재 공개 main 빌드는 **0.2.0**이며, 아래 0.3 전용 자동완성/사이드바/설정 동작을 그 빌드에서 보장하지 않습니다. `main.js`, `manifest.json`, `styles.css`만 `<vault>/.obsidian/plugins/cmds-zotero/`에 복사합니다. Obsidian을 다시 로드하고 **CMDS Zotero**를 직접 활성화합니다. 다른 컴퓨터의 설정/개인 인덱스를 복사하지 않습니다. 위 명령은 사용 안내이며 이번 문서 작업에서 실행했다는 뜻은 아닙니다.
기존 `cmds-link-zotero`에서 이전한다면 아래 전용 이전 절차를 사용합니다. 실행 중 설치본을 덮어쓰거나 두 ID를 동시에 활성화하지 않습니다.

## 첫 성공: 연결, 인덱스, 자료 하나 가져오기
아래 절차와 기능 사전은 **미공개 로컬 0.3 개발 환경**을 설명합니다. 해당 소스가 없는 독자에게는 개발 미리보기이며, 공개 저장소를 복제한 경우에는 위의 0.2 기준선 안내를 사용합니다.
1. Better BibTeX이 활성화된 Zotero를 실행합니다.
2. **설정 → CMDS Zotero**에서 **Server endpoint**, **Output folder**, **Image folder**, **Index path**를 확인합니다. 출력/인덱스 경로는 볼트 상대경로입니다.
3. **Save configuration**을 먼저 누릅니다. 수정값은 저장 전까지 초안이며 **Test connection → Test**는 저장된 설정을 시험합니다.
4. Ctrl/Cmd+P의 **Refresh citekey index**를 실행합니다. 전체 발견/내보내기와 제한된 동시 첨부 요청을 수행하며 서버의 증분 커서 동기화가 아닙니다.
5. **Diagnose index and links**로 사용 불가/모호한 식별을 먼저 확인합니다.
6. **Search literature** 또는 **Import literature note**에서 예제 자료를 고르고 **Literature import preview**의 경로, 내용, 충돌을 확인합니다.
7. 맞으면 **Apply import**를 누릅니다. 충돌이 있으면 버튼이 비활성화됩니다. 새 노트 또는 플러그인 소유 구역만 다루며 임의의 기존 산문을 덮어쓰지 않습니다.
8. 가져온 노트에서 Zotero/PDF 링크와 텍스트 주석을 원본과 비교합니다.
9. 생성 마커 밖의 본인 구역에 문장을 쓰고 다시 가져와 그대로 남는지 확인합니다. 일괄 갱신 전에 반드시 작은 시험을 합니다.
자료 식별, PDF/주석 링크, 사람 글 보존이 모두 맞아야 첫 성공입니다. 연결 성공만으로 특정 첨부가 존재한다고 판단하지 않습니다.

## 인용과 사이드바 작업
### 글을 쓰며 인용
편집기에서 **Insert citation from Zotero**를 실행하면 BBT의 대화형 Cite As You Write 선택기(CAYW)를 사용합니다. 기본 `pandoc` 형식은 `[@citekey]`입니다. 선택기 흐름은 사용 환경에서 별도 확인해야 합니다.
0.3 소스에는 로컬 자동완성도 있습니다. `[@` 뒤에 ASCII citekey/제목/저자/연도 일부를 입력하고 공백 대신 `_`를 사용할 수 있습니다. 현재 트리거는 영문/숫자와 `_ : . + / -`를 최대 80자까지 받으며 한글 입력은 받지 않습니다. Enter는 `[@citekey]`를 완성하고 기존 대괄호 안에서는 Shift+Enter도 괄호를 유지합니다. 괄호 밖 Shift+Enter의 단독 `@citekey` 삽입은 기본값이 아닌 bare-at 트리거를 설정한 경우에 적용됩니다. 위키링크 완성도 기존 구조를 유지합니다. 매 키 입력마다 BBT를 부르는 것이 아니라 캐시된 인덱스를 읽고, 준비/갱신은 백그라운드에서 일어날 수 있습니다.
데이터 모델에는 `bracket`, `at`, `off`가 있지만 **확인한 0.3 UI에는 “Writing → Citekey completion” 설정이 없습니다.** 과거 README/changelog의 해당 표현을 설치 안내로 따라가지 않습니다. 첫 사용은 기본 대괄호 트리거로 시험합니다.
### References 사이드바
**Open references sidebar**는 현재 노트의 `[@key]`, 단독 `@key`, 인용 위키링크를 찾습니다. frontmatter/코드 펜스를 제외하고 자료를 중복 제거하며 선택한 CSL 스타일의 참고문헌과 모호/미해결 상태를 보여줍니다. 노트, Zotero 항목, PDF를 열고 인용 텍스트를 선택해 첫 출현으로 이동할 수 있습니다. 참고문헌 복사는 일반 텍스트이지 Word의 동적 인용 필드가 아닙니다.
### Annotations 사이드바
**Open annotations sidebar** 또는 형광펜 리본은 식별된 문헌 노트나 고정한 자료를 따릅니다. 색, 페이지 라벨, 텍스트, 메모, 태그를 보고 Zotero 열기, 커서 삽입, 링크/텍스트 복사를 수행합니다. 이미지 카드는 바이트 복사 없이 링크만 넣을 수 있으므로 검증된 볼트 사본이 필요하면 명시적 가져오기를 사용합니다. Zotero 리더의 실시간 위치 추종은 아닙니다.
### 인용 노트 찾기와 갱신
**Find notes citing a source**는 현재/과거 citekey를 검색합니다. **Update all owned literature notes**는 보존 엔진으로 소유 노트를 즉시 순회해 갱신/동일/건너뜀 결과를 보고하고 충돌을 제외합니다. **항목마다 승인 미리보기를 열지 않습니다.** 백업과 단일 노트 재가져오기 시험 뒤에 실행합니다.

## 전체 명령어 사전

| 실제 명령 이름 | 기능과 경계 |
|---|---|
| Insert citation from Zotero | 활성 편집기에서 대화형 CAYW 삽입 |
| Refresh citekey index | 로컬 BBT에서 전체 인덱스 갱신 |
| Search literature | 인덱스 자료 선택과 동작 열기 |
| Open source PDF at page | 자료와 PDF 파일 페이지 선택, 1부터 시작 |
| Import literature note | 단일 자료 보존형 가져오기 미리보기 |
| Update all owned literature notes | 소유 구역 일괄 갱신; 노트별 재확인 없음 |
| Insert bibliography | 선택한 자료 하나의 CSL 참고문헌을 편집기에 삽입 |
| Open references sidebar | 현재 노트의 인용 검토 |
| Open annotations sidebar | 식별/고정 자료 주석 검토와 삽입 |
| Find notes citing a source | 현재/과거 citekey 출현 검색 |
| Copy Hookmark-compatible link | 검증된 Zotero Markdown 링크 복사; Hookmark 북마크 생성 아님 |
| Copy stable literature note link | 항목 식별 기반 노트 이동 링크 복사 |
| Diagnose index and links | 연결/인덱스/식별 진단 |
| Find literature across vaults | 허용한 다른 볼트 맵 읽기와 이동 |

PDF 페이지는 **1부터 시작하는 파일 위치**이지 인쇄 페이지 라벨이 아닙니다. “12”라고 인쇄된 쪽이 파일에서는 18번째일 수 있습니다. 그룹 링크는 로컬 library ID와 다른 실제 group ID가 필요합니다. 누락/모호한 자료를 첫 검색 결과로 임의 대체하지 않습니다.

## 0.3.0의 실제 설정
수정 후 **Save configuration**을 누릅니다. 저장 전 Test/Refresh는 기존 값을 사용하고 인덱스 갱신 서비스가 바쁘면 설정 변경이 차단됩니다.

| 화면의 설정 | 기본값, 범위, 의미 |
|---|---|
| Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost HTTP(S), 인증/쿼리/fragment 없는 주소 |
| Test connection | 저장된 주소 시험; 인용 선택기를 열지 않음 |
| Request timeout | 20초, 1–180 |
| Attachment timeout | 60초, 1–180 |
| Index path | `80. References/zotero-index.json`, 볼트 상대경로 |
| Maximum index age | 60분, 1–10080; 오래된 조회는 전체 스냅샷 갱신 가능 |
| Parallel requests | 2, 1–8 동시 첨부 요청 |
| Refresh saved index | 저장된 설정으로 갱신 |
| Output folder | `References/Zotero`, 새 문헌 노트 |
| Image folder | `References/Zotero/images`, 명시적으로 가져온 주석 이미지 |
| Bibliography style | `apa`, Zotero에 설치된 CSL 스타일 |
| Citation format | `pandoc`, CAYW 형식 |
| Peer vaults | 기본 비어 있음; 한 줄마다 볼트 이름, 파이프, 절대 폴더 경로 |
| Save configuration | 초안 설정 검증과 저장 |

스키마에는 `citationTrigger`, `excludedTags`(기본 `obscite`), `headingHighlightColor`(기본 gray), `referencesFollowActiveNote`(true)도 있습니다. **현재 설정 탭에 대응 제어가 없는 데이터 모델 필드입니다.** 존재하지 않는 Excluded tags/제목 색상 UI를 찾지 않습니다. 설정 파일 수동 수정은 첫 사용의 필수 절차가 아닙니다.

## 가져온 노트 구조와 보존
내장 템플릿은 Cite/Abstract/메타데이터/Link와 Highlight/Image/Note 콜아웃을 사용합니다. 별도 Dataview가 있으면 인라인 필드도 활용할 수 있습니다. 하이라이트는 가까운 Zotero 팔레트 색을 사용하고 기본 gray 제목 색은 5단계 제목으로 바뀝니다. 제외 태그는 데이터 모델에 따라 빠집니다.
초기 frontmatter에는 식별키와 `zotero_title`, `zotero_author`, `zotero_year`, 학술지, DOI, URL, 태그가 들어갑니다. **생성 이후 frontmatter는 사용자 소유**이며 최신 메타데이터는 관리되는 본문 구역에 반영됩니다. `zoteroID`는 노트 개명/citekey 변경 뒤에도 위치를 유지하도록 돕습니다.
소유 구역 ID는 `overview`, `citation`, `metadata`, `notes`와 주석별 식별자입니다. 양식 정리라며 소유 마커를 지우지 않습니다. 생성 구역을 사람이 고치면 충돌을 감지하므로 본인의 분석은 비소유 구역에 쓰고 강제 덮어쓰기를 피합니다.
기존 비소유 노트는 자동 인수하지 않습니다. 별도 출력 폴더에 나란히 가져옵니다. 이미지 파일명에는 라이브러리 식별과 콘텐츠 해시가 들어가며 원본 변화는 새 버전을 만들고 이전/사용자 수정 이미지를 지우지 않습니다.

## 교차 볼트와 Hookmark
다른 볼트 접근은 명시 동의한 읽기 전용입니다. 이름과 절대경로를 등록하고 각 볼트의 인덱스/맵을 갱신한 뒤 **Find literature across vaults**를 사용합니다. 다른 볼트의 같은 citekey가 자동으로 같은 자료는 아니므로 정식 식별을 확인합니다.
Hookmark-compatible은 복사 가능한 Markdown 링크입니다. Hookmark 설정 변경, 스크립트 실행, 북마크 생성은 하지 않으며 일반 Zotero 이동에 Hookmark가 필요하지도 않습니다. 수신 앱을 따로 시험한 뒤 왕복 호환을 판단합니다. 개명 노트 딥링크에는 올바른 플러그인 설치와 식별 맵이 필요합니다.

## 데이터와 개인정보
로컬 BBT에 메타데이터, 인용 선택, 참고문헌, 첨부/주석을 요청합니다. 주소 검증은 로컬 HTTP(S)로 제한합니다. Zotero는 **읽기 전용**이며 설정/DB 변경, citekey 고정, 라이브러리 기록 수정이 없습니다.
명시적 이미지 가져오기는 **볼트 밖의** 첨부/주석 이미지 파일을 읽고 이미지 폴더에 복사할 수 있습니다. 설정한 경우 다른 볼트 맵도 읽습니다. 설정, 인덱스, 맵, 진단 보고에는 개인 경로, 서지정보, 주석과 식별자가 들어갈 수 있으므로 공개하지 않습니다.
런타임은 현재 볼트의 설정, 인덱스, 요청한 노트, 가져온 이미지를 씁니다. 텔레메트리, 자체 HTTP 리스너, 자체 업데이트, 내장 유료 서비스는 없습니다. 명시적으로 연 웹/외부 앱 링크는 해당 앱 정책을 따릅니다. 로컬 우선이라고 나중의 Share/AI 공개까지 자동으로 안전해지는 것은 아닙니다.

## 문제 해결과 수용 시험

| 증상 | 다음 확인 |
|---|---|
| Test가 옛 주소를 사용 | Save configuration 후 Test |
| 연결 실패 | Zotero 실행, BBT 설치/활성화, localhost 주소, 요청 시간 |
| 갱신 실패/일부 누락 | 진단을 읽고 마지막 유효 스냅샷 보존; 실패를 빈 라이브러리로 간주하지 않기 |
| 자동완성 결과 없음 | `[@` 사용, 인덱스 준비/갱신, 제목/citekey 확인; 없는 UI 토글 찾지 않기 |
| citekey가 틀리거나 모호함 | 정식 식별 확인; 중복키를 첫 결과로 대체 금지 |
| PDF가 다른 쪽으로 열림 | 인쇄 라벨이 아닌 파일 페이지와 첨부 식별 확인 |
| 주석 이미지 없음 | 원본 파일의 존재/읽기 권한 확인, 사이드바 삽입 대신 명시적 가져오기 |
| 가져오기 차단 | 수동 편집, 소유권, 중복 식별, 경로 충돌 확인; 원본 보존 |
| 그룹 링크 실패 | 실제 group ID/로컬 library ID 구분; 실사용 검증 미완 |
| 다른 볼트 노트 없음 | 허용 경로, 양쪽 맵 갱신, 정식 식별과 실제 위치 확인 |

의존하기 전에 오프라인/부분 갱신 보존, 누락 첨부, 중복 citekey, 가져오기→사람 글→재가져오기, 이미지 누락, PDF/주석 이동, 노트 개명, 교차 볼트 이동, 롤백을 확인합니다. 일괄 성공으로 작은 보존 시험을 대신하지 않습니다.

## 옛 플러그인 ID에서 이전
`scripts/migrate-local.mjs` 사용 전 Obsidian을 종료하고 동기화 writer를 멈춥니다. 도구가 실행 중 플러그인을 대신 멈추지는 않습니다. `dry-run`과 `check`는 읽기 전용이고 `apply`는 파일/레지스트리를 쓰며 check의 정확한 fingerprint가 필요합니다. 계획을 검토하고 **볼트/저장소 밖의 새 비공개 백업 폴더**를 사용합니다. 부모 폴더는 미리 있어야 합니다.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
```
검토 후에만 적용합니다.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
```
양쪽 설치/레지스트리를 백업하고 파일 3종을 설치하며 기존 옛 ID 활성화/단축키만 매핑하고 옛 설치본은 남깁니다. 새 설정 파일이 없을 때만 옛 설정을 복사하며 설정/단축키 충돌 시 중단합니다. 비활성이던 연동을 켜거나 다른 플러그인을 끄지 않고 옛 인덱스 식별도 복구하지 않으므로 이후 재구축합니다.
롤백은 명시적으로 실행합니다.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode rollback
```
롤백은 배포 이후 바뀐 파일/설정을 덮어쓰지 않고 거부합니다. 백업을 유지해 충돌을 수동 해결합니다. 재시작 후 의도한 새 ID만 활성화되었는지, 설정/인덱스/자료 하나가 맞는지 확인합니다. 이 설명서 작성 중 실제 이전은 실행하지 않았습니다.

## 연동과 개발 참고
아래 구현 설명은 로컬 0.3을 확인한 결과입니다. 공개 소스 링크는 현재 받을 수 있는 0.2 기준선을 가리키며 0.3 전체 구현이 공개됐다는 근거가 아닙니다.
[소스 타입](https://github.com/johnfkoo951/cmds-zotero/blob/main/src/types.ts)의 schema 2는 생성 시각, 개수, 항목, 기능, 진단, 완전성을 정의합니다. `resolved`, `ambiguous`, `not-found`, `unavailable`을 구분하며 레거시 인덱스는 재구축 전까지 정식 식별을 신뢰하지 않습니다.
[ingest API](https://github.com/johnfkoo951/cmds-zotero/blob/main/src/ingest-api.ts)와 [CLI](https://github.com/johnfkoo951/cmds-zotero/blob/main/scripts/ingest.mjs)는 별도 HTTP 서버 없이 제한된 작업/결과 계약을 제공합니다. UI 명령 실행만으로 완료 데이터를 얻었다고 가정하지 말고 direct-BBT/오프라인 대안을 유지합니다.
```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh
node scripts/ingest.mjs --vault "Research" --action resolve --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action diagnostics
```
가상 볼트/키를 사용한 예입니다. Obsidian과 의도한 CLI/API 경로가 있어야 하며 원격 SaaS 엔드포인트가 아닙니다.
개발 검사는 lint, typecheck, tests, build입니다. 릴리스 자동화 파일이 있다는 사실은 공개 배포 완료가 아닙니다. `v` 없는 semver 태그는 릴리스 워크플로를 실행하므로 문서/로컬 시험 단계에서 push하지 않습니다.

## 업데이트, 지원, 라이선스
[웹 설명서](https://apps.cmdspace.work/plugins/cmds-zotero/) | [저장소](https://github.com/johnfkoo951/cmds-zotero) | [문제 신고](https://github.com/johnfkoo951/cmds-zotero/issues) | [변경 이력](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md).
실제 실행 버전의 소스/배포 설명을 사용합니다. 신고에는 플러그인/Obsidian/Zotero/BBT 버전, OS, 비밀정보를 제거한 진단, 가상 레코드를 넣습니다. 실제 인덱스, 개인 첨부 경로, 주석 원본, 설정을 게시하지 않습니다. 대체 작업이 검증되기 전까지 기존 연동을 유지합니다.
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. MIT, [LICENSE](https://github.com/johnfkoo951/cmds-zotero/blob/main/LICENSE).
루트 0.3의 `main.ts`, `settings.ts`, `settings-data.ts`, `types.ts`, `modals.ts`와 배포 상태를 확인했습니다. 새 가져오기, 이전, 그룹/Hookmark 시험, 별도 0.4 개발은 실행하지 않았습니다. 현재 스크린샷을 촬영했다고 주장하거나 꾸며내지 않았습니다.
