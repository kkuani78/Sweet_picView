# Sweet picView

> **원칙: 가볍게 열리고, 빠르게 이미지를 찾는다.** 모든 기능 추가·수정은 이 원칙을 먼저 따집니다 (자세한 기준은 `CLAUDE.md`).

ACDSee 스타일의 사내용 이미지 뷰어 (Windows). Tauri 기반이라 설치파일이 작고 실행이 빠릅니다.

## 주요 기능
- 폴더 트리 / 썸네일 / 미리보기
- **폴더 즐겨찾기**: 경로 옆 ☆ 버튼 또는 Ctrl+D로 추가, 트리 맨 위 ★ 즐겨찾기에서 바로 열기, 오른쪽 클릭으로 빼기·순서 바꾸기, 이동/복사 창에서도 선택
- 다중 선택: 클릭, Ctrl+클릭, Shift+클릭, 드래그 영역 선택, Ctrl+A
- 뷰어
  - **1장 / 2장 / 4장 보기** (키 1·2·4), 칸을 클릭해 고른 뒤 그 칸만 확대·이동
  - **선택만 보기**: 선택한 이미지만 넘겨 보기 (키 O, 상단 "👁 선택 보기" 버튼)
  - **정보 패널** 토글 (키 I): 해상도, 크기, 날짜, 폴더, 사진 정보(EXIF)
  - 마우스 휠 = 이전/다음 이미지, 확대·축소는 = / - 키 (또는 Ctrl+휠), 1:1(Z), 맞춤(0), 회전(R/L), 슬라이드쇼(F5), 전체 화면(F)
- **이미지 더블클릭으로 열기**: 설치 시 이미지 형식이 연결되며, 이미 켜져 있으면 같은 창에서 열림
- **지원 형식**: JPG · PNG · GIF · WebP · BMP · AVIF · ICO · SVG · TIFF · TGA · EXR · PSD/PSB · IFF(Maya, Amiga) · HEIC/HEIF · RAW(CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW 등)
  - RAW는 카메라 내장 미리보기 사용, HEIC는 Windows의 "HEIF 이미지 확장"·"HEVC 비디오 확장" 필요
  - 변환 결과는 임시 폴더(`%TEMP%\sweetpicview-cache`)에 캐시, 14일 지나면 자동 삭제
- **일괄 리사이즈**: 비율/긴 변/가로/세로/영역 맞추기, 원본 형식·JPG·PNG, 하위 폴더·다른 폴더·덮어쓰기
- **일괄 이름 바꾸기 (F2)**: 프리픽스, 포스트픽스, 새 이름, 리넘버링(시작·증가·자릿수·위치·구분자), 확장자 대소문자, 미리보기·충돌 검사·되돌리기
- **끌어서 보내기**: 썸네일(선택한 여러 장도)을 잡아 보드·크롬·탐색기·포토샵 등 다른 프로그램에 바로 놓기 (복사)
- **📁 이동·복사 (F7)**: 선택 파일을 기존 폴더 또는 새 폴더로 이동/복사, 최근 폴더, 같은 이름 처리(번호 붙이기·건너뛰기·덮어쓰기), 이동 되돌리기
- **📌 레퍼런스 보드 Sweet Ref (B)**: PureRef 방식의 참고 이미지 보드 (별도 창)
  - 끌어다 놓기 · Ctrl+V · PicView에서 보내기 / 휠 확대 · 가운데 버튼(또는 Space) 끌어 이동
  - 이동·크기·회전·뒤집기·자르기, 자동 정렬(Ctrl+P), 회색조(G), 항상 위(T), 투명도(Ctrl+휠)
  - 텍스트 메모 (Ctrl+T, 더블클릭으로 고치기, 글자색·배경·굵게·크기) — Pretendard 폰트 내장 (SIL OFL, 설치 불필요)
  - 되돌리기, `.sref` 보드 파일 저장/열기 (이미지 포함, 더블클릭으로 바로 열림), 오른쪽 클릭 메뉴, F1 도움말
- **PPT 내보내기**: 슬라이드 한 장당 이미지 수(1~20장 또는 가로×세로 직접 지정), 슬라이드 크기, 여백, 파일명
- **인쇄**: 종이 한 장당 이미지 수, 용지·방향, 여백, 파일명 (인쇄 창에서 "PDF로 저장" 가능)

## 설치 / 업데이트
- **처음 설치**: 저장소의 **Releases** → 최신 버전 → `..._x64-setup.exe` 다운로드 후 실행
- **업데이트**: 앱이 켜질 때 새 버전을 확인해서 위쪽에 **⬆ 새 버전** 버튼을 보여줌 → 누르면 받아서 덮어쓰고 다시 켜짐
  (아래 상태줄의 버전 표시를 누르면 바로 확인)
- 설치파일을 직접 실행해도 기존 앱을 지우지 않고 그대로 덮어씀
- 시험용 빌드: PR의 **Actions** → Artifacts `SweetPicView-Setup`

## 새 버전 내보내기 (개발자용)
1. `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`의 버전을 올린다
2. PR → main에 병합 → GitHub Actions가 빌드하고 `v버전` 릴리스를 자동으로 만든다
3. 업데이트 서명 키: 저장소 Settings → Secrets → `TAURI_SIGNING_PRIVATE_KEY` (잃어버리면 기존 설치본에 업데이트를 보낼 수 없음)

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
- `src-tauri/src/convert.rs` — 특수 형식 변환 (TIFF·TGA·EXR·PSD·IFF·RAW·HEIC) + 캐시
- `src-tauri/src/tools.rs` — 일괄 리사이즈, 일괄 이름 바꾸기
- `src-tauri/src/thumbs.rs` — 빠른 썸네일 (Windows 탐색기 썸네일 → JPEG 축소 디코드 → 일반 디코드, 디스크 캐시)
- `src-tauri/src/wic.rs` — Windows 이미지 코덱(HEIC 등), 탐색기 썸네일
- `src-tauri/tauri.conf.json` — 앱 이름, 창, 설치파일, 파일 연결 설정
- `renderer/` — 화면 (index.html, style.css, app.js, tools.js, api.js)
- `renderer/board.*` — 레퍼런스 보드 Sweet Ref
- `renderer/fonts/` — Pretendard 폰트 (Regular·Bold, 라이선스 `Pretendard-LICENSE.txt`)
- `renderer/vendor/pptxgen.bundle.js` — PPT 생성 라이브러리
- `src-tauri/installer/installer.nsi` — 설치 프로그램 템플릿 (기존 버전을 지우지 않고 덮어쓰도록 수정)
- `build/icon.png` — 아이콘 원본 (`npx tauri icon build/icon.png -o src-tauri/icons`로 아이콘 생성)
