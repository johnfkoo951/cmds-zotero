[![English](https://img.shields.io/badge/English-README-134538)](README.md) [![한국어](https://img.shields.io/badge/한국어-README-E985A2)](README.ko.md)

# CMDS Zotero
검증된 식별자와 보존형 가져오기로 Zotero 자료, 인용, 주석, 문헌 노트를 연결합니다.

**0.3.0 개발 중, 미출시.** 2026-09-14 기준 GitHub Release와 Community Plugins 등록 없음.

Obsidian 1.7.2 이상 | 데스크톱 전용.

## 주요 활용
- 로컬 Better BibTeX 인덱스와 정식 자료/PDF 식별을 사용합니다.
- 인용과 참고문헌을 삽입하고 사이드바에서 출처와 주석을 검토합니다.
- 문헌 노트 하나의 가져오기를 미리 보고 사용자 소유 내용을 보존합니다.
- Zotero를 수정하지 않고 인용 노트와 동의한 다른 볼트 참조를 찾습니다.

## 설치와 첫 사용
개발자/테스터만 루트 소스를 빌드해 백업한 테스트 볼트에 파일 3종을 설치합니다. Zotero/BBT 실행 후 **Save configuration**, **Test**, **Refresh citekey index** 순서로 확인하고 일괄 작업 전에 예제 하나를 미리 보고 가져옵니다.

## 설명서
- [English user guide](docs/guide.md)
- [한국어 사용설명서](docs/guide.ko.md)
- [Web manual](https://apps.cmdspace.work/plugins/cmds-zotero/)
- [Product family](https://apps.cmdspace.work/plugins/)
- [Issues and support](https://github.com/johnfkoo951/cmds-zotero/issues)

## 개인정보와 한계
공개 릴리스와 커뮤니티 설치 경로는 아직 없습니다. 루트 0.3은 별도 0.4 작업과 다릅니다. 그룹 라이브러리, 대화형 선택기, Hookmark 왕복은 환경별 시험이 필요하고 기존 템플릿 즉시 호환을 보장하지 않습니다. 일괄 갱신은 노트마다 묻지 않습니다.
인용 키 자동완성은 기본 `[@`를 사용합니다. 자동완성, 제외 태그, 제목 하이라이트의 세부 설정은 아직 설정 화면에 제공되지 않습니다.

## 개발
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
로컬 개발용 플러그인 파일을 빌드합니다.
[Changelog](CHANGELOG.md)

## 제작자와 라이선스
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. **MIT**, [LICENSE](LICENSE).
