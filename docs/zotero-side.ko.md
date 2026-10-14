[English](zotero-side.md) | **한국어**

# Zotero에서 노트 열기

CMDS Zotero는 Zotero에 아무것도 설치하지 않습니다. Zotero 안에서 문헌 노트나 그 가져오기 미리보기를 열려면, 직접 설치하고 관리하는 Zotero 애드온 [Actions & Tags](https://github.com/windingwind/zotero-actions-tags)에 스크립트 하나를 추가합니다. 이 스크립트는 플러그인이 이미 받는 `obsidian://cmds-zotero` 링크를 실행할 뿐이며, Zotero 라이브러리를 바꾸지 않습니다.

## 요구 사항

- Zotero 10.0.3 이상. Zotero 10.0.2는 `obsidian://` 링크를 실행하지 못했습니다.
- Zotero에 설치된 Actions & Tags 2.6 이상.
- 다른 명령과 마찬가지로 Better BibTeX와, Obsidian에서 새로 고친 citekey 색인.

## 스크립트 복사

1. Obsidian에서 **Copy Zotero action script**를 실행합니다.
2. 동작을 고릅니다.
   - **Open literature note**: 이 볼트에서 항목의 노트를 엽니다. 아직 없으면 그렇다고 알려 줍니다.
   - **Preview literature import**: 항목의 가져오기 미리보기를 엽니다. 확인하기 전에는 아무것도 쓰지 않습니다.
3. 이 볼트 이름이 들어간 스크립트가 클립보드에 복사됩니다. 다른 볼트용 동작이 필요하면 그 볼트에서 다시 복사합니다.

## Zotero에 동작 추가

1. Zotero 설정에서 **Actions & Tags**로 갑니다.
2. 동작을 추가합니다. 메뉴나 단축키용이면 이벤트는 비워 두고, 작업(operation)을 **Custom script**로 정한 뒤 스크립트를 데이터에 붙여 넣습니다.
3. "Open in Obsidian" 같은 메뉴 이름을 붙이고 항목 메뉴, 리더 메뉴 또는 둘 다에 표시합니다. 원하면 단축키도 지정합니다.
4. 선택 사항: PDF를 열 때마다 노트를 열려면 **Open file** 이벤트에 같은 스크립트로 동작을 하나 더 추가합니다.

동작은 항목 하나에 대해 실행됩니다. 첨부 파일, 하위 노트, 주석을 선택하면 그 부모 항목으로 봅니다. 항목을 여러 개 선택하면 아무것도 실행하지 않고, Obsidian의 **Open Zotero selection** 또는 **Import Zotero selection**을 쓰라고 안내합니다. 이 명령들은 선택한 항목을 목록으로 보여 주고 하나를 고르게 합니다.

## 확인 창

처음에는 Zotero가 `obsidian://` 링크를 Obsidian으로 열어도 되는지 묻습니다. 허용하세요. 계속 묻는다면 Zotero 설정 편집기(Config Editor)의 프로토콜별 설정 `network.protocol-handler.external.obsidian`과 `network.protocol-handler.warn-external.obsidian`이 이 창을 결정합니다. 방법은 Zotero 버전마다 다릅니다. CMDS Zotero는 이 설정을 대신 바꾸지 않습니다.

## 링크의 구성

```
obsidian://cmds-zotero?vault=<볼트>&libraryID=<라이브러리 ID>&itemKey=<항목 키>&target=note|import
```

`libraryID`는 Zotero의 로컬 라이브러리 ID, `itemKey`는 항목의 여덟 자리 키입니다. Obsidian은 이 둘을 저장된 색인과 맞춰 보며, 제목이나 첫 검색 결과로 짐작하지 않습니다. 항목이 아직 색인에 없으면 그렇다고 알려 줍니다. citekey 색인을 새로 고친 뒤 다시 시도하세요.

## 다루지 않는 것

- Obsidian에서 PDF 열기. `target=pdf` 링크는 Zotero에서 PDF를 열기 때문에 스크립트에서 제공하지 않습니다.
- 클릭 한 번 설치, 노트 존재 여부를 보여 주는 Zotero 기본 메뉴, "Obsidian 노트" 열. 이런 기능에는 Zotero 애드온이나 로컬 서버가 필요하며, 이 플러그인은 제공하지 않습니다.
