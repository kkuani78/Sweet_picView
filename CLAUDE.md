# Sweet picView — 작업 안내 (AI·개발자용)

## 최우선 원칙: "가볍게 열리고, 빠르게 이미지를 찾는다"
모든 수정은 이 원칙을 먼저 따진다. 요청받은 기능이라도 이 원칙을 해치면 **그대로 만들지 말고 먼저 사용자에게 알리고**, 더 가벼운 방법을 제안한다.

판단 기준:
- **시작 속도**: 프로그램을 켤 때 읽는 코드·파일을 늘리지 않는다. 무거운 기능(PPT 라이브러리, 보드, 폰트 등)은 **처음 쓸 때 불러온다**.
- **화면이 멈추지 않게**: 파일·폴더·네트워크에 접근하는 Rust 명령은 반드시 `async`로 만든다 (동기 명령은 메인 스레드에서 돌아 화면 전체가 멈춤). 드라이브·네트워크 경로를 미리 "확인"하지 않는다.
- **이미지 찾기 속도**: 썸네일은 Rust에서 작게 만들어 캐시(`thumbs.rs`), 원본 전체를 화면으로 넘기지 않는다. 목록·정렬·검색은 즉시 반응해야 한다.
- **설치파일 크기**: 새 라이브러리·리소스를 넣을 땐 크기를 확인하고 꼭 필요한지 따진다.
- 기능을 추가하면 위 항목에 미치는 영향을 PR 설명에 한 줄로 적는다.

## 구조
- `src-tauri/src/main.rs` — 명령(폴더 목록, 파일 읽기/저장, 이미지·썸네일 전달 프로토콜, 업데이트, 창 관리)
- `src-tauri/src/convert.rs` — 특수 형식(TIFF·TGA·EXR·PSD·IFF·RAW·HEIC) 변환 + 캐시
- `src-tauri/src/thumbs.rs` — 빠른 썸네일 (Windows 탐색기 썸네일 → JPEG 축소 디코드 → 일반 디코드)
- `src-tauri/src/tools.rs` — 리사이즈, 이름 바꾸기, 이동/복사
- `src-tauri/src/wic.rs` — Windows 전용 (WIC, 탐색기 썸네일)
- `renderer/` — 화면 (`app.js` 뷰어, `tools.js` 대화상자, `board.*` 레퍼런스 보드, `api.js` 백엔드 연결)

## 규칙
- 화면 문구는 한국어, 쉬운 말로.
- 버전은 세 곳을 함께 올린다: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`.
- PR → (Windows 빌드 확인) → main 병합 시 GitHub Actions가 릴리스와 `latest.json`을 만들고, 앱의 업데이트 버튼이 이를 받는다.
- `@tauri-apps/cli` 버전은 고정(설치 템플릿 `src-tauri/installer/installer.nsi`가 해당 버전 기준으로 수정됨).
