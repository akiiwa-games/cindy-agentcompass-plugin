// Vendored from akiiwa-games/magpie-agentcompass-router src/profiler-core.js at 3c732bbf2924c09b5500aa2e90607f8c57ed2e25 (MIT), itself ported from AgentCompass.
// Only the import paths differ from the source; regenerate rather than edit.
/**
 * Multi-Protocol Request Extractor & Deterministic 10-Field Task Profiler
 *
 * Ported from AgentCompass (`skills/agent-compass/scripts/allocator.py` and `route_judge.py`).
 * Pure ES2022 module (zero Node-only imports) so it runs identically in both Bun and `moejs`.
 */

import {
  CANONICAL_ROUTES,
  DEPTH_BY_DIFFICULTY,
  HARD_BY_DEFAULT,
  INTERACTION_STYLES,
  KIND_TRAITS,
} from "./catalog.mjs";

export const PROFILE_INTEGERS = {
  reasoning_depth: [1, 4],
  code_complexity: [0, 3],
  context_scale: [1, 3],
  divergence: [1, 3],
  hallucination_risk: [1, 3],
  error_cost: [1, 3],
};

export const PROFILE_FLAGS = ["needs_visual", "needs_gui", "local_only"];

export const DIVERGENT_WORDS = [
  "brainstorm",
  "creative",
  "novel",
  "innovat",
  "propose",
  "formulate",
  "scheme",
  "roadmap",
  "hypothesis",
  "ideat",
  "divergent",
  "制定方案",
  "设计方案",
  "新方案",
  "创造性",
  "发散",
  "创新",
  "新方向",
  "提出假设",
  "路线图",
  "架构创新",
];

export const READONLY_REVIEW_PHRASES = [
  "(read-only)",
  "read-only review",
  "read-only investigation",
  "read-only code",
  "read-only audit",
  "read-only release",
  "read-only diff",
  "read-only diagnostic",
  "read-only inspection",
  "independent review",
  "independent code and",
  "independent audit",
  "no repo code edits",
  "write no application code",
  "write no production code",
  "do not edit repo",
  "do not modify repo",
  "do not change repo",
  "只读审阅",
  "只读代码审查",
  "只读审查",
  "只读排查",
  "独立代码审查",
  "独立审查",
  "不修改仓库代码",
];

export const GUI_WORDS = [
  "click the",
  "click save",
  "screenshot",
  " gui",
  "desktop app",
  "mouse",
  "keyboard",
  "operate the browser",
  "operate the desktop",
  "点击",
  "截图",
  "桌面",
  "鼠标",
  "键盘",
  "操作浏览器",
  "操作桌面",
];

const OBJECTIVE_LOCAL_RUNTIME_RE =
  /\b(?:ssh|ssh-agent|vps|localhost|127\.0\.0\.1|pytest|unittest|sqlite|daemon|worktree|adb|emulator|intranet|webhook|credentials?)\b/i;

const LOCAL_MACHINE_RE =
  /(?:[A-Za-z]:[\\/]|~\/|\\\\)|\b(?:working tree|git checkout|local repo|this repo|local daemon|local git)\b/i;

const COUPLED_SIGNALS = [
  "cross-module",
  "multi-module",
  "refactor",
  "architecture",
  "concurrency",
  "deadlock",
  "race condition",
  "distributed",
  "migration",
  "subsystem",
  "orchestrat",
  "跨模块",
  "多模块",
  "架构重构",
  "并发",
  "死锁",
  "竞态",
  "迁移方案",
  "子系统",
];

const FRONTIER_SIGNALS = [
  "formal proof",
  "mathematical proof",
  "mathematical critique",
  "theorem",
  "optimal-stopping",
  "frontier reasoning",
  "prove or refute",
  "形式化证明",
  "数学证明",
  "数学推导",
  "定理推导",
];

/**
 * Extract text and visual indicators from an arbitrary message content payload
 * across OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini GenerateContent.
 */
function extractPartContent(content) {
  let text = "";
  let hasImage = false;
  if (typeof content === "string") {
    return { text: content, hasImage: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasImage: false };
  }
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = String(part.type || "").toLowerCase();
    if (
      type === "image" ||
      type === "image_url" ||
      type === "input_image" ||
      part.inlineData ||
      part.inline_data ||
      part.fileData ||
      part.file_data
    ) {
      hasImage = true;
    }
    if (typeof part.text === "string") {
      text += (text ? "\n" : "") + part.text;
    } else if (typeof part.input_text === "string") {
      text += (text ? "\n" : "") + part.input_text;
    } else if (typeof part.content === "string") {
      text += (text ? "\n" : "") + part.content;
    }
  }
  return { text, hasImage };
}

/**
 * Parse a Magpie request body (`chat`, `responses`, `anthropic`, or `gemini`)
 * into a normalized routing evidence envelope.
 */
export function extractRequestFacts(body, ctx = {}) {
  if (!body || typeof body !== "object") {
    return {
      model: "",
      objective: "",
      previousUser: "",
      systemText: "",
      hasVisualInput: false,
      isToolFollowup: false,
      toolCount: 0,
      estimatedTokens: 0,
      agent: ctx?.agent || "",
      protocol: ctx?.protocol || "",
    };
  }

  const model = typeof body.model === "string" ? body.model : "";
  let systemText = "";
  if (typeof body.system === "string") {
    systemText = body.system;
  } else if (Array.isArray(body.system)) {
    systemText = extractPartContent(body.system).text;
  } else if (typeof body.instructions === "string") {
    systemText = body.instructions;
  } else if (body.systemInstruction?.parts) {
    systemText = extractPartContent(body.systemInstruction.parts).text;
  }

  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : Array.isArray(body.contents)
        ? body.contents
        : typeof body.input === "string"
          ? [{ role: "user", content: body.input }]
          : [];

  let latestUserText = "";
  let previousUserText = "";
  let hasVisualInput = false;
  let isToolFollowup = false;
  let totalChars = systemText.length;

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || msg.type || "").toLowerCase();
    const rawContent = msg.content ?? msg.parts ?? (typeof msg.text === "string" ? msg.text : "");
    const { text, hasImage } = extractPartContent(rawContent);
    totalChars += text.length;
    if (hasImage) hasVisualInput = true;

    if (i === rawMessages.length - 1) {
      if (
        role === "tool" ||
        role === "function_call_output" ||
        (Array.isArray(rawContent) &&
          rawContent.some((p) => p && (p.type === "tool_result" || p.type === "function_call_output" || p.functionResponse)))
      ) {
        isToolFollowup = true;
      }
    }

    if (role === "user" && text.trim()) {
      previousUserText = latestUserText;
      latestUserText = text.trim();
    } else if (role === "developer" && !systemText && text.trim()) {
      systemText = text.trim();
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];

  return {
    model,
    objective: latestUserText,
    previousUser: previousUserText,
    systemText: systemText.slice(0, 2000),
    hasVisualInput,
    isToolFollowup,
    toolCount: tools.length,
    estimatedTokens: Math.ceil(totalChars / 4),
    agent: ctx?.agent || "",
    protocol: ctx?.protocol || "",
  };
}

export function inferKindFromObjective(objective) {
  const text = ` ${String(objective || "").toLowerCase()} `;
  if (GUI_WORDS.some((w) => text.includes(w))) {
    return "computer_use";
  }
  const rules = [
    [
      "direction_reasoning",
      [
        "formal proof",
        "mathematical critique",
        "optimal-stopping",
        "frontier reasoning",
        "critique the architecture",
        "prove or refute",
        "brainstorm",
        "first-principles",
        "first principles",
        "unconventional",
        "creative architecture",
        "creative product",
        "creative direction",
        "novel product",
        "形式化证明",
        "数学推导",
        "架构批判",
        "战略权衡",
        "头脑风暴",
        "脑暴",
        "第一性原理",
      ],
    ],
    [
      "complex_build_plan",
      [
        "migration plan",
        "migration spec",
        "implementation specification",
        "multi-phase",
        "system architecture plan",
        "new scheme",
        "plan a new scheme",
        "规划一个新方案",
        "迁移方案",
        "迁移计划",
        "分阶段设计",
        "系统建设方案",
      ],
    ],
    [
      "bounded_bulk_work",
      [
        "bulk ",
        "batch rename",
        "mechanical refactor",
        "uniform rule",
        "codemod",
        "批量",
        "机械替换",
        "统一替换",
      ],
    ],
    [
      "web_research",
      [
        "web survey",
        "web research",
        "vendor survey",
        "public documentation",
        "search the web",
        "search public",
        "open-web",
        "literature survey",
        "网页调研",
        "文献综述",
        "厂商调研",
        "搜索官网",
        "公开文档",
      ],
    ],
    [
      "text_in_text_out",
      [
        "translate",
        "translation",
        "draft a document",
        "draft documentation",
        "rewrite the text",
        "summarize the text",
        "翻译",
        "撰写文档",
        "文案",
        "润色",
        "摘要",
      ],
    ],
    [
      "visual_analysis",
      [
        "visual diff",
        "design diff",
        "inspect screenshot",
        "compare screenshot",
        "inspect the image",
        "inspect the screenshot",
        "compare the screenshots",
        "design inspection",
        "视觉对比",
        "截图对比",
        "检查截图",
        "设计稿检查",
        "看图分析",
      ],
    ],
    [
      "debug_review",
      [
        "bug",
        "fix ",
        "deadlock",
        "race condition",
        "regression",
        "review the diff",
        "code review",
        "diff review",
        "read-only review",
        "(read-only)",
        "independent review",
        "invariant audit",
        "security audit",
        "memory leak",
        "diagnos",
        "rendering glitch",
        "intermittent failure",
        "报错",
        "排查",
        "修复",
        "死锁",
        "代码审查",
        "只读审阅",
        "只读审查",
        "安全审计",
        "内存泄漏",
      ],
    ],
    [
      "frontend_implementation",
      [
        "frontend",
        "react",
        "css",
        "tailwind",
        "mockup",
        "desktop ui",
        "game ui",
        "界面",
        "前端",
        "样式",
        "组件",
      ],
    ],
    [
      "research_packet",
      [
        "backtest",
        "quantitative experiment",
        "benchmark suite",
        "statistical evaluation",
        "research packet",
        "simulation",
        "data analysis pipeline",
        "回测",
        "定量实验",
        "评测",
        "仿真",
        "统计检验",
      ],
    ],
    [
      "tool_execution",
      [
        "runbook",
        "checklist",
        "deploy",
        "release commands",
        "health check",
        "run the test suite",
        "巡检",
        "发版",
        "运行测试",
        "操作手册",
        "发布流程",
      ],
    ],
    [
      "exploration_analysis",
      [
        "explore",
        "investigate",
        "trace",
        "map the codebase",
        "architecture exploration",
        "调研",
        "分析",
        "梳理",
        "探索仓库",
        "架构追踪",
      ],
    ],
    [
      "self_contained_code",
      [
        "standalone",
        "self-contained",
        "algorithm",
        "isolated module",
        "独立算法",
        "独立脚本",
        "自包含",
        "实现算法",
      ],
    ],
  ];

  for (const [kind, keywords] of rules) {
    if (keywords.some((w) => text.includes(w))) {
      return kind;
    }
  }
  return objective && String(objective).trim() ? "general_implementation" : "other_or_mixed";
}

export function isReadonlyReviewTask(objective, profile = null) {
  if (profile && profile.needs_gui) return false;
  const text = ` ${String(objective || "").toLowerCase()} ${String(profile?.reason || "").toLowerCase()} `;
  if (READONLY_REVIEW_PHRASES.some((p) => text.includes(p))) return true;
  return /\bread-only\b[^.]{0,40}\b(?:review|audit|investig|diagnos|inspect|check)\b/i.test(text);
}

export function inferDivergence(objective, kind = null, style = null) {
  if (kind === "computer_use") return 1;
  if (kind === "complex_build_plan" || kind === "direction_reasoning" || style === "advisory") {
    return 3;
  }
  const text = ` ${String(objective || "").toLowerCase()} `;
  if (DIVERGENT_WORDS.some((w) => text.includes(w))) {
    return 3;
  }
  if (text.includes("intermittent") || text.includes("unknown cause") || text.includes("hypothes") || text.includes("偶发") || text.includes("未知根因")) {
    return 2;
  }
  return 1;
}

export function inferReasoningDepth(objective, kind, explicitDifficulty = null) {
  if (explicitDifficulty && DEPTH_BY_DIFFICULTY[explicitDifficulty]) {
    return DEPTH_BY_DIFFICULTY[explicitDifficulty];
  }
  const text = ` ${String(objective || "").toLowerCase()} `;
  if (FRONTIER_SIGNALS.some((w) => text.includes(w))) {
    return 4;
  }
  if (COUPLED_SIGNALS.some((w) => text.includes(w)) || kind === "complex_build_plan" || kind === "direction_reasoning") {
    return 3;
  }
  if (HARD_BY_DEFAULT.includes(kind)) {
    return 2;
  }
  return 1;
}

export function validateProfile(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("task.profile must be an object");
  }
  const profile = {};
  if (raw.work_kind !== undefined && raw.work_kind !== null) {
    if (typeof raw.work_kind !== "string" || !(raw.work_kind in KIND_TRAITS)) {
      throw new Error(`task.profile.work_kind must be one of ${Object.keys(KIND_TRAITS).join(", ")}`);
    }
    profile.work_kind = raw.work_kind;
  }
  for (const [name, [low, high]] of Object.entries(PROFILE_INTEGERS)) {
    if (name === "divergence" && !(name in raw)) {
      profile.divergence = 1;
      continue;
    }
    const val = Number(raw[name]);
    if (!Number.isInteger(val) || val < low || val > high) {
      throw new Error(`task.profile.${name} must be an integer from ${low} to ${high}`);
    }
    profile[name] = val;
  }
  for (const flag of PROFILE_FLAGS) {
    profile[flag] = Boolean(raw[flag]);
  }
  const style = raw.interaction_style || "engineering";
  if (!INTERACTION_STYLES.includes(style)) {
    throw new Error(`task.profile.interaction_style must be one of ${INTERACTION_STYLES.join(", ")}`);
  }
  profile.interaction_style = style;
  const hours = Number(raw.expected_hours ?? 0.5);
  profile.expected_hours = Number.isFinite(hours)
    ? Math.round(Math.min(Math.max(hours, 0.05), 24.0) * 100) / 100
    : 0.5;
  profile.hours_confidence = ["low", "medium", "high"].includes(raw.hours_confidence)
    ? raw.hours_confidence
    : "medium";
  profile.urgency = ["unknown", "low", "normal", "high"].includes(raw.urgency) ? raw.urgency : "unknown";
  profile.reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 300) : "";
  profile.multi_task = Boolean(raw.multi_task);
  profile.task_count = ["1", "2", "3", ">3"].includes(raw.task_count) ? raw.task_count : "1";
  return profile;
}

/**
 * Deterministic 10-field task profile (the `< 1 ms` offline twin of the System-One scorer).
 * Ported directly from `allocator.py:infer_task_profile`.
 */
export function inferTaskProfile(task = {}, routes = CANONICAL_ROUTES) {
  const objective = typeof task.objective === "string" ? task.objective : "";
  let kind = task.work_kind && routes[task.work_kind] ? task.work_kind : inferKindFromObjective(objective);
  const needs = task.needs && typeof task.needs === "object" ? task.needs : {};
  const implies = routes[kind]?.implies || {};
  const depth = inferReasoningDepth(objective, kind, task.difficulty);

  let [code, context, risk, cost, style] = KIND_TRAITS[kind] || KIND_TRAITS.other_or_mixed;
  if (isReadonlyReviewTask(objective)) {
    code = 0;
    if (kind === "general_implementation") {
      kind = "debug_review";
    }
  }
  const gui =
    kind === "computer_use" ||
    Boolean(needs.gui) ||
    (kind === "other_or_mixed" && GUI_WORDS.some((w) => ` ${objective.toLowerCase()} `.includes(w)));

  if (depth >= 3) {
    context = Math.max(context, 2);
    if (style === "engineering" && code > 0) {
      code = Math.max(code, 2);
      if (objective.toLowerCase().includes("concurrency") || objective.toLowerCase().includes("protocol") || objective.includes("并发")) {
        code = 3;
      }
    }
  }
  if (needs.critical) {
    cost = 3;
  }
  const divergence = inferDivergence(objective, kind, style);
  const evidence = `${objective} ${task.context || ""} ${task.cwd || ""}`;
  const localHit = OBJECTIVE_LOCAL_RUNTIME_RE.test(evidence) || LOCAL_MACHINE_RE.test(evidence);
  const localOnly =
    needs.local_only !== undefined ? Boolean(needs.local_only) : Boolean(localHit || implies.local_only);

  const expectedHours = depth === 1 ? 0.25 : depth === 2 ? 0.8 : depth === 3 ? 2.0 : 3.5;

  return validateProfile({
    work_kind: kind,
    reasoning_depth: depth,
    code_complexity: code,
    context_scale: context,
    divergence,
    hallucination_risk: risk,
    error_cost: cost,
    needs_visual: Boolean(needs.visual || task.hasVisualInput || implies.visual || gui),
    needs_gui: gui,
    local_only: localOnly,
    interaction_style: style,
    expected_hours: expectedHours,
    hours_confidence: "medium",
    urgency: "unknown",
    reason: `deterministic profile: work_kind=${kind}, depth=${depth}, code=${code}, scale=${context}, div=${divergence}`,
    multi_task: false,
    task_count: "1",
  });
}

export const profileTask = inferTaskProfile;
