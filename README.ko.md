[![English](https://img.shields.io/badge/English-README-134538)](README.md) [![한국어](https://img.shields.io/badge/한국어-README-E985A2)](README.ko.md)

# CMDS Zotero
검증된 식별자와 보존형 가져오기로 Zotero 자료, 인용, 주석, 문헌 노트를 연결합니다.

**공개 소스는 0.2.0, 로컬 0.3.0 개발본은 아직 미공개입니다.** 2026-09-14 기준 GitHub Release와 Community Plugins 등록 없음.

Obsidian 1.7.2 이상 | 데스크톱 전용.

## 0.3 개발 미리보기
- 로컬 Better BibTeX 인덱스와 정식 자료/PDF 식별을 사용합니다.
- 인용과 참고문헌을 삽입하고 사이드바에서 출처와 주석을 검토합니다.
- 문헌 노트 하나의 가져오기를 미리 보고 사용자 소유 내용을 보존합니다.
- Zotero를 수정하지 않고 인용 노트와 동의한 다른 볼트 참조를 찾습니다.

## 설치와 첫 사용
공개 `main`을 빌드하면 설명서의 로컬 0.3이 아니라 **0.2.0**을 받습니다. 공개된 소스를 시험할 때는 [0.2 기준선 안내](https://github.com/johnfkoo951/cmds-zotero/blob/b58adb733bcd5bc0734ca2f31d6cb420fd8e8fbe/README.md)를 따릅니다. 공개 0.3 설치 경로는 아직 없으며, 0.3 설명서는 개발 미리보기이지 공개 복제본의 기능 보장이 아닙니다.

## 설명서
- [English user guide](docs/guide.md)
- [한국어 사용설명서](docs/guide.ko.md)
- [Web manual](https://apps.cmdspace.work/plugins/cmds-zotero/)
- [Product family](https://apps.cmdspace.work/plugins/)
- [Issues and support](https://github.com/johnfkoo951/cmds-zotero/issues)

## 개인정보와 한계
공개 릴리스와 커뮤니티 설치 경로는 아직 없습니다. 미공개 로컬 0.3은 별도 0.4 작업과 다릅니다. 그룹 라이브러리, 대화형 선택기, Hookmark 왕복은 환경별 시험이 필요하고 기존 템플릿 즉시 호환을 보장하지 않습니다. 일괄 갱신은 노트마다 묻지 않습니다.
인용 키 자동완성은 기본 `[@`를 사용합니다. 자동완성, 제외 태그, 제목 하이라이트의 세부 설정은 아직 설정 화면에 제공되지 않습니다.

## 개발
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
현재 체크아웃한 코드의 파일을 빌드합니다. 공개 `main`은 0.2.0이며 위 명령으로 미공개 0.3 코드를 가져오지는 않습니다.
[Changelog](CHANGELOG.md)

## 제작자와 라이선스
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. **MIT**, [LICENSE](LICENSE).
