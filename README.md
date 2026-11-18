# Sweet picView

ACDSee 스타일의 사내용 이미지 뷰어 (Windows). Tauri 기반이라 설치파일이 작고 실행이 빠릅니다.

## 주요 기능
- 폴더 트리 / 썸네일 / 미리보기
- 다중 선택: 클릭, Ctrl+클릭, Shift+클릭, 드래그 영역 선택, Ctrl+A
- 뷰어
  - **1장 / 2장 / 4장 보기** (키 1·2·4), 2·4장 보기는 확대·이동이 함께 움직여 비교하기 좋음
  - **선택만 보기**: 선택한 이미지만 넘겨 보기 (키 O, 상단 "👁 선택 보기" 버튼)
  - **정보 패널** 토글 (키 I): 해상도, 크기, 날짜, 폴더, 사진 정보(EXIF)
  - 확대·축소, 1:1(Z), 맞춤(0), 회전(R/L), 슬라이드쇼(F5), 전체 화면(F)
- **이미지 더블클릭으로 열기**: 설치 시 이미지 형식이 연결되며, 이미 켜져 있으면 같은 창에서 열림
- **PPT 내보내기**: 슬라이드 한 장당 이미지 수(1~20장 또는 가로×세로 직접 지정), 슬라이드 크기, 여백, 파일명
- **인쇄**: 종이 한 장당 이미지 수, 용지·방향, 여백, 파일명 (인쇄 창에서 "PDF로 저장" 가능)

## 설치파일 받기
GitHub **Actions** 탭 → 최근 "Windows 설치파일 빌드" → 아래 **Artifacts**의 `SweetPicView-Setup` 다운로드 → 압축 해제 후 실행.

## 기본 이미지 뷰어로 설정
앱 상단 **⚙ 기본 뷰어** 버튼 → Windows 기본 앱 설정에서 *Sweet picView* 검색 → 사진 형식(.jpg, .png 등)을 Sweet picView로 변경.

## 개발
```
npm install
npm start        # 개발 실행 (Rust 필요)
npm run dist     # 설치파일 빌드
```

## 파일 구성
- `src-tauri/src/main.rs` — 백엔드: 폴더 목록, 파일 읽기/저장, 이미지 전달, 파일 연결, EXIF
- `src-tauri/tauri.conf.json` — 앱 이름, 창, 설치파일, 파일 연결 설정
- `renderer/` — 화면 (index.html, style.css, app.js, api.js)
- `renderer/vendor/pptxgen.bundle.js` — PPT 생성 라이브러리
- `build/icon.png` — 아이콘 원본 (`npx tauri icon build/icon.png -o src-tauri/icons`로 아이콘 생성)
