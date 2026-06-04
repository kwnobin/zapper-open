window.__zapperMainViewBuild = "in-canvas-hit-test-order-2026-05-19-v13";
const container = document.getElementById("main-view-container");
const claudeNodes = new Map();
// 이벤트 발생 시 잠깐 흐르는 빛 — 항상 emit 하는 게 아니라 push() 호출 시마다 1회.
const particles = [];
const MAX_PARTICLES = 200;
const codexNodes = new Map();
let connections = [];
let selectedSessionId = null;
// codex 노드 선택 — drawCodexNodes 가 selection 효과 (ring + size + ▼) 표시.
let selectedCodexKey = null;
let dragState = null;

const DOUBLE_CLICK_MS = 350;
let lastNodeClick = { id: null, ts: 0 };

function emitNodeClick(id) {
  if (!id) return;
  // 결정적 차단점 — 어떤 캔버스 path(mouse/touch/long-press)로 들어오든 결국
  // 이 함수를 통과한다. HTML 모달 떠있으면 path 무관하게 무시.
  if (isAnyModalOpen()) return;
  const now = Date.now();
  if (lastNodeClick.id === id && (now - lastNodeClick.ts) < DOUBLE_CLICK_MS) {
    lastNodeClick = { id: null, ts: 0 };
    window.observatoryOnClaudeNodeDoubleClick?.(id);
    return;
  }
  lastNodeClick = { id, ts: now };
  window.observatoryOnClaudeNodeClick?.(id);
}

// codex 노드 click — codex 노드 redesign (plan v2). claude 와 같은 1-click=side mount / 2-click=page 이동 패턴.
function emitCodexNodeClick(codexKey, tmuxTarget) {
  if (!codexKey) return;
  if (isAnyModalOpen()) return;
  const now = Date.now();
  if (lastNodeClick.id === codexKey && (now - lastNodeClick.ts) < DOUBLE_CLICK_MS) {
    lastNodeClick = { id: null, ts: 0 };
    window.observatoryOnCodexNodeDoubleClick?.(codexKey, tmuxTarget);
    return;
  }
  lastNodeClick = { id: codexKey, ts: now };
  window.observatoryOnCodexNodeClick?.(codexKey, tmuxTarget);
}

// approval / askq HTML 모달이 떠 있는지 — 캔버스 입력 차단의 최종 안전망.
function isAnyModalOpen() {
  const approval = document.getElementById("approval-modal");
  const askq = document.getElementById("askq-modal");
  return (approval && !approval.hidden) || (askq && !askq.hidden);
}

const POSITION_STORAGE_KEY = "observatory.nodePositions";
const savedPositions = (() => {
  try { return JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) || "{}"); }
  catch { return {}; }
})();

function saveNodePosition(id, ratioX, ratioY) {
  savedPositions[id] = { ratioX, ratioY };
  try { localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(savedPositions)); }
  catch {}
}

// codex root 노드 position key — claude session_id 와 collision 회피용 prefix.
function codexPositionKey(codexSessionId) {
  return codexSessionId ? `codex:${codexSessionId}` : null;
}

// root codex 의 초기 위치 — claude 영역 (x=0.30-0.55) 와 살짝 분리해서 시각 구분.
function findInitialCodexRootPosition() {
  const region = { x1: 0.42, x2: 0.58, y1: 0.16, y2: 0.34 };
  return {
    ratioX: region.x1 + Math.random() * (region.x2 - region.x1),
    ratioY: region.y1 + Math.random() * (region.y2 - region.y1)
  };
}

function findInitialPosition() {
  const region = { x1: 0.30, x2: 0.55, y1: 0.15, y2: 0.85 };
  for (let attempt = 0; attempt < 30; attempt++) {
    const ratioX = region.x1 + Math.random() * (region.x2 - region.x1);
    const ratioY = region.y1 + Math.random() * (region.y2 - region.y1);
    let conflict = false;
    for (const [, node] of claudeNodes.entries()) {
      if (node.draggedRatioX === undefined) continue;
      const dx = ratioX - node.draggedRatioX;
      const dy = ratioY - node.draggedRatioY;
      if (Math.sqrt(dx * dx + dy * dy) < 0.06) { conflict = true; break; }
    }
    if (!conflict) return { ratioX, ratioY };
  }
  return {
    ratioX: region.x1 + Math.random() * (region.x2 - region.x1),
    ratioY: region.y1 + Math.random() * (region.y2 - region.y1)
  };
}
let sketch = null;

const colors = {
  working: "#7ee787",
  idle: "#f0f0f0",                    // (claude/codex 외 fallback)
  idleClaude: "#b8e9c0",              // claude idle — 연초록 (green 의 옅은 톤)
  idleCodex:  "#a5e3f5",              // codex idle — 연파랑 (cyan 의 옅은 톤)
  awaiting: "#ffb627",
  error: "#ff6e6e",
  codex: "#00d4ff"
};

// event type → particle 방향·색. user↔claude bezier path 따라 1회 흐름.
//   gold (user → claude): UserPromptSubmit, inject 류
//   green (claude → user): PostToolUse, Stop, Notification
//   PreToolUse 는 양쪽 다 의미 가능 — 일단 gold (사용자→claude 가 명령 보낸 결과)
const EVENT_PARTICLE = {
  UserPromptSubmit: { kind: "user-to-claude", color: [255, 200, 70] },
  PreToolUse:       { kind: "user-to-claude", color: [255, 200, 70] },
  PostToolUse:      { kind: "claude-to-user", color: [126, 231, 135] },
  Stop:             { kind: "claude-to-user", color: [126, 231, 135] },
  Notification:     { kind: "claude-to-user", color: [200, 200, 210] }
};

// motionStage 별 particle 변조 — agentcat 활성도 패턴.
const MOTION_MUL = {
  sleeping:  { speed: 0.5, count: 0.5 },
  walking:   { speed: 1.0, count: 1.0 },
  running:   { speed: 1.4, count: 1.2 },
  sprinting: { speed: 1.9, count: 1.5 }
};
const activityState = { stage: "walking", score: 0, processCount: 0 };

function motionMul() {
  return MOTION_MUL[activityState.stage] || MOTION_MUL.walking;
}

function emitParticles(kind, opts) {
  const mul = motionMul();
  // 전기 arc 는 dot 보다 시각 임팩트 큼 — 옛 count(3) 그대로면 너무 시끄러움. cap 2.
  const baseCount = Math.min(2, opts.count || 1);
  const count = Math.max(1, Math.round(baseCount * mul.count));
  for (let i = 0; i < count; i += 1) {
    particles.push({
      kind,
      sessionId: opts.sessionId || null,
      codexKey: opts.codexKey || null,
      color: opts.color || [255, 255, 255],
      // arc lifecycle ~ 25 frames (0.4s) base, motion 빠르면 짧게.
      t: 0,
      speed: (0.04 + Math.random() * 0.015) * mul.speed,
      delay: i * 0.06,
      jitterSeed: Math.random() * 1000
    });
  }
  if (particles.length > MAX_PARTICLES) {
    particles.splice(0, particles.length - MAX_PARTICLES);
  }
}

if (container) window.mainViewBus = {
  resize() {
    resizeArtCanvas();
  },
  push(event) {
    const style = EVENT_PARTICLE[event?.type];
    if (!style || !event?.session_id) return;
    const node = claudeNodes.get(event.session_id);
    if (node?.parentCodexSessionId) {
      const codexKey = `codex:${node.parentCodexSessionId}`;
      if (codexNodes.has(codexKey)) {
        const kind = style.kind === "user-to-claude" ? "codex-to-claude" : "claude-to-codex";
        emitParticles(kind, { sessionId: event.session_id, codexKey, color: style.color, count: 3 });
        return;
      }
    }
    emitParticles(style.kind, { sessionId: event.session_id, color: style.color, count: 3 });
  },
  setActivity(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    activityState.stage = typeof snapshot.motionStage === "string" ? snapshot.motionStage : "walking";
    activityState.score = Number(snapshot.activityScore) || 0;
    activityState.processCount = Number(snapshot.processCount) || 0;
  },
  setSessionStatus(id, status) {
    if (!id) return;
    if (!claudeNodes.has(id)) {
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "working",
        label: "",
        approval: null,
        approvalBox: null,
        say: null,
        sayBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
    }
    const node = claudeNodes.get(id);
    node.status = status || "working";
  },
  setApproval(id, payload) {
    if (!id) return;
    // setAskq 와 동일 — 노드 없으면 생성 (PermissionRequest(ExitPlanMode 등)가 event 보다
    // 먼저 도착하거나 그 세션 노드가 아직/이미 없는 race 보호). 이게 없어서 PermissionRequest
    // 승인 박스가 캔버스에 안 뜨던 버그 (2026-05-29).
    if (!claudeNodes.has(id) && payload) {
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "awaiting",
        label: "",
        approval: null,
        approvalBox: null,
        say: null,
        sayBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
    }
    if (!claudeNodes.has(id)) return;
    const node = claudeNodes.get(id);
    if (payload) {
      node.approval = {
        approval_id: payload.approval_id,
        tool_name: payload.tool_name,
        tool_input: payload.tool_input,
        expanded: false
      };
    } else {
      node.approval = null;
      node.approvalBox = null;
    }
  },
  setSay(id, textOrNull) {
    if (!id) return;
    // setSessionStatus 와 동일하게 노드 없으면 생성 (label 은 main.js 가 곧 갱신)
    if (!claudeNodes.has(id)) {
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "idle",
        label: "",
        approval: null,
        approvalBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
    }
    const node = claudeNodes.get(id);
    node.say = textOrNull ? String(textOrNull) : null;
    if (!node.say) node.sayBox = null;
  },
  setAskq(id, infoOrNull) {
    if (!id) return;
    // setSay 와 동일하게 노드 없으면 생성 — approval_request 가 event 보다 먼저 도착하는 race 보호
    if (!claudeNodes.has(id) && infoOrNull) {
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "awaiting",
        label: "",
        approval: null,
        approvalBox: null,
        say: null,
        sayBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
    }
    if (!claudeNodes.has(id)) return;
    const node = claudeNodes.get(id);
    if (infoOrNull && typeof infoOrNull === "object") {
      node.askq = {
        count: Number.isFinite(infoOrNull.count) ? infoOrNull.count : 1,
        approval_id: infoOrNull.approval_id || null
      };
    } else {
      node.askq = null;
      node.askqBox = null;
    }
  },
  setSelectedSession(id) {
    // HTML 모달 떠 있을 때는 노드 highlight 자체를 안 바꿈 — 가장 좁은 결과 함수에서
    // 차단. 어떤 path(p5 hook · main.js handler · external)로 들어와도 시각
    // 효과는 항상 막힘. selection 자체는 main.js 의 state.selectedSessionId
    // 가드가 막고, 이건 canvas highlight 갱신을 추가로 막는 안전망.
    if (isAnyModalOpen()) return;
    selectedSessionId = (!id || id === "__all__") ? null : id;
    // claude 선택 = codex 선택 해제 (사용자 cmd-bar 의 selectedCodexAgent 와 일관)
    if (selectedSessionId) selectedCodexKey = null;
  },
  setSelectedCodex(codexKey) {
    // codex 노드 selection 효과용. claude 와 동일 시각 효과 (drawCodexNodes 분기).
    if (isAnyModalOpen()) return;
    selectedCodexKey = codexKey || null;
    if (selectedCodexKey) selectedSessionId = null;
  },
  // Unit B: codex 노드의 currentTool 라벨 (claude setCurrentTool 과 같은 패턴).
  setCodexCurrentTool(codexKey, payload) {
    if (!codexKey) return;
    const node = codexNodes.get(codexKey);
    if (!node) return;
    node.currentTool = payload ? { label: payload.label, state: payload.state || "active" } : null;
  },
  // phase 2.3 — claude 노드가 codex 가 띄운 자식인지 매핑. parent codex 노드와 bezier 연결.
  setClaudeParentCodex(sessionId, codexSessionId) {
    if (!sessionId) return;
    const node = claudeNodes.get(sessionId);
    if (!node) return;
    node.parentCodexSessionId = codexSessionId || null;
  },
  // Unit E: codex 노드의 say bubble (claude setSay 와 같은 패턴).
  setCodexSay(codexKey, textOrNull) {
    if (!codexKey) return;
    const node = codexNodes.get(codexKey);
    if (!node) return;
    node.say = textOrNull ? String(textOrNull) : null;
    if (!node.say) node.sayBox = null;
  },
  // Unit C: codex 의 particle 흐름 (function_call 시 user→codex, output 시 codex→user).
  emitCodexParticle(codexKey, kind, count) {
    if (!codexKey) return;
    emitParticles(kind, { codexKey, color: [0, 212, 255], count: count || 2 });
  },
  setCurrentTool(id, payload) {
    if (!id) return;
    if (!claudeNodes.has(id) && payload) {
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "working",
        label: "",
        approval: null,
        approvalBox: null,
        say: null,
        sayBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
    }
    if (!claudeNodes.has(id)) return;
    const node = claudeNodes.get(id);
    node.currentTool = payload ? { label: payload.label, state: payload.state || "active" } : null;
  },
  setNodeLabel(id, label) {
    if (!id) return;
    // race fix: applySessionLabelsToArt (sessions broadcast) 가 setSessionStatus (event) 보다
    // 먼저 도착하면 옛 코드는 노드 없어서 skip → 그 후 event 로 생성된 노드는 label="" 박혀서 라벨 사라짐.
    // 라벨이 비어 있는 호출 (idle/no-label) 은 그냥 skip — UUID prefix fallback 차단 정책 유지.
    if (!claudeNodes.has(id)) {
      if (!label) return;
      let ratio;
      if (savedPositions[id]) {
        ratio = { ratioX: savedPositions[id].ratioX, ratioY: savedPositions[id].ratioY };
      } else {
        ratio = findInitialPosition();
        saveNodePosition(id, ratio.ratioX, ratio.ratioY);
      }
      claudeNodes.set(id, {
        x: 0,
        y: 0,
        status: "idle",
        label,
        approval: null,
        approvalBox: null,
        say: null,
        sayBox: null,
        seedX: Math.random() * 1000,
        seedY: Math.random() * 1000,
        glowPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        draggedRatioX: ratio.ratioX,
        draggedRatioY: ratio.ratioY
      });
      return;
    }
    const node = claudeNodes.get(id);
    node.label = label || "";
  },
  syncNodes(activeIds) {
    const active = new Set(Array.isArray(activeIds) ? activeIds : []);
    for (const id of [...claudeNodes.keys()]) {
      if (!active.has(id)) claudeNodes.delete(id);
    }
  },
  setCodexUnits(units, opts = {}) {
    const seen = new Set();
    const now = nowMs();
    const preserveMissing = Boolean(opts.preserveMissing);

    (Array.isArray(units) ? units : []).forEach((unit) => {
      const name = unit.unit || unit.name || "unit";
      const task = unit.task || "codex";
      const codexSessionId = unit.codexSessionId || unit.codex_session_id || null;
      // codex 노드 redesign (plan v2): isRoot 면 root 노드 (parent=user). 키도 codexSessionId 기반.
      const isRoot = Boolean(unit.isRoot && codexSessionId);
      const key = isRoot ? `codex:${codexSessionId}` : `${task}:${name}`;
      const status = normalizeCodexStatus(unit.status);
      const parentSessionId = isRoot
        ? null
        : (unit.parentSessionId || unit.session_id || unit.sessionId || defaultParentSessionId());
      const storageKey = isRoot ? codexPositionKey(codexSessionId) : null;
      seen.add(key);

      const isNew = !codexNodes.has(key);
      // phase 2.1 fix: legacy poller 가 옛 done/error sentinel 들을 매 5s broadcast → fade 후 재생성
      // 무한 깜빡거림 차단. idle/running 노드는 정상 생성 (backfill 의 idle 도 통과).
      if (isNew && (status === "done" || status === "error")) return;
      if (isNew) {
        const saved = storageKey ? savedPositions[storageKey] : null;
        const ratio = saved
          ? { ratioX: saved.ratioX, ratioY: saved.ratioY }
          : isRoot ? findInitialCodexRootPosition() : null;
        if (storageKey && ratio) saveNodePosition(storageKey, ratio.ratioX, ratio.ratioY);
        codexNodes.set(key, {
          x: 0,
          y: 0,
          task,
          unit: name,
          label: unit.label || "",
          status,
          parentSessionId,
          codexSessionId,
          cwd: unit.cwd || null,
          isRoot,
          seedX: Math.random() * 1000,
          seedY: Math.random() * 1000,
          fadeStart: status === "running" ? null : now,
          pulsePhase: Math.random(),
          draggedRatioX: ratio?.ratioX,
          draggedRatioY: ratio?.ratioY
        });
      }

      const node = codexNodes.get(key);
      const prevStatus = node.status;
      node.task = task;
      node.unit = name;
      node.label = unit.label || node.label || "";
      node.parentSessionId = parentSessionId || node.parentSessionId || null;
      node.codexSessionId = codexSessionId || node.codexSessionId || null;
      node.cwd = unit.cwd || node.cwd || null;
      node.isRoot = isRoot;
      if (node.status === "running" && status !== "running" && !node.fadeStart) {
        node.fadeStart = now;
        if (node.isRoot && node.codexSessionId) {
          emitParticles("codex-to-user", { codexKey: key, color: [0, 212, 255], count: 3 });
        } else {
          // claude → codex 명령 완료 (running 끝) — codex 가 결과를 claude 로 돌려보냄
          emitParticles("codex-to-claude", { sessionId: node.parentSessionId, codexKey: key, color: [0, 212, 255], count: 2 });
        }
      }
      if (status === "running") node.fadeStart = null;
      node.status = status;

      // 새 running unit 또는 idle/done → running 전환
      if (status === "running" && (isNew || prevStatus !== "running")) {
        if (node.isRoot && node.codexSessionId) {
          emitParticles("user-to-codex", { codexKey: key, color: [255, 200, 70], count: 3 });
        } else {
          emitParticles("claude-to-codex", { sessionId: node.parentSessionId, codexKey: key, color: [0, 212, 255], count: 3 });
        }
      }
    });

    if (!preserveMissing) codexNodes.forEach((node, key) => {
      // root codex 는 prune skip — 영구 (5분 stale 후 server 가 session_end emit 박음).
      if (node.isRoot && node.codexSessionId) return;
      if (node.status === "running" && !seen.has(key)) {
        node.status = "done";
        node.fadeStart = now;
      }
    });

    updateConnections();
  },

  // WS hello replay 의 codexAgents snapshot 이 ground truth. 거기에 없는 root codex 노드는
  // server 가 이미 cleanup (endedAt grace 2분 지남) 한 stale 잔재 — done 박고 fade 시작.
  // handleCodexEvent 가 preserveMissing:true 라 단건 broadcast 로는 정리가 안 돼 server restart
  // 해야 사라지던 버그 (2026-05-28 cross-review-v1 사례) fix.
  pruneStaleRootCodexNodes(validCodexSids) {
    const validSet = validCodexSids instanceof Set ? validCodexSids : new Set(validCodexSids || []);
    const now = nowMs();
    codexNodes.forEach((node) => {
      if (!node.isRoot || !node.codexSessionId) return;
      if (validSet.has(node.codexSessionId)) return;
      if (node.status !== "done" && node.status !== "error") {
        node.status = "done";
        if (!node.fadeStart) node.fadeStart = now;
      }
    });
  }
};

if (container) new p5((p) => {
  sketch = p;

  p.setup = () => {
    const size = measuredContainerSize();
    const canvas = p.createCanvas(Math.max(1, size.width), Math.max(1, size.height));
    canvas.parent(container);
    p.frameRate(60);
    p.noStroke();
    p.textFont('-apple-system, BlinkMacSystemFont, "Inter", "Pretendard", "Noto Sans KR", "Helvetica Neue", Arial, sans-serif');
    p.background(10, 14, 26);
  };

  p.draw = () => {
    p.background(10, 14, 26);

    updateFloatingPositions(p);
    applyClaudeRepulsion(p);
    pruneCodexNodes(p);
    // drawClaudeNodes 가 먼저 — node.renderX/Y (drift 적용 위치) 를 set.
    // 이후 line 그리는 함수들이 그 값 사용 → 박스는 고정, line 만 노드 따라 흔들림.
    drawClaudeNodes(p);
    drawCodexNodes(p);
    drawConnections(p);
    drawSayBoxes(p);
    drawAskqBadges(p);
    drawApprovalBoxes(p);
    drawParticles(p);
  };

  // approval / bubble box hit 처리 — mousePressed 와 touchStarted 공통.
  // handled 면 true, 그 외 false.
  function handleNonDragTap(x, y) {
    // 안전망: HTML 승인/askq 모달이 떠 있는 동안엔 캔버스 hit-test 자체를 건너뜀.
    // p5 mousePressed 가드(event.target!=CANVAS)와 별개의 2차 방어선.
    if (isAnyModalOpen()) return false;
    const hitBox = (box) => box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

    // askq 배지 우선 — 모달 open 트리거
    for (const [id, node] of claudeNodes.entries()) {
      if (!node.askq || !node.askqBox) continue;
      if (hitBox(node.askqBox)) {
        window.observatoryOnAskqBoxClick?.(id);
        return true;
      }
    }

    for (const [id, node] of claudeNodes.entries()) {
      if (!node.approval || !node.approvalBox) continue;
      const box = node.approvalBox;
      if (!hitBox(box)) continue;
      if (!node.approval.expanded) {
        node.approval.expanded = true;
        return true;
      }
      if (box.buttons) {
        for (const btn of box.buttons) {
          if (hitBox(btn)) {
            window.observatoryOnApprovalButton?.(id, btn.action, btn.mode);
            return true;
          }
        }
      }
      return true;
    }

    // 어떤 박스도 hit 안 했고 expanded 인 approval 모달이 있으면 collapse (outside click).
    let collapsed = false;
    for (const [, node] of claudeNodes.entries()) {
      if (node.approval?.expanded) {
        node.approval.expanded = false;
        collapsed = true;
      }
    }
    if (collapsed) return true;

    return false;
  }

  function getDragNode() {
    if (!dragState) return null;
    return (dragState.nodeType === "codex" ? codexNodes : claudeNodes).get(dragState.nodeId);
  }

  p.mousePressed = (event) => {
    if (Date.now() < touchSynthBlockUntil) return false;
    // 모달 떠있으면 캔버스 입력 무조건 통과 (event 인자 없을 때도 안전).
    if (isAnyModalOpen()) return true;
    // p5 mousePressed 는 window 단위로 잡혀서 모달·헤더·cmd-bar 위 클릭도 들어옴.
    // 캔버스가 아닌 element 위 클릭이면 그 element 가 받아야 하니 true (preventDefault X).
    if (event?.target && event.target.tagName !== "CANVAS") return true;
    if (handleNonDragTap(p.mouseX, p.mouseY)) return false;
    for (const [id, node] of claudeNodes.entries()) {
      const dx = p.mouseX - node.x;
      const dy = p.mouseY - node.y;
      if (Math.sqrt(dx * dx + dy * dy) < 22) {
        dragState = { nodeType: "claude", nodeId: id, isDragging: false, startX: p.mouseX, startY: p.mouseY };
        return false;
      }
    }
    for (const [key, node] of codexNodes.entries()) {
      const dx = p.mouseX - node.x;
      const dy = p.mouseY - node.y;
      if (Math.sqrt(dx * dx + dy * dy) < 16) {
        dragState = { nodeType: "codex", nodeId: key, isDragging: false, startX: p.mouseX, startY: p.mouseY };
        return false;
      }
    }
    return true;
  };

  p.mouseDragged = () => {
    if (!dragState) return true;
    const dx = p.mouseX - dragState.startX;
    const dy = p.mouseY - dragState.startY;
    if (!dragState.isDragging && Math.sqrt(dx * dx + dy * dy) > 4) {
      dragState.isDragging = true;
    }
    if (dragState.isDragging) {
      const node = getDragNode();
      if (node) {
        const clampedX = Math.min(Math.max(p.mouseX, 24), p.width - 24);
        const clampedY = Math.min(Math.max(p.mouseY, 24), p.height - 24);
        node.draggedRatioX = clampedX / p.width;
        node.draggedRatioY = clampedY / p.height;
      }
    }
    return false;
  };

  p.mouseReleased = () => {
    if (!dragState) return true;
    if (!dragState.isDragging) {
      if (dragState.nodeType === "claude") {
        emitNodeClick(dragState.nodeId);
      } else if (dragState.nodeType === "codex") {
        // codex 노드 redesign (plan v2): root codex 만 click 의미 (tmux target 매칭). legacy 는 noop.
        const node = codexNodes.get(dragState.nodeId);
        if (node?.isRoot && node.codexSessionId) {
          // node.unit 이 tmux name 형식 (sentinel 매칭으로 박힌 경우) 이면 그게 target
          const target = node.unit && /^[A-Za-z0-9_.\-]+$/.test(node.unit) ? node.unit : null;
          emitCodexNodeClick(dragState.nodeId, target);
        }
      }
    } else if (dragState.nodeType === "claude") {
      claudeNodes.forEach((node, id) => {
        if (node.draggedRatioX !== undefined) {
          saveNodePosition(id, node.draggedRatioX, node.draggedRatioY);
        }
      });
    } else if (dragState.nodeType === "codex") {
      // root codex 의 drag 만 localStorage persist (legacy 는 ephemeral)
      const node = codexNodes.get(dragState.nodeId);
      const storageKey = node?.isRoot && node.codexSessionId ? codexPositionKey(node.codexSessionId) : null;
      if (storageKey && node.draggedRatioX !== undefined) {
        saveNodePosition(storageKey, node.draggedRatioX, node.draggedRatioY);
      }
    }
    dragState = null;
    return false;
  };

  // 모바일 long-press 드래그 — 350ms hold 후 활성, 그 전 큰 이동은 scroll 로 양보
  const LONG_PRESS_MS = 350;
  const LONG_PRESS_CANCEL_PX = 12;
  const NODE_HIT_RADIUS_TOUCH = 28;
  let touchSynthBlockUntil = 0;

  function makeLongPressTimer(idOrKey) {
    return setTimeout(() => {
      if (dragState && dragState.touchMode && dragState.nodeId === idOrKey) {
        dragState.isLongPress = true;
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }, LONG_PRESS_MS);
  }

  p.touchStarted = (event) => {
    if (!p.touches || p.touches.length !== 1) return true;
    // 모달 떠있으면 캔버스 노드 처리 무조건 건너뜀 (event 인자 없는 케이스도 안전).
    if (isAnyModalOpen()) return true;
    // mousePressed 와 동일 — 모달/UI 위 터치는 캔버스 노드로 처리 안 함.
    if (event?.target && event.target.tagName !== "CANVAS") return true;
    const t = p.touches[0];
    // 박스(approval/askq) hit-test 를 노드 hit-test 앞으로 — 모바일에서 박스 버튼이
    // 노드 위에 떠있을 때 노드 drag-hit 이 박스를 가로채던 버그 fix. mousePressed 와 동일 순서.
    if (handleNonDragTap(t.x, t.y)) return false;
    for (const [id, node] of claudeNodes.entries()) {
      const dx = t.x - node.x;
      const dy = t.y - node.y;
      if (Math.sqrt(dx * dx + dy * dy) < NODE_HIT_RADIUS_TOUCH) {
        dragState = {
          nodeType: "claude", nodeId: id, isDragging: false, isLongPress: false,
          startX: t.x, startY: t.y, touchMode: true,
          longPressTimer: makeLongPressTimer(id)
        };
        return false;
      }
    }
    for (const [key, node] of codexNodes.entries()) {
      const dx = t.x - node.x;
      const dy = t.y - node.y;
      if (Math.sqrt(dx * dx + dy * dy) < 22) {
        dragState = {
          nodeType: "codex", nodeId: key, isDragging: false, isLongPress: false,
          startX: t.x, startY: t.y, touchMode: true,
          longPressTimer: makeLongPressTimer(key)
        };
        return false;
      }
    }
    return true;
  };

  p.touchMoved = () => {
    if (!dragState || !dragState.touchMode) return true;
    if (!p.touches || p.touches.length !== 1) return true;
    const t = p.touches[0];
    const dx = t.x - dragState.startX;
    const dy = t.y - dragState.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!dragState.isLongPress) {
      if (dist > LONG_PRESS_CANCEL_PX) {
        clearTimeout(dragState.longPressTimer);
        dragState = null;
        return true;
      }
      return false;
    }
    dragState.isDragging = true;
    const node = getDragNode();
    if (node) {
      const clampedX = Math.min(Math.max(t.x, 24), p.width - 24);
      const clampedY = Math.min(Math.max(t.y, 24), p.height - 24);
      node.draggedRatioX = clampedX / p.width;
      node.draggedRatioY = clampedY / p.height;
    }
    return false;
  };

  p.touchEnded = () => {
    if (!dragState || !dragState.touchMode) return true;
    clearTimeout(dragState.longPressTimer);
    if (dragState.isDragging && dragState.nodeType === "claude") {
      claudeNodes.forEach((node, id) => {
        if (node.draggedRatioX !== undefined) {
          saveNodePosition(id, node.draggedRatioX, node.draggedRatioY);
        }
      });
    } else if (dragState.isDragging && dragState.nodeType === "codex") {
      // root codex 만 localStorage persist
      const node = codexNodes.get(dragState.nodeId);
      const storageKey = node?.isRoot && node.codexSessionId ? codexPositionKey(node.codexSessionId) : null;
      if (storageKey && node.draggedRatioX !== undefined) {
        saveNodePosition(storageKey, node.draggedRatioX, node.draggedRatioY);
      }
    } else if (!dragState.isDragging && !dragState.isLongPress) {
      if (dragState.nodeType === "claude") {
        emitNodeClick(dragState.nodeId);
      } else if (dragState.nodeType === "codex") {
        const node = codexNodes.get(dragState.nodeId);
        if (node?.isRoot && node.codexSessionId) {
          const target = node.unit && /^[A-Za-z0-9_.\-]+$/.test(node.unit) ? node.unit : null;
          emitCodexNodeClick(dragState.nodeId, target);
        }
      }
    }
    // legacy codex 의 draggedRatio 는 in-memory 만
    dragState = null;
    touchSynthBlockUntil = Date.now() + 400;
    return false;
  };

  p.windowResized = () => {
    window.mainViewBus.resize();
  };

}, container);

if (container && "ResizeObserver" in window) {
  new ResizeObserver(() => window.mainViewBus.resize()).observe(container);
}

function resizeArtCanvas() {
  const p = sketch;
  if (!p) return;
  const size = measuredContainerSize();
  if (size.width === 0 || size.height === 0) return;
  p.resizeCanvas(size.width, size.height);
  p.background(10, 14, 26);
  updateFloatingPositions(p);
  updateConnections();
}

function measuredContainerSize() {
  if (!container) return { width: 0, height: 0 };
  return {
    width: container.clientWidth,
    height: container.clientHeight
  };
}

function updateFloatingPositions(p) {
  // 3단 분할 (세로) — user 상단 (좁음), claude 중간, codex 하단.
  // 가로는 영역 전체 폭 사용. claude/codex 노드들은 x 축으로 분배.
  const claude = { x1: p.width * 0.06, x2: p.width * 0.94, y1: p.height * 0.14, y2: p.height * 0.46 };
  const codex  = { x1: p.width * 0.04, x2: p.width * 0.96, y1: p.height * 0.55, y2: p.height * 0.95 };
  const wobble = 6;
  const t = p.frameCount * 0.0008;

  const claudeArr = [...claudeNodes.entries()];
  const claudeN = Math.max(1, claudeArr.length);
  const claudeSliceW = (claude.x2 - claude.x1) / claudeN;
  claudeArr.forEach(([, node], idx) => {
    if (node.baseRatioX === undefined) {
      node.baseRatioX = p.noise(node.seedX);
      node.baseRatioY = p.noise(node.seedY + 100);
    }
    let baseX;
    let baseY;
    if (node.draggedRatioX !== undefined) {
      baseX = node.draggedRatioX * p.width;
      baseY = node.draggedRatioY * p.height;
    } else {
      const sliceX1 = claude.x1 + idx * claudeSliceW;
      const sliceX2 = sliceX1 + claudeSliceW;
      baseX = p.lerp(sliceX1 + 24, sliceX2 - 24, node.baseRatioX);
      baseY = p.lerp(claude.y1 + 10, claude.y2 - 10, node.baseRatioY);
    }
    if (node.status === "working") {
      node.x = baseX + wobble * Math.sin(t + node.seedX * 0.1);
      node.y = baseY + wobble * Math.cos(t + node.seedY * 0.1);
    } else {
      node.x = baseX;
      node.y = baseY;
    }
  });

  // codex 배치 — 같은 parent (Claude 노드) 의 codex 들은 parent 주변 cluster (각도 분배).
  // parent 없으면 우측 column fallback. 사용자 drag 으로 위치 override 가능.
  const codexArr = [...codexNodes.entries()];
  const parentToCodex = new Map();
  codexArr.forEach(([key, node]) => {
    const pid = node.parentSessionId;
    if (!parentToCodex.has(pid)) parentToCodex.set(pid, []);
    parentToCodex.get(pid).push(key);
  });

  codexArr.forEach(([key, node]) => {
    if (node.baseRatioX === undefined) {
      node.baseRatioX = p.noise(node.seedX + 200);
      node.baseRatioY = p.noise(node.seedY + 300);
    }

    let baseX;
    let baseY;
    if (node.draggedRatioX !== undefined) {
      baseX = node.draggedRatioX * p.width;
      baseY = node.draggedRatioY * p.height;
    } else {
      const parent = claudeNodes.get(node.parentSessionId);
      if (parent) {
        // cluster: 하단 codex 영역 안에서 parent.x 주위로 가로 spread + 세로 row 배치.
        const siblings = parentToCodex.get(node.parentSessionId) || [key];
        const idx = siblings.indexOf(key);
        const count = Math.max(1, siblings.length);
        const cols = Math.min(count, 3);
        const rows = Math.ceil(count / cols);
        const colIdx = idx % cols;
        const rowIdx = Math.floor(idx / cols);
        const spreadX = 36;
        const rowH = (codex.y2 - codex.y1 - 20) / Math.max(1, rows);
        baseX = parent.x + (colIdx - (cols - 1) / 2) * spreadX;
        baseY = codex.y1 + 12 + rowIdx * rowH + rowH / 2;
        // 클램프 — codex 영역 안에 머물게
        baseX = Math.min(Math.max(baseX, codex.x1 + 20), codex.x2 - 20);
      } else {
        // fallback: 우측 column random
        const idx = codexArr.findIndex(([k]) => k === key);
        const codexSlice = (codex.y2 - codex.y1) / Math.max(1, codexArr.length);
        const sliceY1 = codex.y1 + idx * codexSlice;
        const sliceY2 = sliceY1 + codexSlice;
        baseX = p.lerp(codex.x1, codex.x2, node.baseRatioX);
        baseY = p.lerp(sliceY1 + 8, sliceY2 - 8, node.baseRatioY);
      }
    }

    if (node.status === "running") {
      node.x = baseX + wobble * Math.sin(t + node.seedX * 0.1);
      node.y = baseY + wobble * Math.cos(t + node.seedY * 0.1);
    } else {
      node.x = baseX;
      node.y = baseY;
    }
  });
}

function applyClaudeRepulsion(p) {
  if (!dragState || !dragState.isDragging) return;
  const minDist = 60;
  const nodes = [...claudeNodes.entries()];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [idA, a] = nodes[i];
      const [idB, b] = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= minDist || dist === 0) continue;
      const overlap = minDist - dist;
      const ax = dx / dist;
      const ay = dy / dist;
      const isADrag = dragState && dragState.isDragging && dragState.nodeId === idA;
      const isBDrag = dragState && dragState.isDragging && dragState.nodeId === idB;
      if (isADrag && !isBDrag) {
        pushClaude(b, ax * overlap, ay * overlap, p);
      } else if (isBDrag && !isADrag) {
        pushClaude(a, -ax * overlap, -ay * overlap, p);
      } else {
        const half = overlap / 2;
        pushClaude(a, -ax * half, -ay * half, p);
        pushClaude(b, ax * half, ay * half, p);
      }
    }
  }
}

function pushClaude(node, dx, dy, p) {
  const newX = Math.min(Math.max(node.x + dx, 24), p.width - 24);
  const newY = Math.min(Math.max(node.y + dy, 24), p.height - 24);
  node.x = newX;
  node.y = newY;
  node.draggedRatioX = newX / p.width;
  node.draggedRatioY = newY / p.height;
}

function updateConnections() {
  connections = [...codexNodes.entries()]
    .filter(([, node]) => node.status === "running" && node.parentSessionId && claudeNodes.has(node.parentSessionId))
    .map(([key, node]) => ({ from: node.parentSessionId, to: key, pulsePhase: Math.random() }));
}

function defaultParentSessionId() {
  return claudeNodes.keys().next().value || null;
}

function pruneCodexNodes(p) {
  let changed = false;
  codexNodes.forEach((node, key) => {
    // root codex is persistent while active/idle, but session_end should still fade it out.
    if (node.isRoot && node.codexSessionId && node.status !== "done" && node.status !== "error") return;
    if (node.status === "running" || !node.fadeStart) return;
    const duration = node.status === "error" ? 4000 : 2000;
    if (p.millis() - node.fadeStart > duration) {
      codexNodes.delete(key);
      changed = true;
    }
  });
  if (changed) {
    updateConnections();
  }
}

// Bezier control points helper — 모든 연결이 같은 곡률 사용
function bezierControls(fromX, fromY, toX, toY) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const bend = Math.max(40, Math.abs(dy) * 0.35);
  return {
    c1x: fromX + dx * 0.25,
    c1y: fromY + (dy >= 0 ? bend : -bend),
    c2x: fromX + dx * 0.75,
    c2y: toY - (dy >= 0 ? bend : -bend)
  };
}

// node 의 line 시작/도착점 — drift 적용된 위치 (없으면 base 좌표).
function nodeAnchor(node) {
  return {
    x: node.renderX !== undefined ? node.renderX : node.x,
    y: node.renderY !== undefined ? node.renderY : node.y
  };
}

function drawConnections(p) {
  // 1) user ↔ claude 정적 line — 초록 (codex cyan line 과 톤 대칭).
  //    working/awaiting = 활성 (70 alpha), idle/error 등 = 옅음 (38 alpha).
  //    pulse 는 event 발생 시 particle (lightning arc) 가 emit.
  const user = leftAnchor(p);
  p.noFill();
  p.strokeWeight(1);
  claudeNodes.forEach((node) => {
    if (node.parentCodexSessionId && codexNodes.has(`codex:${node.parentCodexSessionId}`)) return;
    const a = nodeAnchor(node);
    const c = bezierControls(user.x, user.y, a.x, a.y);
    const active = node.status === "working" || node.status === "awaiting";
    p.stroke(126, 231, 135, active ? 70 : 38);
    p.bezier(user.x, user.y, c.c1x, c.c1y, c.c2x, c.c2y, a.x, a.y);
  });

  // 2) user ↔ root codex bezier (plan v2): cyan running 70 alpha / 비활성 38.
  codexNodes.forEach((node) => {
    if (!node.isRoot || !node.codexSessionId) return;
    const c = bezierControls(user.x, user.y, node.x, node.y);
    p.stroke(0, 212, 255, node.status === "running" ? 70 : 38);
    p.bezier(user.x, user.y, c.c1x, c.c1y, c.c2x, c.c2y, node.x, node.y);
  });

  // 3) claude ↔ codex 정적 line (subtle, legacy) — pulse 없음
  connections.forEach((connection) => {
    const from = claudeNodes.get(connection.from);
    const to = codexNodes.get(connection.to);
    if (!from || !to) return;
    const fa = nodeAnchor(from);
    const c = bezierControls(fa.x, fa.y, to.x, to.y);
    p.stroke(180, 195, 215, 55);
    p.bezier(fa.x, fa.y, c.c1x, c.c1y, c.c2x, c.c2y, to.x, to.y);
  });

  // 4) phase 2.3 — codex → claude 자식 bezier. claude.parentCodexSessionId 박혀있고 그 codex 노드 살아있으면.
  claudeNodes.forEach((claudeNode) => {
    if (!claudeNode.parentCodexSessionId) return;
    const codexKey = `codex:${claudeNode.parentCodexSessionId}`;
    const codexNode = codexNodes.get(codexKey);
    if (!codexNode) return;
    const ca = nodeAnchor(codexNode);
    const cl = nodeAnchor(claudeNode);
    const c = bezierControls(ca.x, ca.y, cl.x, cl.y);
    // codex 의 cyan 톤 + 약간 옅게 (claude 자체 색과 구분)
    p.stroke(0, 200, 240, 55);
    p.bezier(ca.x, ca.y, c.c1x, c.c1y, c.c2x, c.c2y, cl.x, cl.y);
  });
  p.noStroke();
}

function drawClaudeNodes(p) {
  claudeNodes.forEach((node, id) => {
    const elapsed = p.millis();
    let x = node.x;
    let y = node.y;
    let alpha = 230;
    let glowRadius = 22;
    // claude idle = 연초록 (codex idle 연파랑과 시각 구분)
    const color = node.status === "idle"
      ? colors.idleClaude
      : (colors[node.status] || colors.working);
    const selected = id === selectedSessionId;

    if (node.status === "working") {
      const drift = Math.sin(elapsed / 700 + node.driftPhase) * 4;
      x += drift;
      y += Math.cos(elapsed / 900 + node.driftPhase) * 4;
      alpha = 178 + Math.sin(elapsed / 1000 + node.glowPhase) * 38;
      glowRadius = 18;
    }
    // line 시작점 동기화 — 박스 위치는 node.x/y, line 끝점만 drift 적용된 x/y.
    node.renderX = x;
    node.renderY = y;

    if (node.status === "idle") {
      glowRadius = 16 + Math.sin(elapsed / 1500 + node.glowPhase) * 4;
      alpha = 230;
    } else if (node.status === "awaiting") {
      alpha = 76 + ((Math.sin(elapsed / 300 + node.glowPhase) + 1) / 2) * 179;
      glowRadius = 25;
    } else if (node.status === "error") {
      alpha = 215 + Math.sin(elapsed / 600 + node.glowPhase) * 35;
      glowRadius = 24 + Math.sin(elapsed / 700 + node.glowPhase) * 8;
    }

    const sizeMul = selected ? 1.5 : 1;
    // working 노드 = 작업 중. 진짜 빛 발산하는 듯한 intense glow.
    if (node.status === "working") {
      drawIntenseGlow(p, x, y, color, glowRadius * sizeMul, alpha);
    } else {
      drawGlow(p, x, y, color, glowRadius * sizeMul, alpha);
    }
    p.fill(colorWithAlpha(color, alpha));
    p.circle(x, y, 13 * sizeMul);

    if (selected) {
      p.noFill();
      p.stroke(255, 255, 255, 200);
      p.strokeWeight(1.5);
      p.circle(x, y, 13 * sizeMul + 10);
      p.noStroke();
      p.fill(255, 255, 255, 230);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(14);
      p.text("▼", x, y - 13 * sizeMul - 10);
    }

    p.fill(240, 240, 240, 190);
    p.textAlign(p.LEFT, p.CENTER);
    p.textSize(12);
    p.text(node.label, x + 16, y);

    // 현재상황 요약 박스 — 노드 아래 단순 dark glass (꼬리 없음).
    if (node.currentTool && node.currentTool.label) {
      const fading = node.currentTool.state === "fading";
      const alpha = fading ? 150 : 240;

      p.textSize(11);
      const padX = 10;
      const labelW = p.textWidth(node.currentTool.label);
      const bubbleW = Math.min(280, labelW + padX * 2);
      const bubbleH = 22;
      const nodeR = (13 * sizeMul) / 2;

      const bx = x - bubbleW / 2;
      const by = y + nodeR + 10;

      drawAppleSurface(p, bx, by, bubbleW, bubbleH, 11, alpha);

      // 텍스트 + ellipsize
      p.noStroke();
      p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], alpha);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(11);
      let displayLabel = node.currentTool.label;
      if (labelW > bubbleW - padX * 2) {
        while (displayLabel.length > 2 && p.textWidth(`${displayLabel}…`) > bubbleW - padX * 2) {
          displayLabel = displayLabel.slice(0, -1);
        }
        displayLabel = `${displayLabel}…`;
      }
      p.text(displayLabel, bx + bubbleW / 2, by + bubbleH / 2);
    }
  });
}

function drawCodexNodes(p) {
  codexNodes.forEach((node, key) => {
    const alpha = codexAlpha(p, node);
    if (alpha <= 0) return;
    // root codex (plan v2): running cyan / idle 흰색 (claude idle 처럼) / done grey.
    // legacy: 옛 working/error/codex 매핑.
    const isRootCodex = node.isRoot && node.codexSessionId;
    let color;
    if (isRootCodex) {
      if (node.status === "running") color = colors.codex;
      else if (node.status === "idle") color = colors.idleCodex; // 연파랑 (claude idle 연초록과 구분)
      else color = "#8a929e";
    } else {
      color = node.status === "error" ? colors.error : node.status === "done" ? colors.working : colors.codex;
    }
    const drift = node.status === "running" ? Math.sin(p.millis() / 900 + node.pulsePhase) * 3 : 0;
    const x = node.x + drift;
    const y = node.y;
    // selection 효과 (claude 와 동일 패턴): sizeMul 1.5 + 흰 outer ring + ▼ 마커.
    const selected = key === selectedCodexKey;
    const baseSize = isRootCodex ? 13 : 10;
    const baseGlow = isRootCodex ? 22 : 18;
    const sizeMul = selected ? 1.5 : 1;

    // running root codex = 작업 중. intense glow.
    if (isRootCodex && node.status === "running") {
      drawIntenseGlow(p, x, y, color, baseGlow * sizeMul, alpha * 0.85);
    } else {
      drawGlow(p, x, y, color, baseGlow * sizeMul, alpha * 0.65);
    }
    p.fill(colorWithAlpha(color, alpha));
    p.circle(x, y, baseSize * sizeMul);

    if (selected) {
      p.noFill();
      p.stroke(255, 255, 255, 200);
      p.strokeWeight(1.5);
      p.circle(x, y, baseSize * sizeMul + 10);
      p.noStroke();
      p.fill(255, 255, 255, 230);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(14);
      p.text("▼", x, y - baseSize * sizeMul - 10);
    }

    // label: task prefix 제거 (사용자 요청). node.label 우선, fallback node.unit.
    p.fill(colorWithAlpha("#f0f0f0", alpha));
    p.textAlign(p.LEFT, p.CENTER);
    p.textSize(11);
    p.text(node.label || node.unit || "", x + 14 * sizeMul, y);

    // Unit B: currentTool 박스 (claude drawClaudeNodes 와 같은 패턴).
    if (node.currentTool && node.currentTool.label) {
      const fading = node.currentTool.state === "fading";
      const toolAlpha = fading ? 150 : 240;
      p.textSize(11);
      const padX = 10;
      const labelW = p.textWidth(node.currentTool.label);
      const bubbleW = Math.min(280, labelW + padX * 2);
      const bubbleH = 22;
      const nodeR = (baseSize * sizeMul) / 2;
      const bx = x - bubbleW / 2;
      const by = y + nodeR + 10;
      drawAppleSurface(p, bx, by, bubbleW, bubbleH, 11, toolAlpha);
      p.noStroke();
      p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], toolAlpha);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(11);
      let displayLabel = node.currentTool.label;
      if (labelW > bubbleW - padX * 2) {
        while (displayLabel.length > 2 && p.textWidth(`${displayLabel}…`) > bubbleW - padX * 2) {
          displayLabel = displayLabel.slice(0, -1);
        }
        displayLabel = `${displayLabel}…`;
      }
      p.text(displayLabel, bx + bubbleW / 2, by + bubbleH / 2);
    }
  });
}

function codexAlpha(p, node) {
  // root codex stays solid while active/idle; completed roots fade out like child units.
  if (node.isRoot && node.codexSessionId && node.status !== "done" && node.status !== "error") return 230;
  if (node.status === "running" || !node.fadeStart) return 230;
  const duration = node.status === "error" ? 4000 : 2000;
  const progress = Math.min(1, (p.millis() - node.fadeStart) / duration);
  return 230 * (1 - progress);
}

function wrapSayText(p, text, maxWidth) {
  // 영문은 word wrap, 한국어는 단어 한 토큰이라 maxWidth 초과 시 char 단위로 분해 폴백.
  const tokens = text.split(/(\s+)/);
  const lines = [];
  let current = "";
  for (const tok of tokens) {
    if (tok === "") continue;
    const test = current + tok;
    if (p.textWidth(test) <= maxWidth) {
      current = test;
      continue;
    }
    if (current) lines.push(current);
    if (p.textWidth(tok) <= maxWidth) {
      current = tok;
      continue;
    }
    let chunk = "";
    for (const ch of tok) {
      if (p.textWidth(chunk + ch) > maxWidth) {
        if (chunk) lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  }
  if (current && current.trim().length > 0) lines.push(current);
  return lines;
}

function drawSayBoxes(p) {
  const MAX_W = 320;
  const MAX_LINES = 5;
  const PAD = 10;
  const LINE_H = 16;
  const GAP_FROM_NODE = 32;
  const RADIUS = 13;

  p.push();
  p.textSize(12);
  p.textAlign(p.LEFT, p.TOP);
  p.textStyle(p.NORMAL);

  const allSayNodes = [...claudeNodes.values(), ...codexNodes.values()];
  allSayNodes.forEach((node) => {
    if (!node.say) {
      node.sayBox = null;
      return;
    }
    // bubble (approval) 활성이면 사라지지 않게 두되 그 위로 안 덮이게 — bubble 옆이라 위치만 분리.
    const cleanText = node.say.replace(/\s+/g, " ").trim();
    if (!cleanText) {
      node.sayBox = null;
      return;
    }
    let lines = wrapSayText(p, cleanText, MAX_W - PAD * 2);
    let truncated = false;
    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      truncated = true;
    }
    if (truncated) {
      const last = lines[lines.length - 1];
      // 마지막 줄에 ellipsis 추가하되 너비 보장
      let trimmed = last;
      while (p.textWidth(trimmed + "…") > MAX_W - PAD * 2 && trimmed.length > 0) {
        trimmed = trimmed.slice(0, -1);
      }
      lines[lines.length - 1] = trimmed + "…";
    }

    let actualW = 0;
    for (const l of lines) actualW = Math.max(actualW, p.textWidth(l));
    const w = Math.min(MAX_W, Math.max(160, Math.ceil(actualW) + PAD * 2));
    const h = PAD * 2 + lines.length * LINE_H;

    // 노드 아래 우선, 화면 하단 넘으면 위로 flip
    const belowY = node.y + RADIUS + GAP_FROM_NODE;
    const aboveY = node.y - RADIUS - GAP_FROM_NODE - h;
    let y = belowY;
    if (y + h > p.height - 8) y = aboveY;
    if (y < 8) y = belowY;

    let x = node.x - w / 2;
    if (x < 8) x = 8;
    if (x + w > p.width - 8) x = p.width - 8 - w;

    node.sayBox = { x, y, w, h };

    // 노드 ↔ 박스 연결선 끝점 — 박스 노드쪽 변 가운데 (x clamp)
    const isBelowNode = (y === belowY);
    const lineToX = Math.max(x + 14, Math.min(x + w - 14, node.x));
    const lineToY = isBelowNode ? y : y + h;

    // glow on — 박스 fill + 연결선 둘 다 dark blue halo
    const ctx = p.drawingContext;
    const prevBlur = ctx.shadowBlur;
    const prevColor = ctx.shadowColor;
    ctx.shadowBlur = 16;
    ctx.shadowColor = "rgba(50, 95, 200, 0.55)";

    // 박스 surface
    p.noStroke();
    p.fill(APPLE.surface[0], APPLE.surface[1], APPLE.surface[2], 245);
    p.rect(x, y, w, h, 12);

    // 연결선 — 박스 테두리와 동일 색·두께·glow. 시작점은 node 의 drift 적용 위치.
    const na = nodeAnchor(node);
    p.stroke(70, 120, 220, 200);
    p.strokeWeight(1.5);
    p.noFill();
    p.line(na.x, na.y, lineToX, lineToY);

    // glow off — 이후 border + 텍스트는 깔끔
    ctx.shadowBlur = prevBlur;
    ctx.shadowColor = prevColor;

    // 박스 테두리 — line 과 동일 stroke
    p.stroke(70, 120, 220, 200);
    p.strokeWeight(1.5);
    p.noFill();
    p.rect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, 12);
    p.noStroke();

    // 텍스트
    p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], 245);
    lines.forEach((line, i) => {
      p.text(line, x + PAD, y + PAD + i * LINE_H);
    });
  });

  p.pop();
}

function drawAskqBadges(p) {
  const PAD_X = 12;
  const RADIUS = 13;
  const GAP_X = 14;
  const MIN_W = 88;
  const H = 28;

  p.push();
  p.textSize(13);
  p.textStyle(p.BOLD);

  claudeNodes.forEach((node) => {
    if (!node.askq) {
      node.askqBox = null;
      return;
    }
    const label = node.askq.count > 1 ? `${node.askq.count}개 질문` : `답해줘`;
    const tw = p.textWidth(label);
    const w = Math.max(MIN_W, Math.ceil(tw) + PAD_X * 2);

    // 노드 우상단 — viewport 넘으면 좌상단으로
    let x = node.x + RADIUS + GAP_X;
    if (x + w > p.width - 8) x = node.x - RADIUS - GAP_X - w;
    let y = node.y - RADIUS - H - 4;
    if (y < 8) y = node.y + RADIUS + 4;

    node.askqBox = { x, y, w, h: H };

    // 노드 ↔ 박스 연결점 — 박스의 노드쪽 변 가운데
    const lineToX = (node.x < x) ? x : (node.x > x + w) ? x + w : Math.max(x + 12, Math.min(x + w - 12, node.x));
    const lineToY = (node.y < y) ? y : (node.y > y + H) ? y + H : node.y;

    // 응답박스와 같은 dark glass surface
    drawAppleSurface(p, x, y, w, H, 14, 245);

    // 연결선 + 박스 테두리 — 같은 warm orange (꼬리 대신 line)
    const na = nodeAnchor(node);
    p.stroke(255, 110, 50, 220);
    p.strokeWeight(1.5);
    p.noFill();
    p.line(na.x, na.y, lineToX, lineToY);
    p.rect(x + 0.75, y + 0.75, w - 1.5, H - 1.5, 14);

    p.noStroke();
    p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], 255);
    p.textAlign(p.CENTER, p.CENTER);
    p.textSize(13);
    p.textStyle(p.BOLD);
    p.text(label, x + w / 2, y + H / 2);
  });

  p.textStyle(p.NORMAL);
  p.pop();
}

function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

// Spring-like easing — 살짝 overshoot 후 settle. 쫀득한 expand transition 용.
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Apple SF 시스템 색 — 모달·버튼 통일 팔레트
const APPLE = {
  surface: [28, 28, 30],          // dark glass 배경
  surfaceTop: [44, 44, 46],       // 살짝 밝은 surface (border 효과)
  border: [255, 255, 255, 28],    // 1px subtle border
  text: [235, 235, 245],          // primary text (light)
  subtext: [174, 174, 178],       // secondary text
  blue: [0, 122, 255],            // primary action
  green: [52, 199, 89],           // allow / safe
  red: [255, 69, 58],             // deny / destructive
  gray: [99, 99, 102],            // cancel / neutral
  shadow: [0, 0, 0, 110]
};

// Apple 스타일 버튼 — flat, rounded 10, 흰 텍스트, hover 효과는 alpha 로
function drawAppleButton(p, box, label, kind, alpha = 255) {
  const palette = {
    allow: APPLE.green,
    deny: APPLE.red,
    cancel: APPLE.gray,
    primary: APPLE.blue,
    danger: APPLE.red,
    safe: APPLE.green
  };
  const bg = palette[kind] || APPLE.blue;
  p.noStroke();
  p.fill(bg[0], bg[1], bg[2], alpha);
  p.rect(box.x, box.y, box.w, box.h, 10);
  p.fill(255, 255, 255, alpha);
  p.textAlign(p.CENTER, p.CENTER);
  p.textStyle(p.BOLD);
  p.textSize(13);
  p.text(label, box.x + box.w / 2, box.y + box.h / 2);
  p.textStyle(p.NORMAL);
}

// Apple 스타일 dark glass 컨테이너 — surface + subtle border + 둥근 모서리
function drawAppleSurface(p, x, y, w, h, radius, alpha = 255) {
  // soft shadow
  p.noStroke();
  p.fill(APPLE.shadow[0], APPLE.shadow[1], APPLE.shadow[2], Math.min(APPLE.shadow[3], alpha * 0.5));
  p.rect(x + 2, y + 6, w, h, radius);
  // surface
  p.fill(APPLE.surface[0], APPLE.surface[1], APPLE.surface[2], alpha);
  p.rect(x, y, w, h, radius);
  // 1px hairline border
  p.noFill();
  p.strokeWeight(1);
  p.stroke(APPLE.border[0], APPLE.border[1], APPLE.border[2], Math.min(APPLE.border[3], alpha));
  p.rect(x + 0.5, y + 0.5, w - 1, h - 1, radius);
  p.noStroke();
}

function drawApprovalBoxes(p) {
  p.rectMode(p.CORNER);
  const margin = 8;
  const topReserved = 70; // cmd-send (user 노드 버튼) 영역 침범 방지
  const nodeR = 13;
  const gap = 18;

  claudeNodes.forEach((node, id) => {
    if (!node.approval) {
      node.approvalBox = null;
      return;
    }

    // expand animation — expanded true 이면 expandT 증가, false 면 감소.
    // easeOutBack 으로 spring-like 쫀득함.
    if (node.approval._expandT === undefined) node.approval._expandT = 0;
    const target = node.approval.expanded ? 1 : 0;
    if (node.approval._expandT < target) {
      node.approval._expandT = Math.min(target, node.approval._expandT + 0.10);
    } else if (node.approval._expandT > target) {
      node.approval._expandT = Math.max(target, node.approval._expandT - 0.10);
    }
    const tRaw = node.approval._expandT;
    const t = node.approval.expanded ? easeOutBack(tRaw) : easeOut(tRaw);

    // "approve?" (4자 BOLD 13px) 에 맞춘 작은 박스. 모바일 tap 최소 ~28px 높이.
    const smallW = 88, smallH = 28;
    // 모바일 viewport 에 맞게 compact 한 expanded modal.
    const largeW = 264, largeH = 138;
    const w = smallW + (largeW - smallW) * t;
    const h = smallH + (largeH - smallH) * t;

    // 4 방향 후보 — viewport 안 fit 우선
    const candidates = [
      { x: node.x + nodeR + gap, y: node.y - h / 2, side: "left" },
      { x: node.x - nodeR - gap - w, y: node.y - h / 2, side: "right" },
      { x: node.x - w / 2, y: node.y + nodeR + gap, side: "top" },
      { x: node.x - w / 2, y: node.y - nodeR - gap - h, side: "bottom" }
    ];
    let chosen = null;
    // 1순위: viewport 안 정확히 fit 하는 방향. 위쪽은 cmd-send 영역 침범 방지.
    for (const c of candidates) {
      if (c.x >= margin && c.x + w <= p.width - margin &&
          c.y >= topReserved && c.y + h <= p.height - margin) {
        chosen = c; break;
      }
    }
    // 2순위: 공간 가장 큰 후보 + viewport 안 강제 clamp
    if (!chosen) {
      const spaces = [
        { c: candidates[0], space: p.width - node.x - nodeR - gap },
        { c: candidates[1], space: node.x - nodeR - gap },
        { c: candidates[2], space: p.height - node.y - nodeR - gap },
        { c: candidates[3], space: node.y - nodeR - gap }
      ];
      spaces.sort((a, b) => b.space - a.space);
      chosen = spaces[0].c;
      // viewport 안 strict clamp. top 은 cmd-send 영역 보호.
      chosen.x = Math.max(margin, Math.min(p.width - margin - w, chosen.x));
      chosen.y = Math.max(topReserved, Math.min(p.height - margin - h, chosen.y));
    }
    const { x, y, side } = chosen;

    // 박스 노드 쪽 면 중간점 (선 연결점)
    let lineToX, lineToY;
    if (side === "left") { lineToX = x; lineToY = y + h / 2; }
    else if (side === "right") { lineToX = x + w; lineToY = y + h / 2; }
    else if (side === "top") { lineToX = x + w / 2; lineToY = y; }
    else { lineToX = x + w / 2; lineToY = y + h; }

    // Apple dark glass surface
    drawAppleSurface(p, x, y, w, h, 14, 245);

    // 노드 ↔ 박스 연결선 + accent 테두리 — 같은 색·두께.
    // awaiting 시 SF Yellow, 아닐 때 흰 hairline 강조 톤. 시작점은 drift 적용 위치.
    const isAwaiting = node.status === "awaiting";
    const accentRgba = isAwaiting ? [255, 204, 0, 200] : [255, 255, 255, 120];
    const na = nodeAnchor(node);
    p.stroke(accentRgba[0], accentRgba[1], accentRgba[2], accentRgba[3]);
    p.strokeWeight(1.5);
    p.noFill();
    p.line(na.x, na.y, lineToX, lineToY);
    p.rect(x + 1.5, y + 1.5, w - 3, h - 3, 13);
    p.noStroke();

    const tRaw01 = Math.min(1, Math.max(0, tRaw));
    const smallAlpha = Math.max(0, 1 - tRaw01 * 2) * 255;
    const largeAlpha = Math.max(0, tRaw01 * 2 - 1) * 255;

    // ExitPlanMode = plan 종료 승인. 일반 tool 승인과 의미가 달라 라벨/버튼을 분기.
    const isPlanExit = node.approval.tool_name === "ExitPlanMode";

    // collapsed 라벨 — cross-fade out. "approve?" 톤으로 친근하게.
    if (smallAlpha > 5) {
      p.noStroke();
      p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], smallAlpha);
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(p.BOLD);
      p.textSize(13);
      p.text(isPlanExit ? "run?" : "approve?", x + smallW / 2, y + smallH / 2);
      p.textStyle(p.NORMAL);
    }

    let buttons = null;

    // expanded modal 내용 — cross-fade in
    if (largeAlpha > 5) {
      p.noStroke();
      p.fill(APPLE.text[0], APPLE.text[1], APPLE.text[2], largeAlpha);
      p.textAlign(p.LEFT, p.TOP);
      p.textStyle(p.BOLD);
      p.textSize(15);
      p.text(node.approval.tool_name || "tool", x + 14, y + 10);
      p.textStyle(p.NORMAL);
      p.textSize(11);
      p.fill(APPLE.subtext[0], APPLE.subtext[1], APPLE.subtext[2], largeAlpha);
      const inputStr = typeof node.approval.tool_input === "string"
        ? node.approval.tool_input
        : JSON.stringify(node.approval.tool_input || {}).slice(0, 120);
      wrapText(p, inputStr, x + 14, y + 32, w - 28, 13, 3);

      const padX = 12;
      const gapBtn = 6;
      const btnH = 28;
      const btnY = y + h - btnH - 10;
      const btnW = (w - padX * 2 - gapBtn * 2) / 3;
      const b0 = { x: x + padX, y: btnY, w: btnW, h: btnH };
      const b1 = { x: x + padX + btnW + gapBtn, y: btnY, w: btnW, h: btnH };
      const b2 = { x: x + padX + (btnW + gapBtn) * 2, y: btnY, w: btnW, h: btnH };
      if (isPlanExit) {
        // ExitPlanMode 네이티브 3선택: 자동승인(bypass)/수동승인(default)/거부.
        // 둘 다 action=allow, mode 로 권한모드 분기. mode 없는 거부는 deny.
        drawAppleButton(p, b0, "auto-allow", "allow", largeAlpha);
        drawAppleButton(p, b1, "allow once", "primary", largeAlpha);
        drawAppleButton(p, b2, "deny", "deny", largeAlpha);
        buttons = [
          { ...b0, action: "allow", mode: "bypassPermissions" },
          { ...b1, action: "allow", mode: "default" },
          { ...b2, action: "deny" }
        ];
      } else {
        drawAppleButton(p, b0, "allow", "allow", largeAlpha);
        drawAppleButton(p, b1, "deny", "deny", largeAlpha);
        drawAppleButton(p, b2, "to terminal", "cancel", largeAlpha);
        buttons = [
          { ...b0, action: "allow" },
          { ...b1, action: "deny" },
          { ...b2, action: "cancel" }
        ];
      }
    }

    node.approvalBox = { x, y, w, h, buttons };
  });
}

function wrapText(p, text, x, y, maxWidth, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (p.textWidth(test) > maxWidth && line) {
      p.text(line, x, y + lines * lineH);
      lines += 1;
      line = word;
      if (lines >= maxLines) return;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) p.text(line, x, y + lines * lineH);
}

function leftAnchor(p) {
  // user anchor = cmd-send 역삼각형의 아래 꼭짓점. CSS top:-12 + height:52 →
  // 꼭짓점 visual y = main top - 12 + 50 = main top + 38.
  return p.createVector(p.width * 0.5, 38);
}

function drawParticles(p) {
  // 옛 점 이동(particle dot) → 전기 arc(jagged lightning) 효과.
  // particle.t 는 path 위치가 아닌 arc lifecycle (0→1). 매 frame path 전체에 jagged stroke.
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i];
    if (particle.delay && particle.delay > 0) {
      particle.delay -= 1 / 60;
      continue;
    }
    particle.t += particle.speed;
    if (particle.t >= 1) {
      particles.splice(i, 1);
      continue;
    }

    let fromX, fromY, toX, toY;
    if (particle.kind === "user-to-claude" || particle.kind === "claude-to-user") {
      const node = claudeNodes.get(particle.sessionId);
      if (!node) { particles.splice(i, 1); continue; }
      const user = leftAnchor(p);
      if (particle.kind === "user-to-claude") {
        fromX = user.x; fromY = user.y; toX = node.x; toY = node.y;
      } else {
        fromX = node.x; fromY = node.y; toX = user.x; toY = user.y;
      }
    } else if (particle.kind === "claude-to-codex" || particle.kind === "codex-to-claude") {
      const codex = codexNodes.get(particle.codexKey);
      const node = claudeNodes.get(particle.sessionId);
      if (!codex || !node) { particles.splice(i, 1); continue; }
      if (particle.kind === "claude-to-codex") {
        fromX = node.x; fromY = node.y; toX = codex.x; toY = codex.y;
      } else {
        fromX = codex.x; fromY = codex.y; toX = node.x; toY = node.y;
      }
    } else if (particle.kind === "user-to-codex" || particle.kind === "codex-to-user") {
      const codex = codexNodes.get(particle.codexKey);
      if (!codex) { particles.splice(i, 1); continue; }
      const user = leftAnchor(p);
      if (particle.kind === "user-to-codex") {
        fromX = user.x; fromY = user.y; toX = codex.x; toY = codex.y;
      } else {
        fromX = codex.x; fromY = codex.y; toX = user.x; toY = user.y;
      }
    } else {
      continue;
    }

    drawElectricArc(p, fromX, fromY, toX, toY, particle);
  }
}

// 전기 arc — bezier path 따라 jagged segments + outer glow + inner bright + white-hot core.
// particle.t (0~1) lifecycle: 처음 15% 빠르게 fade in, 마지막 30% fade out.
// jitterSeed 로 매 arc 마다 다른 jagged 모양. 동시간 frame 시간으로도 살짝 흔들림 → 살아있는 느낌.
function drawElectricArc(p, fromX, fromY, toX, toY, particle) {
  const c = bezierControls(fromX, fromY, toX, toY);
  const segments = 14;
  const seed = particle.jitterSeed || 0;
  const timeJit = p.millis() / 60; // frame 마다 살짝 다른 noise — 떨림
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const baseX = p.bezierPoint(fromX, c.c1x, c.c2x, toX, t);
    const baseY = p.bezierPoint(fromY, c.c1y, c.c2y, toY, t);
    // perpendicular (path tangent 90° 회전) — path 진행 방향 수직으로 jitter 오프셋
    const tx = p.bezierTangent(fromX, c.c1x, c.c2x, toX, t);
    const ty = p.bezierTangent(fromY, c.c1y, c.c2y, toY, t);
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    // 끝점은 노드에 정확히 닿아야 — sin curve 로 양쪽 0
    const endFade = Math.sin(t * Math.PI);
    // p5 noise 는 0~1. -0.5 로 시프트 후 진폭 곱.
    const noiseVal = p.noise(seed + t * 6, timeJit + i * 0.3) - 0.5;
    const jit = noiseVal * 18 * endFade;
    pts.push([baseX + nx * jit, baseY + ny * jit]);
  }

  // lifecycle fade — 빠른 in, 느린 out (전기 잔상 느낌)
  const fade = particle.t < 0.15
    ? particle.t / 0.15
    : (particle.t > 0.7 ? (1 - particle.t) / 0.3 : 1);
  const alpha = 255 * fade;
  const [r, g, b] = particle.color;

  p.noFill();
  // 1) outer glow — 넓고 옅게
  p.stroke(r, g, b, alpha * 0.16);
  p.strokeWeight(7);
  drawArcPath(p, pts);
  // 2) mid body — 선명한 색
  p.stroke(r, g, b, alpha * 0.9);
  p.strokeWeight(1.8);
  drawArcPath(p, pts);
  // 3) inner core — 거의 흰색 hot center
  p.stroke(255, 255, 255, alpha * 0.75);
  p.strokeWeight(0.7);
  drawArcPath(p, pts);
}

function drawArcPath(p, pts) {
  p.beginShape();
  for (const [x, y] of pts) p.vertex(x, y);
  p.endShape();
}

function drawGlow(p, x, y, hex, radius, alpha) {
  for (let i = 3; i >= 1; i -= 1) {
    p.fill(colorWithAlpha(hex, (alpha / i) * 0.22));
    p.circle(x, y, radius * i);
  }
}

// 작업 중 노드 (working/running) — cmd-send 의 drop-shadow 스타일과 비슷한 부드러운 발광.
// canvas shadowBlur 14 (cmd-send 의 12px 와 비슷). pulse 없음 — drift/alpha 진동이 노드 motion 표현.
function drawIntenseGlow(p, x, y, hex, radius, alpha) {
  const ctx = p.drawingContext;
  const prevBlur = ctx.shadowBlur;
  const prevColor = ctx.shadowColor;
  const rgb = hexToRgbForShadow(hex);
  ctx.shadowBlur = 14;
  ctx.shadowColor = `rgba(${rgb}, 0.55)`;
  // 2 layer 부드러운 발광 — 안쪽 진하게 / 바깥 옅게. pulse 없음.
  for (let i = 2; i >= 1; i -= 1) {
    p.fill(colorWithAlpha(hex, (alpha / i) * 0.28));
    p.circle(x, y, radius * i);
  }
  ctx.shadowBlur = prevBlur;
  ctx.shadowColor = prevColor;
}

function hexToRgbForShadow(hex) {
  // "#abcdef" → "171,205,239"
  if (typeof hex !== "string" || hex[0] !== "#" || hex.length !== 7) return "255,255,255";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

function normalizeCodexStatus(status = "idle") {
  if (status === "active") return "running";
  if (status === "err") return "error";
  if (status === "ok") return "done";
  if (status === "done" || status === "error" || status === "running") return status;
  return "idle";
}

function nowMs() {
  return sketch ? sketch.millis() : performance.now();
}

function colorWithAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(255, alpha)) / 255})`;
}
