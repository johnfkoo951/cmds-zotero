[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

# CMDS Zotero

검증된 Zotero 원문·인용·주석·문헌노트를 로컬 중심 연구 볼트에 연결합니다. By CMDSPACE.

**0.2.0은 개발 버전이며 커뮤니티 승인 릴리스가 아닙니다.** Obsidian 1.13.7, Zotero 9.0.6 / Better BibTeX 9.0.63의 두 데스크톱 볼트에서 인덱스 재구축, APA 참고문헌, 텍스트/이미지 가져오기, 재가져오기 보존, 이름 변경 후 노트 딥링크 및 교차 볼트 조회를 실측했습니다. 그룹 라이브러리, 대화형 인용 선택창, Hookmark에서의 링크 수신·왕복은 수동 인수 검증이 남아 있습니다. 본인 워크플로우 검증 전에는 기존 통합 도구를 유지하세요.

## 범위

- Better BibTeX(BBT)의 Cite As You Write를 통한 인용 삽입.
- citekey와 실제 Zotero 문헌·첨부·주석 식별자를 분리한 버전형 JSON 인덱스.
- 미리보기와 보존 경계를 갖춘 독립적인 CMDS 내장 템플릿 기반 문헌·주석 가져오기.
- Zotero/PDF/근거 링크, 진단, paper-ingest 연동, 선택적으로 등록하는 다른 볼트 탐색.
- Hookmark에 전달할 수 있는 Markdown 링크 복사. Hookmark 북마크 생성이나 스크립팅은 하지 않습니다.

**Zotero Integration 또는 ZotLit 전체 호환 구현이 아닙니다.** 기존 템플릿을 그대로 사용할 수 있다고 가정하지 마세요. `persist`, `filterby`, `format`, `lastImportDate` 등 Nunjucks 확장의 드롭인 호환은 약속하지 않습니다. 원래 템플릿과 문헌노트는 보존하세요. 인용·참고문헌·텍스트/이미지 주석·재가져오기를 검증한 다음에만 다른 플러그인을 수동으로 끄세요.

## 요구사항

- Obsidian 데스크톱 **1.7.2 이상**. 모바일은 지원하지 않습니다.
- 실행 중인 [Zotero](https://www.zotero.org/)와 [Better BibTeX](https://retorque.re/zotero-better-bibtex/).
- 필요한 BBT RPC 응답 계약 지원. 버전 번호만으로 호환성을 보장하지 않으므로 연결/인덱스 진단을 확인하세요.
- 개발·유지보수 스크립트에는 **Node.js 22**가 필요합니다. 설치된 플러그인 사용에 별도 Node 설치는 필요하지 않습니다.

BBT `api.ready`, 필터링된 `item.search`, **BetterBibTeX JSON** 형식의 `item.export`, `item.attachments`, 참고문헌/CAYW 기능을 사용합니다. 메타데이터 수집과 첨부 보강은 별개입니다. Zotero native local API 활성화, Web API 키, SQLite 접근, 다른 플러그인의 PDF Utility는 필요하지 않습니다. 갱신은 전체 조회·export와 content hash 방식이며 **since-cursor 증분 동기화가 아닙니다**.

## 데이터·개인정보 고지

**네트워크.** 기본값 `http://127.0.0.1:23119/better-bibtex`인 로컬 BBT 서버로 인용·메타데이터·첨부/주석·참고문헌 요청을 보냅니다. 서지 텍스트와 인용 질의가 해당 서버와 교환됩니다. 엔드포인트는 본인 컴퓨터의 서버를 사용하세요. 문헌·PDF·다른 볼트 링크는 해당 URI를 처리하는 데스크톱 앱으로 전달됩니다. 사용자가 직접 여는 외부 웹사이트는 이 플러그인의 개인정보 경계 밖입니다.

**볼트 외부 파일.** Zotero 첨부 및 주석 이미지 경로는 볼트 밖을 가리킬 수 있습니다. 명시적인 가져오기 작업은 로컬 주석 이미지를 읽어 현재 볼트의 설정된 이미지 폴더에 복사할 수 있습니다. 다른 볼트 경로는 사용자가 선택적으로 등록하며 인덱스·노트의 읽기 전용 탐색에 사용됩니다. 다른 볼트에는 쓰지 않습니다. 인덱스에는 로컬 첨부 경로와 민감한 서지정보가 들어갈 수 있으므로 인덱스와 `data.json`을 공개하지 마세요.

**쓰기.** Zotero 원본은 읽기 전용입니다. 라이브러리 수정, citekey PIN, 데이터베이스·환경설정 변경을 하지 않습니다. 플러그인은 현재 볼트의 자기 설정·인덱스와 사용자가 요청한 노트·자산을 기록합니다. 기존 문헌노트를 조용히 다시 쓰지 않습니다. 텔레메트리, 자체 업데이트, 자체 HTTP 서버, 유료 서비스 연동은 없습니다. Hookmark는 별도 라이선스를 가진 선택적 소프트웨어이며 일반 Zotero 링크 사용에 필수가 아닙니다.

## 로컬 설치·이전

먼저 빌드합니다.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

새로 설치할 때는 `main.js`, `manifest.json`, `styles.css`만 `<vault>/.obsidian/plugins/cmds-zotero/`에 복사하고 **CMDS Zotero**를 수동으로 활성화하세요. 기존 `data.json`을 개발 환경의 파일로 덮어쓰지 마세요.

기존 `cmds-link-zotero`는 명시적·가역적 이전 도구로 옮길 수 있습니다. 아래 경로는 예시이며 실제 절대 경로로 바꾸어야 합니다. **check/apply/rollback 전에 Obsidian을 종료하고 볼트 동기화 쓰기를 중지하세요.** 해시는 변경을 감지하지만 프로세스 간 잠금은 아닙니다. 이 스크립트는 실행 중인 플러그인 활성화·비활성화, 프로토콜 실행, 앱 재로드를 하지 않습니다.

```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
# 변경 목록을 검토하고 check가 반환한 정확한 fingerprint를 넣습니다.
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode rollback
```

- 기본 `dry-run`과 `check`는 읽기 전용입니다. 빌드 파일·두 설치 폴더·활성 목록·단축키를 검사합니다.
- `--backup`은 **볼트와 저장소 모두의 바깥에 새로 생성할 디렉터리**여야 합니다. 부모 디렉터리는 이미 존재해야 합니다. 백업에는 개인 경로·설정이 포함되므로 비공개로 보관하세요.
- 선택적 `--source ABS`로 다른 빌드 폴더를 지정할 수 있습니다.
- Apply는 두 설치본과 레지스트리를 백업하고 fingerprint를 다시 확인한 뒤 세 배포 파일을 복사합니다. 새 `data.json`이 없을 때만 기존 설정을 복사합니다. 양쪽 설정이 다르면 자동 병합하지 않고 중단합니다.
- 활성 목록에 기존 ID가 있을 때만 새 ID로 치환합니다. 기존 ID가 없거나 꺼져 있으면 새 ID를 임의로 켜지 않습니다. 기존 단축키 접두사는 있을 때만 이전하며 대상 충돌 시 중단합니다. 다른 플러그인 설정·ID는 건드리지 않습니다.
- 기존 설치 폴더는 **삭제하지 않고 보존**합니다. 두 ID를 동시에 활성화하지 마세요. 이 도구는 잘못된 인덱스 식별자를 고치는 도구가 아닙니다. 설치 후 BBT로 인덱스를 재구축해야 합니다.
- `migration.json`과 해시 백업이 rollback을 지원합니다. 배포 후 파일·설정·레지스트리가 변경되었다면 덮어쓰기를 거절하므로 백업을 유지하고 충돌을 수동 해결하세요. 복구 후 설치 중 생성한 빈 폴더가 남을 수 있습니다.

이전 후 직접 앱을 실행해 새 ID만 활성화되었는지 확인하고 설정 보존·인덱스 갱신·명령을 검증하세요. 기능 대체가 실제로 확인될 때까지 이전의 다른 Zotero 플러그인도 설치 상태를 유지하세요.

## 인덱스·연동 계약

정본은 [`src/types.ts`](src/types.ts)입니다. 스키마 **2**는 `generatedAt`, `source: "better-bibtex"`, `count`, `entries`, `capabilities`, `diagnostics`, `complete`를 포함합니다. 문헌은 인용·표시 필드와 별개로 `libraryType` + 로컬 `libraryID` + 실제 `itemKey`를 사용합니다. 그룹 URI에는 실제 `groupID`가 추가로 필요합니다. CSL의 `id`와 citekey는 **item key가 아닙니다**. 첨부는 별도 key와 검증된 `openURI`를 가지며 주석 링크에는 첨부·주석 식별자와 1부터 시작하는 PDF 페이지가 들어갑니다. 인쇄된 페이지 라벨은 별도입니다.

조회 결과는 **resolved**, **ambiguous**, **not-found**, **unavailable**로 구분합니다. 첫 후보를 자동 선택하거나 오프라인을 문헌 부재로 해석하지 마세요. 기존 인덱스는 재구축 전까지 식별자를 신뢰할 수 없습니다. 첨부 보강 실패는 PDF가 없다는 증거가 아닙니다. 로컬 인덱스는 공개 테스트 fixture가 아닌 민감한 데이터입니다.

Paper ingest 서비스·CLI 계약은 [`src/ingest-api.ts`](src/ingest-api.ts), [`scripts/ingest.mjs`](scripts/ingest.mjs)를 참고하세요. 별도 HTTP 리스너를 만들지 않습니다. 소비자는 비동기 UI 명령을 실행했다는 이유만으로 완료를 추정하지 말고 direct-BBT/오프라인 fallback을 유지해야 합니다.

CLI는 데스크톱 CLI의 장시간 Promise 반환에 의존하지 않고, 용량이 제한된 메모리 작업을 한 번 시작한 뒤 종료된 JSON 결과를 기다립니다.

```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh
node scripts/ingest.mjs --vault "Research" --action resolve --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action diagnostics
```

가져온 노트는 `zoteroID`로 이름·citekey 변경 뒤에도 경로를 유지합니다. 최초 YAML은 사용자 관리 영역이며 이후 메타데이터는 관리 섹션에서 갱신됩니다. 이미지명에는 라이브러리와 content hash가 포함되어 원본이 바뀌면 새 버전을 추가하고 구버전·사용자 수정 이미지를 삭제하지 않습니다. 소유권 마커가 없는 기존 노트는 자동 편입하지 않으므로, 나란히 가져오려면 출력 폴더를 바꾸세요.

## 지원 경계와 검증

| 영역 | 구현 목표 | 인수 검증 경계 |
| --- | --- | --- |
| 개인 라이브러리 메타데이터·정식 링크 | BBT 기반 identity 해석 | 설치된 BBT 버전에서 확인 |
| 텍스트/이미지 주석·재가져오기 | CMDS 내장 템플릿과 플러그인 관리 영역 | 이미지 접근·사람 메모·충돌·재가져오기 실측 필요 |
| 그룹 라이브러리 | 로컬 library ID와 group ID 구분 | 합성/source 검증은 실제 그룹 검증이 아님 |
| 다른 볼트 | 명시적 등록·읽기 전용 조회와 이동 | 양쪽 인덱스와 노트 이름 변경 확인 |
| Hookmark | Zotero Markdown 링크 및 안정적인 노트 deep link 복사 | 링크 생성 지원만 의미하며 수신·왕복은 보장하지 않음 |
| 기존 플러그인/템플릿 | 이전 중 공존 | 전체 parity나 자동 비활성화 없음 |

실사용 전 오프라인/부분 실패 시 인덱스 보존, 첨부 없음, 중복 citekey, 최초 가져오기 → 사람 메모 → 재가져오기, 이미지 누락, PDF 페이지/주석 링크, 노트 이름 변경, 다른 볼트 이동, rollback을 검사하세요. 작은 사례를 확인하기 위해 대량 가져오기를 실행하지 마세요.

## 개발·릴리스 준비

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node scripts/sanitize.mjs           # 추적 중인 작업 파일 검사
node scripts/sanitize.mjs --staged  # Git index의 추가·변경 파일 검사
node scripts/version-bump.mjs 0.2.1 # package/lock/manifest/versions 동기화
node scripts/verify-release.mjs 0.2.1
```

테스트는 합성 데이터만 사용합니다. 새니타이저는 비밀값 대신 파일·줄·규칙만 출력하는 휴리스틱이며 staged diff와 private 저장소 링크의 수동 검토를 대체하지 않습니다. CI는 Node 22에서 `npm ci`, lint, typecheck, test, production build를 수행합니다. 준비된 릴리스 workflow는 manifest/package/lock/versions와 일치하는 **v 접두사 없는 정식 semver 태그**를 요구하며 세 플러그인 파일과 provenance bundle을 배포합니다. **해당 태그를 push하면 릴리스가 공개되므로 먼저 승인을 받으세요.** Workflow 준비는 릴리스·CI 성공·커뮤니티 등록을 완료했다는 뜻이 아닙니다.

## 저자·라이선스

[Yohan Koo (CMDSPACE)](https://cmdspace.work). MIT, [LICENSE](LICENSE) 참고.
