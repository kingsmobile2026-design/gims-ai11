# Gims AI

Node 18+ . 의존성: `mongodb` (선택). **모든 소스 파일이 루트에 있습니다** (tools/ 폴더 없음).

## 구조

```
server.js          # 진입점
db.js              # Mongo / JSON 저장
reasoning.js       # 추론 엔진
reasoning_tools.js # 수학·코딩 도구 코어
tool_registry.js   # 도구 등록·실행 루프
agent.js           # 코딩 에이전트 지시
workspace.js       # 작업 공간 + zip
workspace_tools.js # 파일 생성 도구
store.js data.js … # 기타 도구
public/index.html  # 프론트
```

## 실행

```bash
npm install
export AD_PASS='관리자비밀번호'   # 또는 ADMIN_PASS
export DB='mongodb://...'         # 또는 MONGODB_URI
export GEMINI_API_KEY='...'
node server.js
```

## 주요 기능

- 관리자 비번: `AD_PASS` / Mongo URL: `DB`
- 추론 로그·채팅·API 등 Mongo 1초 주기 저장
- 채팅에서 파일 생성 요청 시 실제 워크스페이스 파일 생성 → `/api/workspace/zip`
- 창 전환 후 복귀 시 네트워크 오류 완화

## 가상 서버 (vserver)

AI가 HTML/JS를 만든 뒤 메모리 가상 서버에서 검사합니다.

- `vserver_deploy` — 작업 공간 또는 HTML 배포 + 자동 스크립트 검사
- `vserver_check_page` — 문법/런타임 오류·console
- `vserver_request` — GET 으로 경로/404 확인
- `vserver_run_js` — JS 스니펫만 실행

코딩 의도 분류 시 workspace·vserver·sandbox 도구 그룹이 함께 활성화됩니다.
