# Zapper Open

[English](README.en.md) · 한국어

클로드 코드(Claude Code) 세션을 브라우저에서 들여다보는 가장 작은 대시보드.

![대시보드 — user 앵커에서 세션 노드로 전기 아크, say 버블, 우측 터미널](docs/demo.png)

- AI가 도구를 쓸 때마다 상단 user 앵커에서 세션 노드로 전기 아크가 흐른다 — gold(명령 in)·green(결과 out). 무슨 일이 일어나는지 글이 아니라 그림으로 본다.
- 노드마다 say 버블(마지막 응답 한 줄)이 붙고, 작업 중/대기 상태에 따라 글로우가 바뀐다.
- 상단 cmd 바에서 "의견"을 보내면 그 노드의 다음 차례에 끼워 넣어진다.
- 민감한 도구(Bash·Edit·Write) 승인을 노드 위 in-canvas 박스에서 누른다. 안 누르면 원래의 터미널 프롬프트로 돌아간다.
- 노드를 클릭하면 오른쪽 사이드 터미널(별도 풀스크린 페이지도)이 그 tmux 세션에 붙어, 웹에서 직접 타이핑한다.

단일 사용자, 로컬 전용. 이벤트·세션 상태는 메모리에만 있고 프로세스를 끄면 사라진다. DB도, 클라우드도, 외부 인증도 없다.

> 이 레포는 더 큰 사설 도구("Zapper")의 공개 가능한 부분이다. 프론트엔드(`main-view.js` 아트 엔진 + `styles.css` + 레이아웃)는 실제 Zapper에서 그대로 가져와 디자인을 맞췄고, codex 노드·사용량 한도·파일 업로드 같은 기능과 사적 경로·토큰은 발라냈다.

## 구조

```
zapper-open/
├── server/
│   ├── index.js        Node 브리지 (Express + ws). 이벤트 수신·세션·의견큐·승인·say. 인메모리.
│   └── pty.js          /pty/ws — node-pty 로 tmux 세션에 attach (xterm 백엔드)
├── web/                p5.js 대시보드 + xterm 터미널
│   ├── main-view.js    p5 아트 엔진 (노드·전기아크·글로우·say 버블·in-canvas 승인). 실제 Zapper 이식.
│   ├── main.js         컨트롤러 — WS → main-view 구동, picker·cmd바·승인·노드클릭→터미널
│   ├── styles.css      실제 Zapper 스타일 (헤더·cmd바·grid 레이아웃)
│   ├── index.html      메인 대시보드
│   ├── term.js         xterm ↔ /pty/ws 공용 헬퍼
│   └── terminal.html   풀스크린 터미널 (별도 탭)
├── hooks/              pre-tool-use-health-gate.sh — 브리지 다운 시 게이팅 도구 deny
├── settings-snippet.json   ~/.claude/settings.json 에 머지할 훅 설정
└── scripts/install.sh  훅을 settings.json 에 자동 머지 (백업 + 경로 치환)
```

작동 원리: 클로드 코드는 도구 실행 전후·응답 종료·프롬프트 입력 같은 시점마다 훅을 부른다. 이 레포의 훅은 대부분 `{"type":"http"}` 라서 별도 스크립트 없이 브리지의 URL로 곧장 이벤트가 들어온다. 브리지는 그걸 받아 웹소켓으로 브라우저에 중계하고, 승인이 필요한 도구는 브라우저가 답할 때까지 응답을 미룬다.

## 빠른 시작

필요: Node 18+, `tmux`, `jq`, `curl`. (터미널을 쓰려면 `tmux`. macOS는 node-pty 빌드에 Xcode CLT가 필요할 수 있다 — `xcode-select --install`.)

```bash
# 1. 의존성 설치 (express, ws, node-pty)
npm install

# 2. 브리지 가동
npm start
# [zapper] listening on http://127.0.0.1:8089

# 3. 브라우저 열기
open http://127.0.0.1:8089/

# 4. 훅 연결 (이게 핵심 — 안 하면 대시보드는 떠 있지만 비어있다)
bash scripts/install.sh

# 5. 클로드 코드 재시작 (settings.json 은 세션 시작 시 로드된다)
```

이제 클로드 코드에서 아무 작업이나 시키면 대시보드에 입자가 흐른다.

## 쓰는 법

- **세션 고르기**: 헤더 picker. 기본은 "All sessions (timeline)" — 모든 세션을 합쳐 본다.
- **라벨**: 세션을 고른 뒤 라벨 입력 → save. UUID 대신 사람이 알아볼 이름으로 보인다.
- **의견 보내기**: 세션을 고른 뒤 아래 입력창에 텍스트 → send. 그 세션의 다음 프롬프트 앞에 자동으로 붙는다. (이미 진행 중인 차례에는 안 붙는다 — 다음 프롬프트 전에 보내야 한다.)
- **승인**: Bash·Edit·Write·NotebookEdit 호출 시 모달이 뜬다. allow/deny. 120초 안 누르면 모달이 닫히고 클로드 코드 기본 터미널 프롬프트로 폴백한다. 그래서 브라우저를 안 보고 있어도 안전하다.

## 터미널

오른쪽 사이드 터미널(넓은 화면 ≥900px에서 표시)과 `Terminal ↗` 버튼이 여는 풀스크린 `/terminal.html`은 둘 다 tmux 세션에 붙는다. 헤더의 `main` 입력칸이 tmux 세션 이름이다.

```bash
# 클로드 코드를 tmux 안에서 띄운다
tmux new -s main
claude     # tmux 세션 'main' 안에서 실행
```

이제 사이드 터미널의 `attach`(또는 풀스크린 페이지)가 같은 세션에 붙어, 본인 키보드와 웹이 같은 셸을 공유한다. 세션이 없으면 `tmux new-session -A`가 새로 만든다. 입력은 키 입력 전용 — 의견 주입은 cmd 바를 쓴다.

## 외부·모바일 접속 (Tailscale)

폰이나 다른 PC에서 보고 싶으면 [Tailscale](https://tailscale.com)(개인 사설망)을 깔고 브리지를 Tailscale IP로 띄운다:

```bash
ZAPPER_TOKEN=$(openssl rand -hex 32) ZAPPER_HOST=$(tailscale ip -4) npm start
```

`ZAPPER_HOST`가 localhost가 아니면 브리지는 127.0.0.1도 함께 바인딩한다 — 훅의 기본 대상(127.0.0.1:8089)이 살아있어야 이벤트가 들어오기 때문. 폰의 Tailscale 브라우저로 `http://<Tailscale IP>:8089/?token=<값>` 으로 접속한다.

- Tailscale 사설망 안에서만 도달. 인터넷에 그대로 노출되지 않는다.
- 외부로 열 때는 `ZAPPER_TOKEN`을 꼭 켜라. 훅 payload에 명령어·파일 경로가 담긴다.

## 보안

- 기본 `127.0.0.1` 바인딩. 같은 머신 안에서만 도달.
- 토큰을 켜려면: `ZAPPER_TOKEN=$(openssl rand -hex 32) npm start`. 브라우저는 `http://127.0.0.1:8089/?token=...` 로 열고, 훅도 같은 토큰을 보게 환경변수에 넣는다.
- 훅 payload에는 명령어·파일 경로 등이 담긴다. 토큰 미설정은 신뢰 가능한 단일 사용자 로컬 환경에서만.

## 환경 변수

| 변수 | 용도 | 기본 |
|---|---|---|
| `ZAPPER_HOST` | 브리지 바인딩 주소 | `127.0.0.1` |
| `ZAPPER_PORT` | 포트 | `8089` |
| `ZAPPER_TOKEN` | 공유 토큰 (선택) | unset |
| `ZAPPER_APPROVAL_TIMEOUT_MS` | 승인 대기 시간 | `120000` |
| `ZAPPER_TMUX_DEFAULT` | 터미널 기본 tmux 세션 이름 | `main` |

## 직접 만들어보기

이 레포는 "정답지"다. 클로드 코드에게 단계별로 부탁하면 처음부터 똑같은 걸 만들 수 있다. 한 번에 다 만들지 말고 훅 1개 → 브리지 라우트 1개 → 입자 1개 순서로, 화면에서 확인하며 키우는 게 핵심이다.

## 라이선스

MIT.
