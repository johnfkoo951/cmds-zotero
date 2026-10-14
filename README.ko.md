[![English](https://img.shields.io/badge/English-README.md-blue)](README.md)

# CMDS Zotero

검증된 Zotero 원문·인용·주석·문헌노트를 로컬 중심 연구 볼트에 연결합니다. By CMDSPACE.

**0.6.0(2026-10-14).** [0.6.0 릴리스](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.6.0)에서 `main.js`, `manifest.json`, `styles.css`를 받거나 BRAT로 `johnfkoo951/cmds-zotero`를 설치합니다. Community Plugins에는 아직 등록하지 않았습니다. 0.6은 인덱스 새로 고침·시작·편집·일괄 갱신을 빠르게 하고, 문제 있는 항목·피드·EPUB·스냅숏 주석이 있어도 새로 고침이 멈추지 않게 하며, 인용 선택기가 취소 버튼과 함께 기다리게 하고, 다시 정리한 설정 탭에서 모든 설정을 바꿀 수 있게 합니다. 에이전트 액션 `annotations`·`citing`, `resolve --stdin`, 줄 단위 `reconcile --apply`도 추가합니다. 0.5는 **Send recently read papers to notes**를 추가했습니다. [변경 기록](CHANGELOG.md)을 참고하세요. 사용설명서: [docs/guide.ko.md](docs/guide.ko.md) · [웹](https://apps.cmdspace.work/plugins/cmds-zotero/?lang=ko) · [English](docs/guide.md). Obsidian 1.14.4, Zotero 10.0.6, Better BibTeX 9.0.71(macOS)에서 검증했으며 그룹 라이브러리와 Windows/Linux는 실사용 검증 범위가 아닙니다.

## 범위

- Better BibTeX(BBT)의 Cite As You Write를 통한 인용 삽입.
- citekey와 실제 Zotero 문헌·첨부·주석 식별자를 분리한 버전형 JSON 인덱스.
- 미리보기와 보존 경계를 갖춘 독립적인 CMDS 내장 템플릿 기반 문헌·주석 가져오기.
- Zotero/PDF/근거 링크, 진단, paper-ingest 연동, 선택적으로 등록하는 다른 볼트 탐색.
- Hookmark용 Markdown 링크 복사(Zotero 항목·Obsidian 파일·이름 변경에 안전한 identity 링크)와 "커서 아래 링크 열기" 명령. Hookmark 북마크 생성, 스크립팅, frontmatter hook 기록은 하지 않습니다.
- 로컬 인덱스만으로 동작하는 인라인 `[@` citekey 자동완성, 활성 노트의 CSL 참고문헌 사이드바, 주석 사이드바, 인용 노트 역조회, 소유 노트 일괄 갱신.

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

**로컬 프로세스.** 에이전트 요청을 처리할 때 플러그인은 볼트에서 `git`을 읽기 전용으로 실행합니다(`ls-files`, `check-ignore`, optional lock 끔). 인덱스와 비공개 캐시가 추적되는지, 무시되는지를 알리기 위해서이며 그 밖의 프로그램은 실행하지 않습니다.

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

## Zotero에서 읽고 문헌노트로 보내기

1. 평소처럼 Zotero 리더에서 PDF를 읽고 하이라이트합니다. Zotero 10은 PDF를 마지막으로 연 날짜를 기록합니다.
2. **Send recently read papers to notes**를 실행합니다(명령 팔레트 또는 펼친 책 리본 아이콘). 최근 30일(7/30/90/365일, 설정 *Recently read window*) 안에 읽은 논문이 최신순으로 나오고, 노트마다 상태가 표시됩니다: *No literature note yet*(노트 없음), *N new annotations not in the note*(새 주석 N개), *Note is up to date*(최신), CMDS Zotero가 만들지 않은 노트(절대 덮어쓰지 않음).
3. 보낼 필요가 있는 논문이 미리 선택됩니다. **Send**는 노트를 새로 만들거나 Zotero의 현재 데이터로 관리 구역만 갱신합니다. 사용자가 쓴 내용(프론트매터, `## Synthesis`, `## Notes`, 편집하거나 detach한 블록)은 보존됩니다. 노트 버튼으로 결과를 엽니다.

목록을 보려면 Zotero가 실행 중이어야 합니다(Better BibTeX로 읽기 기록을 조회). **Import literature note**도 최근 읽은 논문을 맨 위에 보여 주고 최신 데이터로 가져오며, Zotero가 꺼져 있으면 저장된 인덱스를 쓴다고 알립니다. 에이전트는 같은 경로를 `recent`·`import`로 씁니다(아래).

## 사이드바로 쓰고 검토하기

- **citekey 자동완성.** `[@` 뒤에 citekey·제목·저자·연도 일부를 입력합니다(공백은 `_`). Enter는 `[@citekey]`, Shift+Enter는 `@citekey`를 넣고, `[[` 안에서는 위키링크 형태로 완성합니다. 서제스터는 로컬 인덱스만 읽으며 캐시가 없으면 백그라운드 로드를 시작합니다. 트리거를 "At sign"으로 바꾸면 단어 시작의 `@` 뒤에서도 동작하고, "Off"로 끌 수 있습니다.
- **참고문헌 사이드바**(`Open references sidebar`). 활성 노트의 `[@key]`, `@key`, `[[@key]]`를 프론트매터와 코드펜스를 제외하고 스캔해 문헌마다 한 번씩 BBT의 설정 스타일 참고문헌을 표시합니다. 미해결·중복 키는 이유와 함께 붉게 표시됩니다. 문헌노트·Zotero 항목·PDF 열기, 첫 인용 위치로 이동, "Copy bibliography"로 목록 복사가 가능합니다.
- **주석 사이드바**(`Open annotations sidebar`, 리본 형광펜). 활성 문헌노트를 `zoteroID`, select URI, ZotLit 키 또는 `@citekey` 파일명으로 따라가거나 임의 항목을 고정합니다. 카드마다 색상·페이지 라벨·본문·코멘트·태그를 보여주며, Zotero 리더에서 열기, 가져오기와 동일한 콜아웃으로 커서 위치에 삽입, 링크 복사, 텍스트 복사를 지원합니다. 이미지 주석은 링크만 넣고 복사하지 않습니다. 검증된 이미지 복사는 가져오기 명령을 사용하세요.
- **Find notes citing a source**는 항목의 현재·이전 citekey를 볼트 전체에서 찾아 첫 인용 위치로 엽니다.
- **Update all owned literature notes**는 출력 폴더 안에서 소유권 마커를 가진 모든 노트의 관리 섹션을 다시 렌더링하고 갱신·부분(편집 섹션 보존)·변경없음·건너뜀·연결됐지만 비소유를 보고합니다. 편집된 생성 섹션은 그대로 두고 그 노트의 나머지 섹션만 갱신하며, 중복 identity·손상된 마커·비소유 노트는 덮어쓰지 않고 건너뜁니다.
- **오프라인 참고문헌**(0.5). 참고문헌 텍스트는 메모리 → `.cmds-zotero/bibliography.json` → BBT 순으로 제공됩니다. 사이드카는 BBT 렌더링이 성공할 때마다 기록되고(스타일·항목·content hash·Better BibTeX 버전으로 키 지정, 4 MB 상한, 설정 없음) Zotero가 꺼져 있어도 답합니다. 이때 사이드바 행에는 `cached <날짜>` 태그가, 텍스트가 전혀 없는 행에는 `offline: author-year fallback` 태그가 붙고, "Copy bibliography"는 `Copied N entries (M from cache, K fallback; Zotero offline).`로 출처를 알리며, 사이드바는 행마다 요청하는 대신 렌더링당 한 번(2.5 s) BBT를 탐침합니다. 가져오기와 일괄 갱신은 자리표시자를 쓰지 않습니다. 소유 노트는 Zotero가 다시 답할 때까지 `citation` 섹션을 바이트 단위로 유지하고, 항목의 첫 가져오기는 Zotero 실행이 필요합니다.
- **Open link under cursor**는 `zotero://select` 링크를 Zotero에서 열고, `zotero://open-pdf` 링크는 인덱스에서 항목을 찾아 PDF를 엽니다(첨부 키 우선, 없으면 Zotero 자체가 허용하는 부모 항목 키. 페이지·주석 유지, 라이브러리를 넘어 추측하지 않음). `[@citekey]`, `@citekey`, `[[@citekey]]`(별칭·헤딩 접미사 무시)에서는 항목 액션 창을 엽니다. 문장 부호가 뒤따르는 링크도 인식합니다. 그 밖에는 알림만 표시하며, 형식이 잘못된 Zotero URI는 선택 여부와 관계없이 가장 비슷한 항목이 아니라 "없음"으로 처리합니다.
- **Find literature across vaults**는 이 볼트와 등록한 각 피어 볼트에서 항목에 해당하는 모든 노트를 일반 `obsidian://open?vault=…&file=…` 행으로 나열합니다(피어 볼트의 커뮤니티 플러그인 목록에 Advanced URI가 있으면 `obsidian://advanced-uri?…&filepath=…`. 목록은 `<피어>/<이 볼트의 설정 폴더>/community-plugins.json`에서 읽으므로, 설정 폴더 이름이 다른 피어는 `obsidian://open`으로 돌아갑니다). 논문 허브와 `@citekey` 노트가 먼저 옵니다. 플러그인 자체의 `obsidian://cmds-zotero` 프로토콜은 이름 변경에 안전한 identity 링크와 에이전트 전송 용도로만 남깁니다.

가져온 노트는 CMDS 콜아웃 레이아웃을 사용합니다: `[!Cite]`, `[!Abstract]`, 인라인 Dataview 필드를 담은 `[!md]`(역할별 저자, 저널, 권·호, 출판사, 쪽, DOI, ISBN, 컬렉션, 관련 문헌 `[[@citekey]]`), Zotero select URI와 `file://` 첨부 링크를 담은 `[!LINK]`, 그리고 `[!Highlight]`·`[!Image]`·`[!Note]` 주석 콜아웃. 하이라이트 본문은 `<mark class="cmds-zotero-hl-<color>">`로 감싸며 색상은 Zotero 팔레트에서 가장 가까운 색조입니다. 설정한 제목용 색상(기본 gray)의 하이라이트는 `#####` 제목이 됩니다. "Excluded tags"(기본 `obscite`)의 태그는 제외합니다. 프론트매터에는 identity 키와 함께 `zotero_title`, `zotero_author`, `zotero_year`, `zotero_journal`, `zotero_doi`, `zotero_url`, `zotero_tags`가 들어가며 생성 후에는 사용자 소유입니다.

### pandoc용 참고문헌

pandoc의 citeproc은 `[@citekey]` 인용에 대응하는 참고문헌 파일이 필요합니다. 플러그인은 그 파일을 Better BibTeX에서(Zotero 라이브러리마다 읽기 전용 `item.export` 한 번) 만들며 노트 자체는 편집하지 않습니다. **Write pandoc bibliography sidecar for current note**는 `.cmds-zotero/bibliography/<노트>.json`(CSL-JSON, `abstract`/`note` 제거, 플러그인 소유·gitignore)을 쓰고 추가할 `bibliography:` YAML 줄을 알림으로 보여줍니다. **Copy CSL-JSON for cited sources**와 참고문헌 사이드바의 "Copy CSL-JSON" 버튼은 같은 배열을 클립보드에 넣습니다. 에이전트는 `cites --bibliography --format csl-json|bibtex|biblatex [--out]`을 사용합니다. 노트의 참고문헌 절은 `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` 제목으로 인식합니다(설정 → Bibliography → References headings). obsidian-pandoc 설정, `csl:`/`link-citations:`/`lang: ko-KR`, 셸 명령, `.gitignore` 줄을 담은 DOCX 레시피는 [`docs/pandoc-docx.md`](docs/pandoc-docx.md)에 있습니다.

## Hookmark

Hookmark 지원은 **복사 전용**입니다. 플러그인은 Markdown 링크를 클립보드에 넣고, 나머지는 Hookmark의 **Hook to Copied Link**가 처리합니다. 북마크 생성, AppleScript/`osascript`, frontmatter의 `hook://` 기록은 없으며 일반 Zotero 링크에 Hookmark가 필요하지도 않습니다. hook/unhook 자동화가 필요해지면 이 플러그인이 아니라 별도의 형제 플러그인에서 다룹니다.

세 명령(항목 액션 창에도 있음)은 URL을 꺾쇠 없이 `[제목](url)` 형태로 복사합니다. Hookmark와 `](`로 분리하는 클립보드 스크립트가 깨끗한 절대 URL을 받도록 하기 위한 것이며, URL 안의 공백·괄호는 퍼센트 인코딩합니다. 노트와 사이드바는 기존의 `[제목](<url>)` 형태를 유지합니다.

| 명령 | 복사 내용 | 용도 |
| --- | --- | --- |
| Copy Zotero item link (Hookmark-compatible) | `zotero://select/library/items/KEY` | 무엇이든 Zotero 항목에 hook할 때. 개인 라이브러리에서는 Hookmark가 Zotero 항목에 쓰는 주소와 동일하므로 양쪽에서 만든 hook이 한 북마크에 모입니다. |
| Copy Obsidian file link (Hookmark-native) | `obsidian://open?vault=…&file=…` | 문헌노트에 hook하고 노트를 연 상태에서 Hookmark 창에 그 hook이 보여야 할 때. Obsidian의 "Obsidian URL 복사"가 만드는 주소이며, Hookmark도 노트에 같은 `obsidian://open?vault=&file=` 형식을 기록합니다(경로 인코딩이 Hook to Copied Link와 바이트 단위로 일치하는지는 아직 확인하지 않음). 노트 이름을 바꾸거나 옮기면 끊어집니다. |
| Copy literature note identity link (rename-safe) | `obsidian://cmds-zotero?vault=…&libraryID=…&itemKey=…&target=note` | 이름 변경 후에도 살아남아야 하는 링크(`zoteroID`로 해석). Hookmark에서 노트를 열 수는 있지만 Hookmark는 Obsidian 연동이 돌려주는 주소를 기준으로 hook을 묶으므로, 이 링크로 만든 hook은 노트 안의 Hookmark 창에 **표시되지 않습니다**. |

Hookmark 문서와 기록된 주소 형식으로 확인한 것: select URI를 통한 Hookmark → Zotero, `obsidian://open`(네이티브. Hookmark는 열려 있는 노트의 이 주소를 자체 `obsidian://hook-get-address` 연동으로 가져오며, 이때 Obsidian의 URI 콜백 허용이 필요) 또는 `obsidian://cmds-zotero`(플러그인 프로토콜 핸들러)를 통한 Hookmark → Obsidian, Hook to Copied Link의 복사한 Markdown 링크 수용. 확인하지 않은 것: 복사한 파일 링크와 Hookmark가 같은 노트에 기록하는 주소의 경로 인코딩이 바이트 단위로 일치하는지(복사한 링크로 만든 hook은 어느 쪽이든 노트를 열지만, Hookmark 자체 북마크와 합쳐지는지는 미확인), 그룹 라이브러리 항목, 볼트 이름 변경 후 동작. Hookmark의 클립보드·AppleScript 명령이 시간 초과(Apple 이벤트 오류 `-1712`)되기 시작하면 Hookmark를 종료 후 다시 실행하세요.

## 인덱스·연동 계약

정본은 [`src/types.ts`](src/types.ts)입니다. 스키마 **2**는 `generatedAt`, `source: "better-bibtex"`, `count`, `entries`, `capabilities`, `diagnostics`, `complete`를 포함합니다. 문헌은 인용·표시 필드와 별개로 `libraryType` + 로컬 `libraryID` + 실제 `itemKey`를 사용합니다. 그룹 URI에는 실제 `groupID`가 추가로 필요합니다. CSL의 `id`와 citekey는 **item key가 아닙니다**. 첨부는 별도 key와 검증된 `openURI`를 가지며 주석 링크에는 첨부·주석 식별자와 1부터 시작하는 PDF 페이지가 들어갑니다. 인쇄된 페이지 라벨은 별도입니다.

조회 결과는 **resolved**, **ambiguous**, **not-found**, **unavailable**로 구분합니다. 첫 후보를 자동 선택하거나 오프라인을 문헌 부재로 해석하지 마세요. 기존 인덱스는 재구축 전까지 식별자를 신뢰할 수 없습니다. 첨부 보강 실패는 PDF가 없다는 증거가 아닙니다. 로컬 인덱스는 공개 테스트 fixture가 아닌 민감한 데이터입니다.

Paper ingest 서비스·CLI 계약은 [`src/ingest-api.ts`](src/ingest-api.ts), [`scripts/ingest.mjs`](scripts/ingest.mjs)를 참고하세요. 별도 HTTP 리스너를 만들지 않습니다. 소비자는 비동기 UI 명령으로 완료를 추정하지 말고 CLI의 capability-aware 오프라인 fallback을 사용하세요. BBT 9.0.64에서 문자열 item.search 요청이 거부된 것으로 실측되었으므로 과거 curl 예시를 복사하지 말고 필터 조건을 사용하는 공식 RPC 계약을 따르세요.

### 에이전트 CLI (계약 2)

| 액션 | 역할 | 오프라인 |
| --- | --- | --- |
| connection | 로컬 BBT·호스트 연결 검사 | 가능 |
| info | 인덱스 시각·건수·라이브러리·설정·노출 경고, refresh 없음 | 가능 |
| refresh | 명시적 갱신, `--if-older-than` 지원 | 불가 |
| resolve | citekey·item key/library·DOI·arXiv·제목·query 조회, `--stdin`으로 NDJSON 최대 500건 일괄 조회(0.6) | 가능 |
| identity | 허브 YAML/S01 제안, 참고문헌, PIN 대기 상태 | 가능 |
| cites | 본문·프론트매터 인용 검사 및 References 생성; `--format csl-json|bibtex|biblatex`·`--out` 사이드카(0.5) | 가능(구조화 형식·`--out`은 라이브 전용) |
| reconcile | 허브 감사, 명시적 `--apply`만 5개 키를 줄 단위로 기록(0.6) | dry-run만 |
| diagnostics | 인덱스·identity·인용·개인정보 진단 | 가능 |
| pdf-text | 내장 pdf.js로 비공개 텍스트 캐시 생성 | 불가 |
| locate | 캐시에서 인용 페이지와 검증 상태 반환 | 가능 |
| recent | Zotero에서 최근 읽은 논문과 각 문헌노트 상태(0.5) | 불가 |
| import | 최신 Zotero 데이터로 플러그인 소유 문헌노트 생성·갱신, `--apply` 없으면 dry-run(0.5) | 불가 |
| annotations | 논문의 주석을 첨부별·읽기 순서로, 색·유형·태그·첨부 필터와 함께. `--fresh`는 지금의 Zotero, `--today`는 오늘 연 논문(0.6) | 가능(`--fresh`, `--today`는 불가) |
| citing | 현재·이전 citekey로 논문을 인용한 노트를 위치·발췌와 함께(0.6) | 가능 |

```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh --if-older-than 60
node scripts/ingest-ro.mjs --vault "Research" --action identity --citekey example2024Graph --doi "10.1234/example"
node scripts/ingest-ro.mjs --vault "Research" --offline --vault-path /path/to/vault --action cites --path "20. Wiki/25. Questions" --recursive --strict
node scripts/ingest.mjs --vault "Research" --action pdf-text --citekey example2024Graph --pages "1-5"
node scripts/ingest-ro.mjs --vault "Research" --action locate --citekey example2024Graph --quote "An exact quotation from the source"
node scripts/ingest-ro.mjs --vault "Research" --action reconcile
```

모든 응답에 `contract:2`, `apiVersions:[1,2]`, `ok`, `checkedAt`, `connection`을 추가합니다.
기존 4개 액션의 payload는 `apiVersion:1`, 신규 6개는 2입니다.
종료 **0**은 유효한 not-found/ambiguous/dry-run도 포함하고, **1**은 실행 불가·apply 거부/부분 실패·strict 오류,
**2**는 인자 오류입니다. 구조화 실패는 stdout JSON과 stderr 이유 한 줄로 반환합니다.
제출 이후 timeout은 미실행의 증거가 아닙니다. 쓰기를 자동 반복하지 말고 읽기 전용 결과로 현 상태를 확인하세요.

읽기 전용 액션은 암묵적으로 인덱스·note-map을 갱신하지 않습니다. `ingest-ro.mjs`는 쓰기 요청과
조회 중 쓰기 가능한 구형 live API 경로를 차단합니다. 오프라인은 설정된 인덱스(기본
`80. References/zotero-index.json`)를 읽습니다. 누락·손상·불완전·시각 미확인 인덱스로 부재를 단정하지 않습니다.
오래된 인덱스의 부정 판정은 `--allow-stale` 없이는 보류하며, 이 flag로 **apply를 허가하지 않습니다**.

**비소유 노트 쓰기 예외:** dry-run 검토 후 명시적으로 `reconcile --apply`를 실행하면 paper hub의
`citekeyProvisional`, `zoteroID`, `zoteroSelectURI`, `zoteroStatus`, `zoteroCheckedAt`만 갱신할 수 있습니다.
실시간 BBT·신선하고 완전한 인덱스·legacy 비활성 상태가 필요합니다. citekey·DOI·본문·Raw Sources는
변경하지 않고, 잘못된 값·identity 충돌·안전하지 않은 YAML은 거절하며 동시 편집과 부분 실패를 보고합니다.
외부 편집기에 대한 완전한 파일 CAS나 동시 편집을 덮는 자동 rollback은 보장하지 않습니다.
`resolved` + `citekeyProvisional:true`는 등록됐지만 PIN 대기인 상태입니다. Zotero Extra에
`Citation Key: <vault-key>`를 수동 지정하고 명시적 refresh로 확인하세요. 과거 key 매칭은 현재 PIN 증거가 아닙니다.

`pdf-text`는 내장 공개 pdf.js API로 최대 64 MiB 로컬 PDF를 읽고 **원문 전체 텍스트**를 캐시합니다.
플러그인은 `.cmds-zotero/.gitignore`로 내부 캐시를 보호합니다. 저장소에서는 설정된 인덱스도 ignore하세요.
권장 메인 볼트 `.gitignore` 항목: `/.cmds-zotero/`, `/.cmds-zotero/bibliography.json`(렌더링된 참고문헌 텍스트, 무해하지만 잡음), 설정된 인덱스 경로.
Git 진단은 ignore와 이미 추적 중인 상태를 구분합니다. untrack해도 과거 공개 이력은 지워지지 않습니다.
`locate`는 물리 페이지와 인쇄 라벨을 구분하고 PDF URI에 첨부 key를 사용합니다.
미검증·원본 변경·fuzzy 결과를 확정 인용 근거로 사용하지 마세요.

에이전트 스킬은 `node scripts/install-skill.mjs`로 복사 설치하며 옵션은 `--help`에서 확인합니다.
[배포용 참조](skills/cmds-zotero/references/cli-contract-v2.md)는 계약 정본에서 생성되고
`node scripts/sync-contract.mjs --check`로 드리프트를 검사합니다.

가져온 노트는 `zoteroID`로 이름·citekey 변경 뒤에도 경로를 유지합니다. 최초 YAML은 사용자 관리 영역이며 이후 메타데이터는 관리 섹션에서 갱신됩니다. 이미지명에는 라이브러리와 content hash가 포함되어 원본이 바뀌면 새 버전을 추가하고 구버전·사용자 수정 이미지를 삭제하지 않습니다. 소유권 마커가 없는 기존 노트는 자동 편입하지 않으므로, 나란히 가져오려면 출력 폴더를 바꾸세요.

**보존과 충돌 해결(0.5).** 생성 섹션은 모두 `<!-- cmds-zotero:<id>:<hash> -->`와 `<!-- /cmds-zotero:<id> -->` 사이에 있습니다. 사용자가 편집한 섹션은 *소프트* 충돌입니다. 미리보기에 "edited (preserved)"로 표시되고 블록은 그대로 유지되며 노트의 나머지는 정상 갱신됩니다. 더 이상 노트 전체를 막지 않습니다. 섹션마다 **Detach**(마커가 `<!-- cmds-zotero:<id>:detached -->`가 되어 그 블록은 사용자 소유가 되고, 다시 렌더링되거나 편집됨·누락으로 보고되지 않으며 Zotero에서 주석이 사라져도 그대로 둡니다) 또는 **Reset**(블록을 새 렌더링으로 교체하되, 그 전에 이전 노트 전문을 플러그인의 gitignore된 비공개 폴더 `.cmds-zotero/backups/notes/<basename>-<timestamp>.md`에 복사합니다)을 선택할 수 있습니다. Detach는 의도적으로 되돌릴 수 없습니다. 분리된 블록을 다시 소유하는 명령은 없으며 Reset만이 유일한 복귀 경로입니다. 여는 마커 줄에 붙여넣은 텍스트는 다음 갱신 때 블록 아래로 옮겨지고, 닫는 마커 앞의 공백은 허용됩니다. 누락·중복·손상된 마커는 여전히 *하드* 충돌로, 섹션별로 줄 번호와 함께 보고되며("Malformed managed markers for `<id>` (line N)") 고치기 전까지 노트를 쓰지 않습니다.

## 지원 경계와 검증

| 영역 | 구현 목표 | 인수 검증 경계 |
| --- | --- | --- |
| 개인 라이브러리 메타데이터·정식 링크 | BBT 기반 identity 해석 | 설치된 BBT 버전에서 확인 |
| 텍스트/이미지 주석·재가져오기 | CMDS 내장 템플릿과 플러그인 관리 영역 | 이미지 접근·사람 메모·충돌·재가져오기 실측 필요 |
| 그룹 라이브러리 | 로컬 library ID와 group ID 구분 | 합성/source 검증은 실제 그룹 검증이 아님 |
| 다른 볼트 | 명시적 등록·읽기 전용 조회와 이동 | 양쪽 인덱스와 노트 이름 변경 확인 |
| Hookmark | Zotero 항목·Obsidian 파일·이름 변경에 안전한 identity 링크를 괄호 없는 Markdown 링크로 복사 | 복사 전용. Hookmark → Zotero, Hookmark → Obsidian은 문서화된 주소 형식이며 노트 안에서의 hook 표시 여부는 링크 형식에 따름(Hookmark 절 참고) |
| 기존 플러그인/템플릿 | 이전 중 공존 | 전체 parity나 자동 비활성화 없음 |

실사용 전 오프라인/부분 실패 시 인덱스 보존, 첨부 없음, 중복 citekey, 최초 가져오기 → 사람 메모 → 재가져오기, 이미지 누락, PDF 페이지/주석 링크, 노트 이름 변경, 다른 볼트 이동, rollback을 검사하세요. 작은 사례를 확인하기 위해 대량 가져오기를 실행하지 마세요.

## 개발·릴리스 준비

```sh
npm ci
npm run lint
npm run typecheck
npm run build:core                  # 오프라인 CLI에 번들되는 모듈을 바꾼 뒤
npm test
npm run build
node scripts/sanitize.mjs           # 추적 중인 작업 파일 검사
node scripts/sanitize.mjs --staged  # Git index의 추가·변경 파일 검사
node scripts/version-bump.mjs 0.6.0 # package/lock/manifest/versions 동기화
node scripts/verify-release.mjs 0.6.0
```

테스트는 합성 데이터만 사용합니다. 새니타이저는 비밀값 대신 파일·줄·규칙만 출력하는 휴리스틱이며 staged diff와 private 저장소 링크의 수동 검토를 대체하지 않습니다. CI는 Node 22에서 `npm ci`, lint, typecheck, test, production build를 수행합니다. 준비된 릴리스 workflow는 manifest/package/lock/versions와 일치하는 **v 접두사 없는 정식 semver 태그**를 요구하며 세 플러그인 파일과 provenance bundle을 배포합니다. **해당 태그를 push하면 릴리스가 공개되므로 먼저 승인을 받으세요.** Workflow 준비는 릴리스·CI 성공·커뮤니티 등록을 완료했다는 뜻이 아닙니다.

## 저자·라이선스

[Yohan Koo (CMDSPACE)](https://cmdspace.work). MIT, [LICENSE](LICENSE) 참고.
