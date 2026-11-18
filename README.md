# PicView

ACDSee 스타일의 사내용 이미지 뷰어 (Windows, Electron).

## 주요 기능
- 폴더 트리 / 썸네일 / 미리보기, 전체 화면 뷰어 (확대·축소, 회전, 슬라이드쇼)
- 다중 선택: 클릭, Ctrl+클릭, Shift+클릭, 드래그 영역 선택, Ctrl+A
- **PPT 내보내기**: 슬라이드 한 장당 이미지 수(1~20장 또는 가로×세로 직접 지정), 슬라이드 크기, 여백, 파일명 표시
- **인쇄**: 종이 한 장당 이미지 수, 용지(A4/A3/B5/Letter)·방향, 프린터 인쇄 또는 PDF 저장

## 설치파일 받기
GitHub의 **Actions** 탭 → 가장 최근 "Windows 설치파일 빌드" 실행 → 아래 **Artifacts**의 `PicView-Setup` 다운로드 → 압축 해제 후 exe 실행.

## 개발
```
npm install
npm start          # 앱 실행
npm run dist       # Windows 설치파일 빌드 (dist/)
```

## 파일 구성
- `main.js` — 창, 파일 읽기, 저장, 인쇄 (메인 프로세스)
- `preload.js` — 화면과 메인 프로세스 연결
- `renderer/` — 화면 (index.html, style.css, app.js)
- `renderer/vendor/pptxgen.bundle.js` — PPT 생성 라이브러리
- `build/` — 앱 아이콘
