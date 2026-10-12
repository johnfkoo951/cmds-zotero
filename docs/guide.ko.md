# CMDS Zotero 사용설명서
Zotero에서 읽고 표시한 내용을 Obsidian 문헌 노트로 보냅니다. 메타데이터, 하이라이트와 메모, Zotero 노트, 인용과 원문 링크를 한 노트에 모으고, 사람이 쓴 글은 그대로 둡니다. Zotero는 읽기 전용으로 다룹니다.

## 버전과 공개 상태
**2026-10-12**에 공개한 **CMDS Zotero 0.5.0** 기준입니다. [GitHub 릴리스](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.5.0)에는 CI가 빌드하고 출처를 증명한 `main.js`, `manifest.json`, `styles.css`가 있습니다. **Obsidian Community Plugins 목록에는 아직 등록하지 않았습니다.** 수동 설치나 BRAT로 설치합니다.
검증 환경은 Obsidian 1.14.4, Zotero 10.0.5, Better BibTeX 9.0.71, macOS입니다. 실제 서재로 최근 읽은 논문 목록, 문헌 노트 생성·갱신 4건, PDF 텍스트 추출 4건(스캔본 1건 포함), 인용문 위치 찾기를 확인했습니다. 그룹 라이브러리와 Windows/Linux는 실사용 검증 범위가 아닙니다.

## 준비물과 용어
- **Obsidian 데스크톱 1.7.2 이상**. 모바일은 지원하지 않습니다.
- 실행 중인 [Zotero](https://www.zotero.org/)와 [Better BibTeX](https://retorque.re/zotero-better-bibtex/)(BBT). 플러그인은 BBT의 로컬 JSON-RPC만 사용합니다.
- **최근 읽은 논문** 기능은 Zotero가 PDF를 리더로 열 때 남기는 읽기 기록을 씁니다. Zotero 10에서 확인했습니다.
- 기본 로컬 주소 `http://127.0.0.1:23119/better-bibtex`. Zotero Web API 키, native Local API 설정 변경, SQLite 접근, 별도 PDF 도구는 필요 없습니다.
**citekey**는 `Example2026` 같은 인용 라벨이며 영구 식별자가 아닙니다. 플러그인은 라이브러리 종류, 로컬 library ID, Zotero item key로 항목을 식별합니다. 첨부와 주석은 별도 키를 가지며 부모 항목이 곧 PDF는 아닙니다.

## 설치
**수동 설치**
1. [0.5.0 릴리스](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.5.0)에서 `main.js`, `manifest.json`, `styles.css`를 받습니다.
2. `<vault>/.obsidian/plugins/cmds-zotero/` 폴더에 세 파일을 넣습니다.
3. Obsidian을 다시 로드하고 **설정 → 커뮤니티 플러그인**에서 **CMDS Zotero**를 켭니다.

**BRAT 설치**: BRAT 플러그인에서 `johnfkoo951/cmds-zotero`를 베타 플러그인으로 추가합니다.

이전 버전에서 올리면 설정(`data.json`)과 인덱스는 그대로 쓰입니다. 업그레이드 전에 플러그인 폴더를 백업합니다. 옛 플러그인 `cmds-link-zotero`가 같은 인덱스 경로를 쓰고 있다면 꺼 두어야 인덱스를 갱신할 수 있습니다.

## 첫 성공: 최근 읽은 논문을 노트로 보내기
1. Better BibTeX가 켜진 Zotero를 실행합니다.
2. **설정 → CMDS Zotero**에서 **Output folder**, **Image folder**, **Index path**를 볼트 상대경로로 정하고 **Save configuration**을 누릅니다. **Test connection**은 저장된 설정을 시험합니다.
3. 명령 팔레트(Ctrl/Cmd+P)에서 **Refresh citekey index**를 한 번 실행합니다.
4. Zotero 리더에서 논문 PDF를 열고 하이라이트나 메모를 남깁니다.
5. **Send recently read papers to notes**를 실행하거나 펼친 책 모양 리본 아이콘을 누릅니다.
6. 목록에서 논문마다 노트 상태를 확인합니다: *No literature note yet*(노트 없음), *N new annotations not in the note*(새 주석 N개), *Note is up to date*(최신), CMDS Zotero가 만들지 않은 노트(덮어쓰지 않음).
7. 보낼 필요가 있는 논문은 미리 선택되어 있습니다. **Send**를 누르면 노트를 새로 만들거나 관리 구역만 갱신합니다.
8. 행의 노트 버튼으로 결과를 열고 주석, 페이지 링크, 메타데이터를 Zotero와 비교합니다.
9. 노트의 `## Synthesis`나 `## Notes`에 문장을 쓰고 Zotero에서 하이라이트를 하나 더 한 뒤 다시 보냅니다. 내가 쓴 문장은 그대로 있고 새 주석만 추가되면 첫 성공입니다.

**Reading window**는 7/30/90/365일 중에서 고릅니다. 기본값은 설정의 **Recently read window**(30일)입니다. 목록을 보려면 Zotero가 실행 중이어야 합니다.

## 문헌 노트 가져오기와 갱신
**Import literature note**는 자료를 골라 미리보기(경로, 구역별 상태, 충돌)를 연 뒤 적용합니다. 자료 선택 창은 최근 읽은 논문을 맨 위에 `· read 3 days ago`처럼 표시합니다.
가져오기는 저장된 인덱스가 아니라 **Zotero의 현재 데이터**(그 항목의 export와 첨부·주석)로 노트를 렌더링합니다. 그래서 인덱스를 갱신하지 않아도 방금 단 하이라이트가 들어갑니다. citekey가 Zotero에서 바뀌었으면 item key로 다시 찾고, 다른 항목으로 대체하지 않습니다. Zotero가 꺼져 있으면 저장된 인덱스로 미리보기하고 그 사실을 알립니다. 처음 만드는 노트는 참고문헌 문장이 필요하므로 Zotero가 실행 중이어야 합니다.
**Update all owned literature notes**는 이 플러그인이 만든 노트를 모두 순회하며 관리 구역을 갱신합니다. 결과는 *Updated*, *Partial(편집 구역 보존)*, *Unchanged*, *Skipped*로 보고합니다. 노트마다 승인 창을 열지 않으므로 작은 시험 뒤에 사용합니다.

## 노트 구조와 보존 규칙
새 노트의 frontmatter에는 `type: zotero`, `zoteroID`, `zoteroSelectURI`, `zotero-key`, `citekey`, `doi`, `title`, `authors`, `year`, `tags`와 `zotero_title` 같은 `zotero_*` 필드가 들어갑니다. **frontmatter는 처음 한 번만 만들고 이후에는 사용자 소유**입니다.
본문은 다음 순서입니다.
- 제목과 초록(`overview`), 참고문헌(`citation`)
- `## Synthesis`: 사용자 영역(`**Contribution**::`, `**Related**::`)
- 메타데이터와 링크(`metadata`): 저자, 학술지, DOI, URL, 태그, 컬렉션, Zotero 관련 항목, Zotero와 PDF 열기 링크
- `## Zotero notes`(`notes`): Zotero 자식 노트를 제목·목록·링크를 살린 Markdown으로 넣습니다. 코드 블록은 그대로 둡니다.
- `## Notes`: 사용자 영역
- `## Annotations`: 주석마다 블록 하나. Zotero의 읽기 순서대로 놓이고, 나중에 앞쪽 페이지에 단 주석도 제자리에 들어갑니다. 하이라이트, 밑줄, 이미지, 메모, 손그림(ink)을 구분하며 페이지 링크는 Zotero 리더의 해당 위치를 엽니다.

관리 구역은 `<!-- cmds-zotero:<id>:<해시> -->`와 `<!-- /cmds-zotero:<id> -->` 사이입니다. 관리 구역을 고치면 그 구역만 **편집됨(보존)**으로 남고 나머지는 갱신됩니다. 미리보기에서 구역마다 다음 중 하나를 고릅니다.
- **Keep this time**: 이번에는 그대로 둡니다.
- **Detach**: 그 블록을 영구히 내 것으로 만듭니다. 다시 렌더링하지 않습니다.
- **Reset from Zotero**: Zotero 내용으로 되돌립니다. 이전 노트는 `.cmds-zotero/backups/notes/`에 백업합니다.
마커가 손상되었거나, 중복되었거나, CMDS Zotero가 만들지 않은 노트이거나, 같은 식별을 가진 노트가 여럿이면 쓰지 않고 이유와 줄 번호를 보여 줍니다. Zotero에서 지운 주석의 블록은 노트에서 지우지 않습니다.

## 인용, 참고문헌, 사이드바
- **Insert citation from Zotero**: BBT의 Cite As You Write 선택기로 인용을 넣습니다. 기본 형식은 `[@citekey]`입니다.
- 편집기에서 `[@` 뒤에 citekey·제목·저자·연도 일부를 입력하면 로컬 자동완성이 나옵니다. 캐시된 인덱스를 읽으므로 키 입력마다 Zotero를 부르지 않습니다.
- **Open references sidebar**: 현재 노트의 `[@key]`, `@key`, 인용 위키링크를 모아 참고문헌과 미해결 상태를 보여 줍니다. Zotero가 꺼져 있어도 저장된 참고문헌(`.cmds-zotero/bibliography.json`)으로 표시합니다.
- **Open annotations sidebar**: 현재 문헌 노트나 고정한 자료의 주석을 보고 커서 위치에 넣거나 복사합니다.
- **Insert bibliography**: 자료 하나의 CSL 참고문헌을 편집기에 넣습니다.
- **Copy CSL-JSON for cited sources**와 **Write pandoc bibliography sidecar for current note**: 현재 노트가 인용한 자료를 CSL-JSON으로 복사하거나 `.cmds-zotero/bibliography/<노트>.json`에 저장하고, frontmatter에 넣을 `bibliography:` 줄을 알려 줍니다. pandoc으로 DOCX를 만드는 방법은 [pandoc/DOCX 가이드](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/pandoc-docx.md)에 있습니다.

## 전체 명령어

| 명령 | 기능 |
|---|---|
| Send recently read papers to notes | Zotero에서 최근 읽은 논문과 노트 상태를 보고 노트로 보냄 |
| Import literature note | 자료 하나를 미리보기 뒤 가져오기·갱신 |
| Update all owned literature notes | 플러그인이 만든 노트의 관리 구역 일괄 갱신 |
| Refresh citekey index | BBT에서 인덱스 전체 갱신 |
| Search literature | 자료를 고르고 동작(열기, 가져오기, 링크 복사 등) 선택 |
| Insert citation from Zotero | CAYW 인용 삽입 |
| Insert bibliography | 자료 하나의 참고문헌 삽입 |
| Copy CSL-JSON for cited sources | 현재 노트 인용의 CSL-JSON 복사 |
| Write pandoc bibliography sidecar for current note | pandoc용 참고문헌 파일 저장 |
| Open references sidebar | 현재 노트 인용 검토 |
| Open annotations sidebar | 주석 검토와 삽입 |
| Open source PDF at page | PDF를 파일 위치 기준 쪽으로 열기 |
| Open link under cursor | 커서의 Zotero 링크나 `[@citekey]` 열기 |
| Find notes citing a source | 현재·과거 citekey를 쓴 노트 찾기 |
| Find literature across vaults | 허용한 다른 볼트의 같은 자료 노트 찾기 |
| Copy Zotero item link (Hookmark-compatible) | Zotero 항목 Markdown 링크 복사 |
| Copy literature note identity link (rename-safe) | 노트 이름이 바뀌어도 열리는 링크 복사 |
| Copy Obsidian file link (Hookmark-native) | 문헌 노트의 `obsidian://open` 주소 복사 |
| Diagnose index and links | 연결, 인덱스, 식별 진단 |

PDF 쪽 번호는 **1부터 시작하는 파일 위치**이지 인쇄된 쪽 번호가 아닙니다.

## 설정
값을 바꾼 뒤 **Save configuration**을 누릅니다. 저장 전에는 이전 값이 쓰입니다.

| 설정 | 기본값과 의미 |
|---|---|
| Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost 주소만 허용 |
| Test connection | 저장된 주소로 BBT 연결 시험 |
| Request timeout | 20초(1–180) |
| Attachment timeout | 60초(1–180); 이미지 렌더링이 필요한 첨부는 더 걸릴 수 있음 |
| Index path | `80. References/zotero-index.json` |
| Maximum index age | 60분(1–10080); 지나면 다음 조회 때 백그라운드 갱신 |
| Parallel requests | 2(1–8) |
| Refresh saved index | 지금 인덱스 갱신 |
| Output folder | `References/Zotero`; 새 문헌 노트 위치 |
| Image folder | `References/Zotero/images`; 이미지 주석 사본 위치 |
| Bibliography style | `apa`; Zotero에 설치된 CSL 스타일 ID |
| Citation format | `pandoc`; CAYW 형식 |
| Recently read window | 30일(7/30/90/365); 최근 읽은 논문 목록과 자료 선택 창 정렬 |
| Peer vaults | 한 줄에 `볼트 이름 \| 절대 경로`; 다른 볼트 노트 찾기용 |
| References headings | References 구역으로 볼 제목; 기본 `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` |

## PDF 텍스트와 에이전트
AI 에이전트와 스크립트는 같은 기능을 CLI로 씁니다. CLI는 실행 중인 Obsidian의 플러그인에 작업을 맡기고, 가능한 읽기 작업은 Obsidian 없이 인덱스 파일로 답합니다.
```sh
node scripts/ingest.mjs --vault "Research" --action recent --days 30
node scripts/ingest.mjs --vault "Research" --action import --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action import --citekey Example2026 --apply
node scripts/ingest.mjs --vault "Research" --action pdf-text --citekey Example2026 --pages 1-3
node scripts/ingest.mjs --vault "Research" --action locate --citekey Example2026 --quote "quoted text"
```
- `recent`는 읽은 날짜와 노트 상태(`none`, `behind`, `current`, `foreign`, `duplicate`)를 돌려줍니다.
- `import`는 `--apply`가 없으면 미리보기만 합니다. 하드 충돌은 `note-conflict`로 거절합니다. Zotero에서 실시간으로 읽지 못하면 `--allow-stale` 없이는 쓰지 않습니다.
- `pdf-text`는 Obsidian에 내장된 pdf.js로 텍스트를 뽑아 비공개 캐시(`.cmds-zotero/pdf-text/`)에 저장합니다. 한·중·일 글꼴용 문자 지도를 함께 씁니다. 텍스트 레이어가 없는 스캔본은 `textLayer: none`과 OCR 권장 경고를 냅니다. 페이지마다 반복되는 워터마크는 본문으로 세지 않습니다.
- `locate`는 인용문이 있는 쪽을 찾아 Zotero 리더 링크와 함께 돌려줍니다.
- 읽기 전용 환경에서는 `scripts/ingest-ro.mjs`를 씁니다. 쓰기와 `--apply`를 거절합니다.
에이전트는 관리 구역을 직접 고치지 않고, 자기 요약은 `## Synthesis`나 `## Notes`에 씁니다. 전체 규약은 [에이전트 계약](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/agent-contract-v2/contract.md)에 있습니다.

## 교차 볼트와 Hookmark
**Peer vaults**에 등록한 다른 볼트의 노트 지도를 읽기 전용으로 읽고 **Find literature across vaults**로 이동합니다. 같은 citekey라도 다른 볼트에서는 다른 자료일 수 있으므로 식별을 확인합니다.
Hookmark 관련 명령은 링크를 클립보드에 복사할 뿐입니다. Hookmark 설정을 바꾸거나 북마크를 만들거나 스크립트를 실행하지 않습니다.

## 데이터와 개인정보
- 로컬 BBT에 메타데이터, 인용, 참고문헌, 첨부와 주석, 읽기 기록을 요청합니다. Zotero 설정, 데이터베이스, citekey, 라이브러리 기록은 바꾸지 않습니다.
- 이미지 주석을 가져오면 볼트 밖의 Zotero 캐시 이미지를 읽어 이미지 폴더에 복사합니다.
- 볼트에 쓰는 것은 설정, 인덱스, 문헌 노트, 이미지 사본, `.cmds-zotero/` 아래의 비공개 파일(참고문헌·노트 지도·백업·PDF 텍스트 캐시)입니다. 플러그인은 `.cmds-zotero/.gitignore`를 먼저 만들어 이 폴더가 git에 올라가지 않게 합니다. PDF 텍스트 캐시는 논문 전문이므로 공유하지 않습니다.
- 인덱스와 노트 지도에는 서지정보, 개인 경로, 주석이 들어갈 수 있습니다. 공개 저장소에 올리지 않습니다.
- 텔레메트리, 자체 HTTP 서버, 자동 업데이트는 없습니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 최근 읽은 논문이 비어 있음 | Zotero 실행 여부, 기간(Reading window), PDF를 Zotero 리더로 열었는지 |
| 새 하이라이트가 노트에 없음 | Zotero 실행 여부; 꺼져 있으면 저장된 인덱스로 렌더링됨 |
| 노트가 "not created by CMDS Zotero"로 거절됨 | 다른 플러그인이 만든 노트; 덮어쓰지 않으므로 출력 폴더나 파일명을 확인 |
| 가져오기 차단(손상된 마커) | 미리보기의 줄 번호에서 마커를 고치거나 Reset 사용 |
| 인덱스 갱신이 거부됨 | 옛 플러그인 `cmds-link-zotero`가 켜져 있는지 |
| 연결 실패 | Zotero·BBT 실행과 localhost 주소, 시간 제한 |
| PDF가 다른 쪽으로 열림 | 인쇄 쪽 번호가 아닌 파일 위치 기준인지 |
| `pdf-text`가 빈 결과 | `textLayer` 값; `none`이면 스캔본이므로 OCR 필요 |

## 옛 플러그인 ID에서 이전
`cmds-link-zotero`에서 옮길 때는 Obsidian을 끄고 `scripts/migrate-local.mjs`를 `dry-run` → `check` → `apply` 순서로 씁니다. 백업 폴더는 볼트와 저장소 밖의 새 비공개 폴더로 정합니다.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
```
`rollback` 모드로 되돌릴 수 있으며, 배포 이후 바뀐 파일은 덮어쓰지 않고 거부합니다. 이전 뒤에는 새 ID만 켜져 있는지 확인하고 인덱스를 다시 만듭니다.

## 업데이트, 지원, 라이선스
[웹 설명서](https://apps.cmdspace.work/plugins/cmds-zotero/) | [저장소](https://github.com/johnfkoo951/cmds-zotero) | [릴리스](https://github.com/johnfkoo951/cmds-zotero/releases) | [문제 신고](https://github.com/johnfkoo951/cmds-zotero/issues) | [변경 이력](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md)
문제를 신고할 때는 플러그인·Obsidian·Zotero·BBT 버전과 OS, 개인정보를 지운 진단 결과를 적습니다. 실제 인덱스, 개인 경로, 주석 원문, PDF 텍스트 캐시는 올리지 않습니다.
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. MIT, [LICENSE](https://github.com/johnfkoo951/cmds-zotero/blob/main/LICENSE).
