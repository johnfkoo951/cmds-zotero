# CMDS Zotero 사용설명서
Zotero에서 읽고 표시한 내용을 Obsidian 문헌 노트로 보냅니다. 메타데이터, 하이라이트와 메모, Zotero 노트, 인용과 원문 링크를 한 노트에 모으고, 사람이 쓴 글은 그대로 둡니다. Zotero는 읽기 전용으로 다룹니다.

## 버전과 공개 상태
**2026-10-15**에 공개한 **CMDS Zotero 0.6.5** 기준입니다. [GitHub 릴리스](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.6.5)에는 CI가 빌드하고 출처를 증명한 `main.js`, `manifest.json`, `styles.css`가 있습니다. **설정 → 커뮤니티 플러그인 → 탐색**에서 설치하거나, 수동 설치나 BRAT로 설치합니다.
0.6.5는 새로 설치한 경우 인덱스를 번호 붙은 `80. References` 폴더 대신 문헌 노트 옆 `References/Zotero/zotero-index.json`에 만듭니다. 그 자리에 인덱스가 이미 있는 설치는 그대로 씁니다. 0.6.4는 커뮤니티 디렉터리 등록을 준비했습니다. Obsidian 1.13 이상에서도 설치된 스타일을 고르면 설정 칸이 바로 바뀌고, 현재 노트용 명령은 노트가 열려 있을 때만 나타납니다. 0.6.3은 옮긴 문헌 노트를 찾아내고, 새 노트 이름을 고정 토큰으로 정하고, 검색으로 일괄 가져오고, 모든 일괄 작업 전에 검토 목록을 보여 주고, 다른 Zotero 플러그인이 만든 노트를 넘겨받고(adopt), 노트별 갱신·재생성·frontmatter 새로 고침·옛 키 정리·병합 항목 재연결을 추가합니다. 같은 날 공개한 0.6.2는 인용 편집기, Zotero에 설치된 스타일과 로캘로 만드는 참고문헌, 인용 점검(Check citations), 참고문헌 구역, pandoc 내보내기 키트를 추가했습니다. 0.6.1은 노트 레이아웃 설정, 항목 내용 삽입, 더 풍부한 주석 사이드바, 필드 검색, Zotero 선택 항목 명령, 설정 진단을 추가했습니다. 0.6.0은 인덱스 갱신·시작·일괄 갱신을 빠르게 하고, 문제 있는 항목이 있어도 갱신을 이어 가며, 인용 선택기가 기다리게 하고, 설정 탭을 다시 정리하고, 에이전트 액션을 추가했습니다. 모든 변경은 [변경 기록](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md)에 있습니다. 검증 환경은 Obsidian 1.14.4, Zotero 10.0.6, Better BibTeX 9.0.71, macOS입니다. 0.5 때 실제 서재로 최근 읽은 논문 목록, 문헌 노트 생성·갱신 4건, PDF 텍스트 추출 4건(스캔본 1건 포함), 인용문 위치 찾기를 확인했습니다. 그룹 라이브러리와 Windows/Linux는 실사용 검증 범위가 아닙니다.
0.6.1에서 올리면 기본 설정에서 네 가지가 달라 보입니다. 편집기에서 citekey 문제에 밑줄이 그어지고, 복사한 참고문헌은 스타일 자체의 순서를 따르고, **Update all owned literature notes**는 먼저 검토 목록을 보여 주고, 출력 폴더 밖으로 옮긴 문헌 노트는 옮긴 자리에서 갱신됩니다. 새 노트의 이름과 폴더는 0.6.1과 같습니다.

## 준비물과 용어
- **Obsidian 데스크톱 1.7.2 이상**. 모바일은 지원하지 않습니다.
- 실행 중인 [Zotero](https://www.zotero.org/)와 [Better BibTeX](https://retorque.re/zotero-better-bibtex/)(BBT). 플러그인은 BBT의 로컬 JSON-RPC만 사용합니다.
- **최근 읽은 논문** 기능은 Zotero가 PDF를 리더로 열 때 남기는 읽기 기록을 씁니다. Zotero 10에서 확인했습니다.
- 기본 로컬 주소 `http://127.0.0.1:23119/better-bibtex`. Zotero Web API 키, native Local API 설정 변경, SQLite 접근, 별도 PDF 도구는 필요 없습니다.
**citekey**는 `Example2026` 같은 인용 라벨이며 영구 식별자가 아닙니다. 플러그인은 라이브러리 종류, 로컬 library ID, Zotero item key로 항목을 식별합니다. 첨부와 주석은 별도 키를 가지며 부모 항목이 곧 PDF는 아닙니다.

## 설치
**커뮤니티 플러그인**: **설정 → 커뮤니티 플러그인 → 탐색**에서 **CMDS Zotero**를 검색해 **설치**한 뒤 **활성화**합니다.

**수동 설치**
1. [최신 릴리스](https://github.com/johnfkoo951/cmds-zotero/releases/latest)에서 `main.js`, `manifest.json`, `styles.css`를 받습니다.
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
**Import literature note**는 자료를 골라 미리보기(경로, 구역별 상태, 충돌)를 연 뒤 적용합니다. 자료 선택 창은 최근 읽은 논문을 맨 위에 `· read 3 days ago`처럼 표시합니다. **Open or import literature note**는 자료의 노트를 열고, 볼트에 아직 노트가 없으면 가져오기 미리보기를 엽니다.
가져오기는 저장된 인덱스가 아니라 **Zotero의 현재 데이터**(그 항목의 export와 첨부·주석)로 노트를 렌더링합니다. 그래서 인덱스를 갱신하지 않아도 방금 단 하이라이트가 들어갑니다. citekey가 Zotero에서 바뀌었으면 item key로 다시 찾고, 다른 항목으로 대체하지 않습니다. Zotero가 꺼져 있으면 저장된 인덱스로 미리보기하고 그 사실을 알립니다. 처음 만드는 노트는 참고문헌 문장이 필요하므로 Zotero가 실행 중이어야 합니다.

**새 노트의 위치.** **New note file name**과 **New note subfolder**(설정 → Literature notes)는 고정 토큰 `{citekey}`, `{title}`, `{shortTitle}`, `{year}`, `{firstAuthor}`, `{itemType}`, `{collection}`으로 만듭니다. 예를 들어 하위 폴더 `{itemType}` 아래 `{year} {shortTitle}`처럼 정할 수 있습니다. 파일 이름에 쓸 수 없는 문자는 바꾸고 긴 이름은 줄이며, 미리보기가 결과 경로를 보여 줍니다. 기본값(`@{citekey}`, 하위 폴더 없음)은 이전과 같은 이름을 만들고, 기존 노트의 이름은 그대로 둡니다. 템플릿 언어가 아니라 고정된 토큰입니다.

**옮긴 노트.** 볼트 안 어디로 옮기거나 이름을 바꾼 문헌 노트도 식별 정보(`zoteroID`와 플러그인의 소유 표식)로 찾아, 다시 가져오지 않고 그 자리에서 갱신합니다. 소유 표식 없이 항목 이름만 담은 노트는 문헌 노트로 보지 않습니다. **Diagnose setup**은 출력 폴더 밖에 있는 문헌 노트를 보여 줍니다.

**노트 하나 갱신.** **Update current literature note**는 열린 노트의 갱신 미리보기를 엽니다. 이미 있는 노트라면 미리보기에 **Refresh** 묶음이 있습니다. *Title and abstract*, *Bibliography entry*, *Metadata and links*, *Zotero notes*, *Annotations* 중 끈 구역은 이번 갱신에서 그대로 둡니다.

**검토 목록이 있는 일괄 작업.** **Update all owned literature notes**, **Update literature notes changed in Zotero**, **Import literature notes by search**, **Adopt existing literature notes**는 먼저 검토 목록을 보여 줍니다. 노트마다 무엇을 할지(*Create*, *Update*, *Adopt*, 또는 이유가 붙은 *Skip*)와 선택 상자가 있고, **Select all**과 **Select none**으로 한꺼번에 고를 수 있습니다. 적용 버튼을 누르기 전에는 Zotero에서 아무것도 읽지 않고 아무것도 쓰지 않으며, Cancel은 아무것도 바꾸지 않습니다. 실행 중에는 진행 알림에 Cancel이 있고, 취소하면 남은 노트는 그대로 둡니다.
- **Update all owned literature notes**는 선택한 노트의 관리 구역을 갱신하고 *Updated*, *Partial(편집 구역 보존)*, *Unchanged*, *Skipped*로 보고합니다. 같은 식별을 가진 노트가 여럿이면 건너뛰고, 항목을 가리키지만 CMDS Zotero가 만들지 않은 노트는 넘겨받기(adopt)를 안내하며 건너뜁니다.
- **Update literature notes changed in Zotero**는 노트를 마지막으로 쓴 뒤 항목이나 주석이 바뀐 노트만 같은 목록으로 보여 줍니다. **Changed in Zotero since**에서 *Any time*이나 날짜로 바꿀 수 있습니다. 날짜는 저장된 인덱스에서 오므로 먼저 인덱스를 갱신합니다. 날짜를 알 수 없는 노트를 바뀌지 않았다고 보지는 않습니다.
- **Import literature notes by search**는 `col:methods`, `tag:method`, `type:book`, `year:2020-` 같은 필드 검색을 받아, 맞는 항목 중 아직 노트가 없는 것만 새로 만듭니다. 두 항목의 파일 이름이 같아지면 두 번째 항목은 첫 노트를 덮어쓰지 않고 건너뜁니다.
- Zotero 애드온 Better Notes가 동기화하는 노트는 Better Notes가 갱신 내용을 덮어쓰므로 일괄 작업에서 건너뛰고, 하나씩 갱신할 때는 경고를 보여 줍니다.

**다른 플러그인의 노트 넘겨받기.** **Adopt current note as literature note**는 Zotero Integration이나 ZotLit이 만든 노트, 또는 citekey를 이름으로 쓰는 노트를 citekey, DOI, Zotero 링크로 항목과 맞춥니다(여러 항목이 맞으면 직접 고릅니다). 미리보기와 백업 뒤 빠진 식별 키를 한 줄씩 더하고 생성 구역을 내 글 아래에 덧붙이며, 내가 쓴 내용은 바꾸지 않습니다. **Adopt existing literature notes**는 검토 목록을 거쳐 볼트에서 맞는 모든 노트에 같은 일을 합니다. DOI로만 맞은 노트는 선택이 해제된 채로 나옵니다. `type`이 `paper-hub`, `paper-analysis`, `raw-source`인 노트, `10. Raw Sources` 아래 노트, Bookends나 Better Notes의 노트, 이미 CMDS Zotero가 소유한 노트는 거절합니다.

**노트 복구.** **Rebuild current literature note**는 노트를 백업한 뒤 생성 구역을 다시 렌더링하고, 손상·중복·누락된 마커를 고칩니다. 내가 쓴 줄은 모두 남고, 편집했거나 분리(detach)한 중복 블록도 내용이 그대로 남습니다.

**Frontmatter와 식별.** 다음 명령은 열린 노트에 작동합니다. 모두 줄 단위 미리보기를 보여 주고(`-`와 `+`로 표시한 줄만 바뀝니다), 먼저 노트를 백업 폴더에 복사하며, 쓰기 전·중·후에 노트가 바뀌지 않았는지 확인합니다.
- **Refresh frontmatter of current note from Zotero**는 노트에 이미 있는 플러그인 메타데이터 키만 갱신합니다. `zoteroID`와 `tags`는 건드리지 않고 키를 새로 더하지 않습니다.
- **Remove legacy keys from current note**는 0.3과 0.4가 쓰던 키를 지웁니다. **Report notes with legacy Zotero keys**는 그런 키가 남은 노트를 아무것도 바꾸지 않고 보여 줍니다.
- **Relink current note to merged Zotero item**: Zotero에서 노트의 항목이 다른 항목으로 병합되었을 때, 노트를 남은 항목에 다시 연결합니다. 인덱스가 완전할 때만 작동하며, 후보가 여럿이면 직접 고릅니다.

## 노트 구조와 보존 규칙
새 노트의 frontmatter에는 `type: zotero`, `zoteroID`, `zoteroSelectURI`, `zotero-key`, `citekey`, `doi`, `title`, `authors`, `year`, `tags`와 `zotero_title` 같은 `zotero_*` 필드가 들어갑니다. **frontmatter는 처음 한 번만 만들고 이후에는 사용자 소유**입니다. 갱신은 frontmatter를 바꾸지 않으며, 위의 frontmatter 명령만 미리보기를 거쳐 바꿉니다.
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
마커가 손상되었거나, 중복되었거나, CMDS Zotero가 만들지 않은 노트이거나, 같은 식별을 가진 노트가 여럿이면 쓰지 않고 이유와 줄 번호를 보여 줍니다. 손상된 마커는 **Rebuild current literature note**로 고칠 수 있습니다. Zotero에서 지운 주석의 블록은 노트에서 지우지 않습니다.

## 인용, 참고문헌, 사이드바
**인용 넣기**
- **Insert citation from Zotero**: BBT의 Cite As You Write 선택기로 인용을 넣습니다. 기본 형식은 `[@citekey]`입니다. 선택기가 열려 있는 동안 취소 버튼이 있는 알림이 뜨고, **Picker wait**(10분)까지 기다립니다. 그사이 다른 노트로 옮기면 인용을 노트 대신 클립보드에 넣습니다.
- 편집기에서 `[@` 뒤에 citekey·제목·저자·연도 일부를 입력하면 로컬 자동완성이 나옵니다. 캐시된 인덱스를 읽으므로 키 입력마다 Zotero를 부르지 않습니다. 한글은 조합형·분리형 어느 쪽으로 입력해도 찾고, 악센트는 무시합니다(`é`는 `e`와 맞음). Enter는 인용을, Shift+Enter는 서술형 `@key`를, Mod+Enter는 문헌 노트 링크를 넣습니다.
- 새 인용은 커서의 인용에 합쳐집니다. `[@kim2020]` 바로 뒤에서 `[@`를 입력하거나 Zotero 선택기, Zotero 선택 항목, 자료 선택 창으로 인용하면 키를 반복하지 않고 `[@kim2020; @lee2021]`이 됩니다.
- pandoc의 접두어, 위치(locator), 접미어를 이해합니다(예: `[see @kim2020, pp. 33–35; also -@lee2021, ch. 1]`). **Edit citation locator**는 커서에 있는 인용의 위치를 고칩니다.
- **Insert citation from the literature index**는 인덱스에서 자료를 골라 **Default citation format** 형식으로 넣습니다. 형식마다 명령도 따로 있습니다: **Insert pandoc citation**(`[@key]`), **Insert narrative citation**(`@key`), **Insert citekey wikilink**(`[[@key]]`), **Insert author-date citation text**(`(Kim & Lee, 2020)`, 인덱스로 만든 근사치), **Insert Zotero item link**, **Insert literature note link**. 템플릿이 아니라 고정된 형식입니다.
- 자료 선택 창과 자동완성은 필드를 이해합니다: `author:`, `title:`, `year:2019-2021`, `tag:`, `col:<컬렉션 경로>`, `lib:`, `type:`, `has:pdf|note|annotations`(앞에 `-`를 붙이면 제외, 공백이 있는 값은 따옴표).
- **Insert item content from Zotero**는 자료의 Zotero 노트·참고문헌·메타데이터·초록·링크·주석을 사용자 소유 텍스트로 현재 노트에 넣습니다.
- **Paste Zotero links as citations**(기본 끔): Zotero 항목 링크(`zotero://select/…`)를 붙여 넣거나 끌어 놓으면 라이브러리와 item key로 맞춰 기본 형식의 인용을 넣습니다. 인덱스가 모르는 링크는 그대로 붙여 넣습니다.

**편집기 안의 인용**
- 인덱스에 없거나, 여러 항목이 함께 쓰거나, 예전 키인 citekey에는 밑줄을 긋습니다(**Mark citekey problems**, 기본 켬). 인덱스를 불러오기 전에는 표시하지 않고, 불완전한 인덱스로는 키를 '없음'으로 표시하지 않습니다.
- **Citation hover preview**는 제목·저자·연도·참고문헌 카드를 보여 주고, **Show citations as author-date**는 읽기 보기와 실시간 미리보기에서 `[@kim2020, p. 3]`을 "(Kim & Lee, 2020, p. 3)"처럼 보여 줍니다. 둘 다 기본으로 꺼져 있고 노트 텍스트는 바꾸지 않습니다.
- **Mod+click on a citation**으로 인용을 Mod+클릭했을 때 문헌 노트나 위치 쪽의 PDF를 열게 할 수 있습니다(기본 끔). 오른쪽 클릭 메뉴는 커서가 아니라 클릭한 인용에 작동합니다.
- **Citation actions at cursor**는 커서에 있는 인용으로 할 수 있는 동작을 모아 보여 줍니다. 같은 동작이 각각 명령으로도 있습니다: **Open literature note for citation at cursor**(노트가 없으면 가져오기 미리보기 제안), **Open PDF at citation locator**(인덱스가 쪽 라벨을 알면 위치의 쪽 라벨을 Zotero의 쪽 라벨과 맞추고, 알림으로 어떻게 쪽을 찾았는지 알려 줌), **Copy PDF page link for citation at cursor**, 그리고 이 노트 본문에서 예전 키로 된 인용을 모두 미리 보여 주고 실행 취소 한 번으로 되돌릴 수 있게 바꾸는 **Fix renamed citekey in this note**.
- 여러 항목이 함께 쓰는 citekey는 실패하지 않고 어느 항목인지 묻습니다.

**참고문헌과 참고 목록**
- **Bibliography style**: **Choose style**(설정 → Bibliography and references)과 명령 **Choose bibliography style from installed styles**는 Zotero의 `styles` 폴더에 있는 스타일을 읽기 전용으로 보여 줍니다(`~/Zotero`가 아니면 **Zotero data directory**를 정합니다). Better BibTeX가 렌더링하지 못하는 스타일은 이유와 함께 거절합니다. 직접 입력한 스타일이나 로캘도 **Save configuration**을 누를 때 같은 방식으로 확인합니다.
- **Bibliography locale**은 참고문헌 용어와 날짜의 언어·지역을 정합니다(예: `ko-KR`, `de-DE`). 비워 두면 스타일의 기본값을 씁니다.
- 노트의 `csl`과 `lang` frontmatter는 그 노트의 스타일과 로캘을 정합니다. 참고문헌 사이드바, Insert bibliography, 복사한 참고문헌, 참고문헌 구역, 내보내기 키트에 적용됩니다. `csl: apa.csl`은 파일 이름으로 설치된 스타일과 맞춥니다.
- **Open references sidebar**: 현재 노트의 `[@key]`, `@key`, 인용 위키링크를 모아 참고문헌과 미해결 상태를 보여 줍니다. Zotero가 꺼져 있어도 저장된 참고문헌(`.cmds-zotero/bibliography.json`)으로 표시합니다. 인용은 pandoc과 같은 방식으로 셉니다. 코드, HTML 주석, `%%` 주석 안의 인용, 이스케이프한 `\@`, 이메일 주소는 빼고, `-@key`와 `nocite`의 키는 셉니다. 행마다 이전·다음 위치로 이동할 수 있고, 편집기에서는 **Go to next occurrence of the citation at cursor**와 **Go to previous occurrence of the citation at cursor**로 같은 일을 합니다.
- **Check citations in current note**는 인덱스에 없는 키, 여러 항목이 쓰는 키, 예전 키, 문헌 노트가 없는 키, `nocite` 키를 저장된 인덱스로 보여 줍니다. 각 위치를 노트에서 열 수 있습니다.
- **Copy bibliography for current note**(참고문헌 사이드바의 버튼도 같음)는 서식 있는 HTML과 일반 텍스트를 함께 클립보드에 넣으므로 워드프로세서에 서식째 붙습니다. 순서는 **Bibliography order**로 정합니다: 스타일이 정한 순서(기본), 처음 인용한 순서, 가나다·알파벳순.
- **Insert or update references section**은 미리보기를 거쳐 노트 끝에 플러그인 소유 블록을 씁니다. 처음 넣기 전에 노트를 백업합니다. 편집하지 않은 블록은 그 자리에서 갱신하고, 편집한 블록은 그대로 두며, 여는 마커를 `<!-- cmds-zotero-references:detached -->`로 바꾸면 영구히 내 것이 됩니다.
- **Insert bibliography**: 자료 하나의 CSL 참고문헌을 편집기에 넣습니다.
- **Open annotations sidebar**: 현재 문헌 노트, Zotero에서 선택한 항목, 커서의 citekey, 고정한 자료의 주석을 보여 줍니다. 색·유형·태그·첨부로 거르고 정렬·묶기, Zotero에서 최신 주석 가져오기, 카드를 노트로 끌어 넣기, 카드의 More actions 메뉴를 쓸 수 있습니다. **Search annotations**는 색인된 모든 주석을 검색해 콜아웃이나 인용문으로 넣습니다.

**pandoc으로 내보내기**
- **Export pandoc kit for current note**는 **Export kit folder**(기본 `CMDS Zotero exports`) 안에 노트마다 하위 폴더를 만들어 씁니다. 정리한 노트 사본(문헌 링크는 `[@key]`로, 콜아웃은 인용 블록으로 바꾸고 주석과 마커는 지움), 인용한 자료의 CSL-JSON, pandoc defaults 파일이 들어가고, pandoc 명령줄은 클립보드에 복사합니다. 원래 노트는 바꾸지 않고, 플러그인이 pandoc을 실행하지도 않습니다. 내가 고친 이전 키트는 덮어쓰지 않고 새 폴더를 제안합니다.
- **Copy CSL-JSON for cited sources**와 **Write pandoc bibliography sidecar for current note**: 현재 노트가 인용한 자료를 CSL-JSON으로 복사하거나 `.cmds-zotero/bibliography/<노트>.json`에 저장하고, frontmatter에 넣을 `bibliography:` 줄을 알려 줍니다.
- 키트와 내보내기 과정은 [pandoc/DOCX 가이드](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/pandoc-docx.md)에 단계별로 있습니다.

## 전체 명령어

| 명령 | 기능 |
|---|---|
| Send recently read papers to notes | Zotero에서 최근 읽은 논문과 노트 상태를 보고 노트로 보냄 |
| Import literature note | 자료 하나를 미리보기 뒤 가져오기·갱신 |
| Open or import literature note | 자료의 노트를 열거나, 없으면 가져오기 미리보기 |
| Update current literature note | 열린 노트의 갱신 미리보기, 갱신할 구역 선택 가능 |
| Update all owned literature notes | 검토 목록 뒤 플러그인이 만든 노트의 관리 구역 일괄 갱신 |
| Update literature notes changed in Zotero | Update all과 같되 항목이나 주석이 바뀐 노트만 |
| Import literature notes by search | 검토 목록 뒤 필드 검색에 맞는 항목의 노트 생성 |
| Adopt current note as literature note | 다른 Zotero 플러그인의 노트를 내 글은 그대로 둔 채 CMDS Zotero 노트로 넘겨받기 |
| Adopt existing literature notes | 검토 목록 뒤 볼트에서 맞는 노트를 모두 넘겨받기 |
| Rebuild current literature note | 백업 뒤 생성 구역 재렌더링과 마커 복구 |
| Refresh frontmatter of current note from Zotero | 미리보기 뒤 노트에 있는 플러그인 메타데이터 키 갱신 |
| Remove legacy keys from current note | 미리보기 뒤 0.3·0.4가 쓰던 키 삭제 |
| Report notes with legacy Zotero keys | 옛 키가 남은 노트 목록; 아무것도 바꾸지 않음 |
| Relink current note to merged Zotero item | Zotero가 병합한 항목으로 노트 다시 연결 |
| Refresh citekey index | BBT에서 인덱스 전체 갱신 |
| Search literature | 자료를 고르고 동작(열기, 가져오기, 링크 복사 등) 선택 |
| Insert citation from Zotero | Zotero 선택기로 인용 삽입, 취소 가능 |
| Insert citation from the literature index | 인덱스에서 골라 기본 형식으로 인용 삽입 |
| Insert pandoc citation, Insert narrative citation, Insert citekey wikilink, Insert author-date citation text, Insert Zotero item link, Insert literature note link | 해당 형식으로 인용 삽입 |
| Citation actions at cursor | 커서 인용에 대한 동작 목록 |
| Edit citation locator | 커서 인용의 위치(locator) 수정 |
| Open literature note for citation at cursor | 인용한 자료의 노트나 가져오기 미리보기 열기 |
| Open PDF at citation locator | 위치의 쪽으로 PDF 열기 |
| Copy PDF page link for citation at cursor | 그 PDF 쪽 링크 복사 |
| Fix renamed citekey in this note | 미리보기 뒤 이 노트의 예전 citekey 바꾸기 |
| Go to next / previous occurrence of the citation at cursor | 같은 인용의 위치 사이 이동 |
| Check citations in current note | 없는·모호한·예전·노트 없는 키 목록 |
| Insert bibliography | 자료 하나의 참고문헌 삽입 |
| Copy bibliography for current note | 인용한 자료의 참고문헌을 서식·일반 텍스트로 복사 |
| Insert or update references section | 노트 끝의 관리형 참고문헌 블록 작성·갱신 |
| Choose bibliography style from installed styles | Zotero styles 폴더에서 스타일을 골라 BBT로 확인 |
| Export pandoc kit for current note | 내보내기용 정리 사본·CSL-JSON·pandoc defaults 작성 |
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
| Diagnose setup | 보고 전용 설정 점검과 복사 가능한 보고서 |
| Insert item content from Zotero | 자료의 Zotero 노트·인용·메타데이터·초록·링크·주석을 현재 노트에 삽입(사용자 소유 텍스트) |
| Search annotations | 색인된 모든 주석을 검색해 콜아웃이나 인용문으로 삽입 |
| Open / Import / Cite Zotero selection | 명령을 실행할 때 Zotero에서 선택한 항목을 읽어 열기·가져오기·인용 |
| Copy Zotero action script | Zotero 메뉴에서 노트를 여는 Actions & Tags 스크립트 복사([설정](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/zotero-side.ko.md)) |
| Annotations sidebar: … | 주석 사이드바의 따라가기 모드·고정·해제·최신 가져오기 |

PDF 쪽 번호는 **1부터 시작하는 파일 위치**이지 인쇄된 쪽 번호가 아닙니다.

## 설정
설정은 영역별 구역으로 나뉘며, 요청 한도와 에이전트 전용 References headings는 **Advanced** 아래에 있습니다. 입력하는 동안 값을 검사합니다. 값을 바꾼 뒤 **Save configuration**을 누릅니다. 저장 전에는 이전 값이 쓰입니다.

| 구역 | 설정 | 기본값과 의미 |
|---|---|---|
| Connection | Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost 주소만 허용 |
| Connection | Test connection | 저장된 주소로 BBT 연결 시험 |
| Literature index | Index path | `References/Zotero/zotero-index.json`(0.6.5 이전 기본값 `80. References/zotero-index.json`은 인덱스가 이미 있으면 유지) |
| Literature index | Maximum index age | 60분(1–10080); 지나면 다음 조회 때 백그라운드 갱신 |
| Literature index | Refresh saved index | 지금 인덱스 갱신 |
| Citations | Citation trigger | Bracket: `[@` 뒤에 자동완성; At sign: 단독 `@` 뒤에도; Off |
| Citations | Citation format | `pandoc`; Zotero 인용 선택기의 형식 |
| Citations | Picker wait | 600초(30–1800); 인용 선택을 기다리는 시간 |
| Citations | Default citation format | Pandoc citation(`[@key]`); 인덱스에서 넣는 인용과 붙여 넣은 Zotero 링크의 형식 |
| Citations | Mark citekey problems | 켬; 없는·모호한·예전 citekey에 밑줄 |
| Citations | Citation hover preview | 끔; 제목·저자·연도·참고문헌 카드 |
| Citations | Show citations as author-date | 끔; 읽기 보기와 실시간 미리보기에서 저자-연도로 표시, 텍스트는 그대로 |
| Citations | Mod+click on a citation | Nothing; 또는 Literature note, PDF(위치의 쪽) |
| Citations | Paste Zotero links as citations | 끔; 붙여 넣거나 끌어 놓은 Zotero 항목 링크를 인용으로 |
| Literature notes | Output folder | `References/Zotero`; 새 문헌 노트 위치 |
| Literature notes | New note file name | `@{citekey}`; 고정 토큰 `{citekey}`, `{title}`, `{shortTitle}`, `{year}`, `{firstAuthor}`, `{itemType}`, `{collection}` |
| Literature notes | New note subfolder | 비움(출력 폴더 바로 아래); 같은 토큰, 단계 사이는 `/` |
| Literature notes | Image folder | `References/Zotero/images`; 이미지 주석 사본 위치 |
| Literature notes | Excluded tags | `obscite`; 노트와 주석 태그에 넣지 않을 Zotero 태그, 한 줄에 하나 |
| Note layout | Abstract, Bibliography entry, Metadata fields, Links, Zotero notes, Synthesis scaffold | 켬; 끄면 빈 생성 블록으로 자리만 유지 |
| Note layout | Fields by item type | 끔; Zotero 항목 유형에 맞는 메타데이터 필드 |
| Note layout | Join continued highlights | 끔; 코멘트가 `+`로 시작하는 하이라이트를 앞의 것에 합침 |
| Note layout | Zotero rich text | 끔; Zotero의 기울임·굵게·줄바꿈을 Markdown으로 |
| Note layout | Annotation tags | Plain; 또는 Obsidian 태그(`#tag`) |
| Note layout | Synthesis lines, Annotations heading, callout types | 0.6.0 노트 그대로; 테마에 맞게 이름 변경 |
| Annotations | Heading highlight color | Gray; 이 색 하이라이트는 제목이 됨(None이면 모두 콜아웃) |
| Annotations | Follow the Zotero selection | 끔; 창에 초점이 올 때, 또는 사이드바가 선택 항목을 보여 주는 동안 몇 초마다 |
| Annotations | Selection check interval | 10초(3–30) |
| Bibliography and references | Bibliography style | `apa`; Zotero에 설치된 CSL 스타일 ID, 저장할 때 BBT로 확인; 노트의 `csl`이 우선 |
| Bibliography and references | Choose an installed style | **Choose style**로 설치된 스타일을 보고 고른 스타일을 확인 |
| Bibliography and references | Bibliography locale | 비움(스타일 기본값); 예: `ko-KR`; 노트의 `lang`이 우선 |
| Bibliography and references | Bibliography order | 스타일이 정한 순서; 또는 처음 인용한 순서, 가나다·알파벳순 |
| Bibliography and references | Zotero data directory | `~/Zotero`; Zotero의 `styles` 폴더가 있는 폴더, 읽기 전용 |
| Bibliography and references | Export kit folder | `CMDS Zotero exports`; pandoc 내보내기 키트 위치, 노트마다 하위 폴더 |
| Bibliography and references | References sidebar follows the active note | 켬; 끄면 Refresh를 누를 때까지 보던 노트를 유지 |
| Recently read | Recently read window | 30일(7/30/90/365); 최근 읽은 논문 목록과 자료 선택 창 정렬 |
| Connected vaults | Peer vaults | 한 줄에 `볼트 이름 \| 절대 경로`; 다른 볼트 노트 찾기용 |
| Advanced | Request timeout | 20초(1–180) |
| Advanced | Attachment timeout | 60초(1–180); 이미지 렌더링이 필요한 첨부는 더 걸릴 수 있음 |
| Advanced | Parallel requests | 2(1–8); 내보내기·참고문헌·읽기 기록 요청을 동시에 보내는 수 |
| Advanced | Refresh requests | 4(1–8); 인덱스 갱신 중 동시에 보내는 요청 수, Zotero가 느려지면 낮춤 |
| Advanced | References headings | 에이전트 `cites`가 References 구역으로 볼 제목; 기본 `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` |

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
- `annotations`(0.6)는 논문의 주석을 첨부별·읽기 순서로 돌려주며 `--color`, `--type`, `--tag`, `--attachment`로 거릅니다. `--fresh`는 지금의 Zotero를 읽고 `--today`는 오늘 연 논문을 고릅니다.
- `citing`(0.6)은 이전 citekey까지 포함해 논문을 인용한 노트를 줄 번호·발췌와 함께 보여 줍니다.
- `resolve --stdin`(0.6)은 한 줄에 JSON 하나씩, 최대 500건을 한 번에 조회합니다.
- 읽기 전용 환경에서는 `scripts/ingest-ro.mjs`를 씁니다. 쓰기와 `--apply`를 거절합니다.
에이전트는 관리 구역을 직접 고치지 않고, 자기 요약은 `## Synthesis`나 `## Notes`에 씁니다. 전체 규약은 [에이전트 계약](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/agent-contract-v2/contract.md)에 있습니다.

## 교차 볼트와 Hookmark
**Peer vaults**에 등록한 다른 볼트의 노트 지도를 읽기 전용으로 읽고 **Find literature across vaults**로 이동합니다. 같은 citekey라도 다른 볼트에서는 다른 자료일 수 있으므로 식별을 확인합니다.
Hookmark 관련 명령은 링크를 클립보드에 복사할 뿐입니다. Hookmark 설정을 바꾸거나 북마크를 만들거나 스크립트를 실행하지 않습니다.

## 데이터와 개인정보
- 로컬 BBT에 메타데이터, 인용, 참고문헌, 첨부와 주석, 읽기 기록을 요청합니다. Zotero 설정, 데이터베이스, citekey, 라이브러리 기록은 바꾸지 않습니다.
- 이미지 주석을 가져오거나 주석 사이드바·Search annotations에서 콜아웃으로 넣으면 볼트 밖의 Zotero 캐시 이미지를 읽어 이미지 폴더에 복사합니다. 설치된 스타일이 필요할 때(스타일 고르기, `csl`로 스타일을 지정한 노트, pandoc 내보내기 키트) Zotero `styles` 폴더의 `.csl` 파일을 읽기 전용으로 읽습니다.
- 볼트에 쓰는 것은 설정, 인덱스, 문헌 노트, 이미지 사본, 요청한 내보내기 키트, `.cmds-zotero/` 아래의 비공개 파일(참고문헌·노트 지도·백업·PDF 텍스트 캐시)입니다. 플러그인은 `.cmds-zotero/.gitignore`를 먼저 만들어 이 폴더가 git에 올라가지 않게 합니다. PDF 텍스트 캐시는 논문 전문이므로 공유하지 않습니다.
- 인덱스와 노트 지도에는 서지정보, 개인 경로, 주석이 들어갈 수 있습니다. 공개 저장소에 올리지 않습니다.
- 에이전트 요청과 **Diagnose setup**·**Diagnose index and links** 명령을 처리할 때, 볼트가 Git 저장소이면 비공개 파일이 git에서 무시되는지 알리려고 `git`을 읽기 전용(`ls-files`, `check-ignore`)으로 실행합니다. 그 밖의 프로그램은 실행하지 않으며, 내보내기 키트의 pandoc 실행도 사용자에게 맡깁니다.
- 텔레메트리, 자체 HTTP 서버, 자동 업데이트는 없습니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 최근 읽은 논문이 비어 있음 | Zotero 실행 여부, 기간(Reading window), PDF를 Zotero 리더로 열었는지 |
| 새 하이라이트가 노트에 없음 | Zotero 실행 여부; 꺼져 있으면 저장된 인덱스로 렌더링됨 |
| 노트가 "not created by CMDS Zotero"로 거절됨 | 다른 플러그인이 만든 노트; 덮어쓰지 않음. 출력 폴더나 파일명을 확인하거나 **Adopt current note as literature note**로 넘겨받기 |
| 가져오기 차단(손상된 마커) | 미리보기의 줄 번호에서 마커를 고치거나, Reset을 쓰거나, **Rebuild current literature note** 실행 |
| **Update all owned literature notes**가 바로 시작하지 않고 목록을 보여 줌 | 0.6.3부터 모든 일괄 작업은 먼저 검토 목록을 보여 줌; 원하는 행을 선택하고 적용 버튼을 누름 |
| 노트가 Better Notes 동기화 노트라며 건너뜀 | Better Notes가 갱신 내용을 덮어씀; 그 노트만 따로 갱신하면 쓰기 전에 경고함 |
| **Update literature notes changed in Zotero**가 방금 주석을 단 노트를 건너뜀 | 날짜는 저장된 인덱스에서 옴; 먼저 **Refresh citekey index** 실행 |
| 참고문헌 스타일이 거절됨 | Better BibTeX가 렌더링하지 못함, 메시지에 이유가 있음; Zotero에 스타일이 설치되었는지, **Zotero data directory**와 **Bibliography locale** 확인 |
| 편집기에서 citekey에 밑줄이 그어짐 | 인덱스에 없거나, 여러 항목이 쓰거나, 예전 키임: 인덱스를 갱신하거나 **Check citations in current note**, **Fix renamed citekey in this note** 실행; 표시를 숨기려면 **Mark citekey problems** 끄기 |
| 내보내기 키트가 새 폴더를 제안함 | 이전 키트의 파일을 고쳤음; 고친 키트는 덮어쓰지 않음 |
| 인덱스 갱신이 거부됨 | 옛 플러그인 `cmds-link-zotero`가 켜져 있는지 |
| 연결 실패 | Zotero·BBT 실행과 localhost 주소, 시간 제한; **Diagnose setup** 실행 |
| 인용 선택기가 "No citation was picked"를 알림 | 선택기를 닫았거나 **Picker wait**가 지남; 명령을 다시 실행 |
| 최근 읽은 논문에서 Zotero 10이 필요하다고 함 | 읽기 기록은 Zotero 10 이상에서만 제공됨 |
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
