// Vendored from akiiwa-games/magpie-agentcompass-router src/catalog.js at 3c732bbf2924c09b5500aa2e90607f8c57ed2e25 (MIT), itself ported from AgentCompass.
// Only the import paths differ from the source; regenerate rather than edit.
/**
 * AgentCompass Core Model Capabilities, Subjective DNA Vectors, Canonical Routes,
 * Effort Curves, and Scoring Policy.
 *
 * Ported directly from AgentCompass (`skills/agent-compass/references/model-capabilities.json`
 * and `skills/agent-compass/references/accounts.json`).
 * Pure ES2022 module with zero external or Node-only dependencies so it runs in both
 * Bun (`magpie.hooks` / provider plugin) and Magpie's in-process `moejs` (`magpie.middleware`).
 */

export const CAPABILITY_DIMENSIONS = [
  "reasoning",
  "coding",
  "exploration",
  "anti_hallucination",
  "visual",
  "gui",
];

export const SUBJECTIVE_DIMENSIONS = [
  "divergence",
  "global_rigor",
  "module_precision",
];

export const INTERACTION_STYLES = [
  "engineering",
  "exploration",
  "text_only",
  "advisory",
];

export const DIFFICULTY_ORDER = ["routine", "hard", "coupled", "frontier"];

export const DEPTH_BY_DIFFICULTY = {
  routine: 1,
  hard: 2,
  coupled: 3,
  frontier: 4,
};

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const HARD_BY_DEFAULT = [
  "debug_review",
  "general_implementation",
  "frontend_implementation",
  "self_contained_code",
  "computer_use",
  "exploration_analysis",
  "research_packet",
];

/**
 * kind -> [code_complexity, context_scale, hallucination_risk, error_cost, interaction_style]
 */
export const KIND_TRAITS = {
  general_implementation: [2, 1, 2, 2, "engineering"],
  frontend_implementation: [2, 1, 2, 2, "engineering"],
  debug_review: [2, 2, 3, 2, "engineering"],
  bounded_bulk_work: [1, 2, 1, 1, "engineering"],
  tool_execution: [1, 1, 1, 2, "engineering"],
  self_contained_code: [2, 1, 1, 1, "engineering"],
  exploration_analysis: [0, 2, 3, 1, "exploration"],
  research_packet: [1, 2, 3, 1, "exploration"],
  computer_use: [0, 1, 2, 2, "engineering"],
  visual_analysis: [0, 1, 3, 1, "exploration"],
  text_in_text_out: [0, 1, 2, 1, "text_only"],
  web_research: [0, 2, 2, 1, "text_only"],
  dot_execution: [1, 1, 2, 1, "text_only"],
  direction_reasoning: [0, 2, 3, 1, "advisory"],
  complex_build_plan: [0, 3, 3, 2, "advisory"],
  other_or_mixed: [1, 1, 2, 2, "engineering"],
};

export const CANONICAL_ROUTES = {
  general_implementation: {
    scope:
      "Implement an agreed plan, maintain production features, refactor bounded code or deliver ordinary repository changes.",
    role: "worker",
    preferred: ["gpt-6.1-sol", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-4-argon-high"],
    capability_fit: { coding: 0.55, reasoning: 0.25, anti_hallucination: 0.2 },
  },
  frontend_implementation: {
    scope:
      "Write UI components, interactions, animations and styling from the accepted design; visual evidence inspection is a separate visual_analysis task when material.",
    role: "worker",
    preferred: ["gemini-4-argon-high", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol"],
    capability_fit: { coding: 0.45, visual: 0.35, reasoning: 0.2 },
  },
  debug_review: {
    scope:
      "Subtle bug diagnosis, regression analysis, review of code and diffs, invariants, test-driven repairs and checking existing behavior.",
    role: "reviewer or debugging worker",
    preferred: ["claude-opus-5-5", "gpt-6-astra", "claude-sonnet-5-5", "gpt-6.1-sol"],
    capability_fit: { reasoning: 0.4, anti_hallucination: 0.35, coding: 0.25 },
  },
  complex_build_plan: {
    scope:
      "Turn an agreed direction into a repository-grounded multi-system build plan: dependencies, interfaces, staged migrations, sequencing, validation and rollback.",
    role: "planner",
    preferred: ["claude-opus-5-5", "gpt-6-astra", "gemini-4-argon-high", "claude-sonnet-5-5"],
    capability_fit: { reasoning: 0.45, exploration: 0.3, anti_hallucination: 0.25 },
  },
  direction_reasoning: {
    scope:
      "Deep reasoning and discussion of solution direction, competing architectures, assumptions, causal explanations, or which problem to solve.",
    role: "advisor or scheme designer",
    preferred: ["gemini-4-argon-high", "claude-opus-5-5", "claude-fable-5-1", "gpt-6-astra"],
    capability_fit: { reasoning: 0.6, anti_hallucination: 0.4 },
  },
  exploration_analysis: {
    scope:
      "Explore and analyze material in the codebase or dataset and return findings as text: map how a system works, trace where and why something happens, read logs, configs, or documents.",
    role: "explorer or analyst",
    preferred: ["claude-sonnet-5-5", "gemini-4-argon-high", "claude-opus-5-5", "gpt-6-astra"],
    implies: { local_only: true },
    capability_fit: { exploration: 0.5, reasoning: 0.25, anti_hallucination: 0.25 },
  },
  research_packet: {
    scope:
      "Run a defined quantitative experiment, evaluation benchmark, simulation, backtest or data analysis pipeline, compare variants against a baseline, and report metrics.",
    role: "research worker",
    preferred: ["gpt-6.1-sol", "claude-opus-5-5", "gemini-4-argon-high", "claude-sonnet-5-5"],
    implies: { local_only: true },
    capability_fit: { coding: 0.35, reasoning: 0.35, anti_hallucination: 0.3 },
  },
  self_contained_code: {
    scope:
      "Self-contained code and validation work whose whole input fits in the prompt and whose deliverable is new files with unit tests or an isolated algorithm.",
    role: "worker",
    preferred: ["gpt-6.1-sol", "gemini-4-argon-high", "claude-sonnet-5-5", "claude-opus-5-5"],
    capability_fit: { coding: 0.6, reasoning: 0.25, anti_hallucination: 0.15 },
  },
  visual_analysis: {
    scope:
      "Interpret screenshots, charts, diagrams, spatial layouts, image evidence or visual discrepancies; distinct from writing frontend code.",
    role: "visual analyst",
    preferred: ["claude-opus-5-5", "gpt-6-astra", "gemini-4-argon-high", " gpt-6.1-sol"],
    implies: { visual: true },
    strict_order: true,
    capability_fit: { visual: 0.7, anti_hallucination: 0.3 },
  },
  computer_use: {
    scope:
      "Operate a graphical computer or app through screenshots, mouse and keyboard (computer use): GUI-only applications, desktop or browser flows.",
    role: "computer-use worker",
    preferred: ["gpt-6-astra", "gpt-6.1-sol", "gemini-4-argon-high", "claude-opus-5-5"],
    implies: { visual: true },
    capability_fit: { gui: 1.0 },
  },
  bounded_bulk_work: {
    scope:
      "Homogeneous small changes, independent extraction or inventory, boilerplate and fixed transformations with explicit acceptance.",
    role: "bounded leaf worker",
    preferred: ["gemini-3.8-flash-high", "claude-haiku-5-5", "gpt-6-luna", "gpt-6.1-sol"],
    capability_fit: { coding: 0.4, anti_hallucination: 0.4, reasoning: 0.2 },
  },
  tool_execution: {
    scope:
      "A bounded outcome primarily requiring file, shell, browser, API or other tool calls, with direction and authorized actions already established.",
    role: "tool-execution worker",
    preferred: ["gemini-3.8-flash-high", "claude-haiku-5-5", "gpt-6-luna", "claude-sonnet-5-5"],
    capability_fit: { anti_hallucination: 0.5, exploration: 0.3, reasoning: 0.2 },
  },
  text_in_text_out: {
    scope:
      "Self-contained work whose deliverable is text: drafting, rewriting, translating, summarizing, critiquing, comparing, explaining.",
    role: "worker",
    preferred: ["claude-sonnet-5-5", "gemini-4-argon-high", "gemini-3.8-flash-high", "claude-opus-5-5"],
    capability_fit: { reasoning: 0.5, anti_hallucination: 0.5 },
  },
  web_research: {
    scope:
      "Gather, check and organize information from the open web or public documentation: vendor surveys, current specs, changelog lookups, fact-checks, comparison tables.",
    role: "worker",
    preferred: ["gemini-4-argon-high", "claude-sonnet-5-5", "grok-4.7", "gemini-3.8-flash-high"],
    capability_fit: { exploration: 0.5, anti_hallucination: 0.5 },
  },
  dot_execution: {
    scope:
      "A bounded assignment an isolated remote worker can finish end to end and return as a completed text deliverable.",
    role: "worker",
    preferred: ["gpt-6-astra", "gpt-6.1-sol", "claude-sonnet-5-5"],
    implies: { local_only: false },
    capability_fit: { reasoning: 0.4, coding: 0.4, anti_hallucination: 0.2 },
  },
  other_or_mixed: {
    scope: "Unmatched or mixed work.",
    role: "worker",
    preferred: ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-4-argon-high", "claude-opus-5-5"],
    capability_fit: { reasoning: 0.4, coding: 0.3, exploration: 0.3 },
  },
};

export const DEFAULT_MODELS = {
  "claude-fable-5-1": {
    tier: 4.6,
    cost: 5,
    visual: false,
    usd_per_hour: 18.7,
    disabled_by_default: true,
    efforts: ["low", "medium", "high", "max"],
    capabilities: {
      reasoning: 0.98,
      coding: 0.95,
      exploration: 0.9,
      anti_hallucination: 0.9,
      visual: 0.0,
      gui: 0.0,
    },
    subjective: {
      divergence: 0.92,
      global_rigor: 0.95,
      module_precision: 0.9,
    },
  },
  "claude-opus-5-5": {
    tier: 4.6,
    cost: 4,
    visual: 1.0,
    usd_per_hour: 7.5,
    fast_capable: true,
    efforts: ["low", "medium", "high", "max"],
    capabilities: {
      reasoning: 0.89,
      coding: 0.91,
      exploration: 0.88,
      anti_hallucination: 0.92,
      visual: 1.0,
      gui: 0.55,
    },
    subjective: {
      divergence: 0.62,
      global_rigor: 0.98,
      module_precision: 0.92,
    },
  },
  "gpt-6-astra": {
    tier: 4.2,
    cost: 4,
    visual: 0.8,
    usd_per_hour: 22.6,
    fast_capable: true,
    efforts: ["low", "medium", "high", "xhigh"],
    capabilities: {
      reasoning: 0.8,
      coding: 0.79,
      exploration: 0.8,
      anti_hallucination: 0.78,
      visual: 0.8,
      gui: 0.95,
    },
    subjective: {
      divergence: 0.68,
      global_rigor: 0.82,
      module_precision: 0.84,
    },
  },
  "gemini-4-argon-high": {
    tier: 4.0,
    cost: 3,
    visual: 0.75,
    usd_per_hour: 4.0,
    duration_multiplier: 1.35,
    efforts: ["low", "medium", "high", "max"],
    capabilities: {
      reasoning: 0.78,
      coding: 0.83,
      exploration: 0.86,
      anti_hallucination: 0.81,
      visual: 0.75,
      gui: 0.62,
    },
    subjective: {
      divergence: 0.96,
      global_rigor: 0.8,
      module_precision: 0.8,
    },
  },
  "claude-sonnet-5-5": {
    tier: 3.9,
    cost: 2,
    visual: 0.6,
    usd_per_hour: 4.4,
    efforts: ["low", "medium", "high", "max"],
    capabilities: {
      reasoning: 0.74,
      coding: 0.82,
      exploration: 0.89,
      anti_hallucination: 0.73,
      visual: 0.6,
      gui: 0.55,
    },
    subjective: {
      divergence: 0.6,
      global_rigor: 0.76,
      module_precision: 0.78,
    },
  },
  "gpt-6.1-terra": {
    tier: 3.7,
    cost: 3,
    visual: 0.72,
    usd_per_hour: 3.0,
    fast_capable: true,
    efforts: ["low", "medium", "high", "xhigh"],
    capabilities: {
      reasoning: 0.73,
      coding: 0.83,
      exploration: 0.71,
      anti_hallucination: 0.75,
      visual: 0.72,
      gui: 0.8,
    },
    subjective: {
      divergence: 0.5,
      global_rigor: 0.65,
      module_precision: 0.88,
    },
  },
  "gpt-6.1-sol": {
    tier: 3.6,
    cost: 3,
    visual: 0.7,
    usd_per_hour: 2.6,
    duration_multiplier: 1.35,
    fast_capable: true,
    efforts: ["low", "medium", "high", "xhigh"],
    capabilities: {
      reasoning: 0.71,
      coding: 0.85,
      exploration: 0.62,
      anti_hallucination: 0.74,
      visual: 0.7,
      gui: 0.82,
    },
    subjective: {
      divergence: 0.4,
      global_rigor: 0.25,
      module_precision: 0.95,
    },
  },
  "gpt-6-sol": {
    tier: 3.5,
    cost: 3,
    visual: 0.68,
    usd_per_hour: 2.6,
    fast_capable: true,
    efforts: ["low", "medium", "high", "xhigh"],
    capabilities: {
      reasoning: 0.69,
      coding: 0.82,
      exploration: 0.6,
      anti_hallucination: 0.72,
      visual: 0.68,
      gui: 0.8,
    },
    subjective: {
      divergence: 0.4,
      global_rigor: 0.25,
      module_precision: 0.92,
    },
  },
  "grok-4.7": {
    tier: 3.4,
    cost: 2,
    visual: false,
    usd_per_hour: 1.5,
    efforts: ["low", "medium", "high", "xhigh"],
    capabilities: {
      reasoning: 0.59,
      coding: 0.58,
      exploration: 0.6,
      anti_hallucination: 0.62,
      visual: 0.0,
      gui: 0.0,
    },
    subjective: {
      divergence: 0.45,
      global_rigor: 0.4,
      module_precision: 0.58,
    },
  },
  "claude-haiku-5-5": {
    tier: 3.2,
    cost: 1,
    visual: 0.48,
    usd_per_hour: 0.8,
    efforts: ["low", "medium", "high"],
    capabilities: {
      reasoning: 0.58,
      coding: 0.65,
      exploration: 0.62,
      anti_hallucination: 0.62,
      visual: 0.48,
      gui: 0.35,
    },
    subjective: {
      divergence: 0.42,
      global_rigor: 0.53,
      module_precision: 0.67,
    },
  },
  "gpt-6-luna": {
    tier: 3.2,
    cost: 1,
    visual: 0.55,
    usd_per_hour: 0.8,
    fast_capable: true,
    efforts: ["low", "medium", "high"],
    capabilities: {
      reasoning: 0.58,
      coding: 0.65,
      exploration: 0.57,
      anti_hallucination: 0.62,
      visual: 0.55,
      gui: 0.5,
    },
    subjective: {
      divergence: 0.4,
      global_rigor: 0.45,
      module_precision: 0.68,
    },
  },
  "gemini-3.8-flash-high": {
    tier: 3.0,
    cost: 1,
    visual: 0.3,
    usd_per_hour: 0.5,
    efforts: ["low", "medium", "high"],
    capabilities: {
      reasoning: 0.52,
      coding: 0.47,
      exploration: 0.5,
      anti_hallucination: 0.72,
      visual: 0.3,
      gui: 0.42,
    },
    subjective: {
      divergence: 0.35,
      global_rigor: 0.35,
      module_precision: 0.65,
    },
  },
  "deepseek-v4.1-flash-free": {
    tier: 2.8,
    cost: 0,
    visual: false,
    usd_per_hour: 0.0,
    efforts: ["low", "medium", "high"],
    capabilities: {
      reasoning: 0.48,
      coding: 0.5,
      exploration: 0.5,
      anti_hallucination: 0.45,
      visual: 0.0,
      gui: 0.0,
    },
    subjective: {
      divergence: 0.45,
      global_rigor: 0.35,
      module_precision: 0.55,
    },
  },
};

export const MODEL_ALIASES = {
  "claude-haiku-4-5@20251001": "claude-haiku-5-5",
  "claude-haiku-4-5": "claude-haiku-5-5",
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-4-6": "claude-opus-5-5",
  "claude-opus-4-5": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-sonnet-4-5": "claude-sonnet-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "gemini-3.8-flash": "gemini-3.8-flash-high",
  "gemini-2.5-flash": "gemini-3.8-flash-high",
  "gemini-4-argon": "gemini-4-argon-high",
  "gemini-4-pro": "gemini-4-argon-high",
  "gemini-2.5-pro": "gemini-4-argon-high",
  "gemini-4-ultra": "gemini-4-argon-high",
  argon: "gemini-4-argon-high",
  "gpt-5.4": "gpt-6-astra",
  "gpt-5.3-codex": "gpt-6.1-sol",
  "gpt-5.4-mini": "gpt-6-luna",
  "grok-4.7-latest": "grok-4.7",
  "grok-4": "grok-4.7",
  "opencode/deepseek-v4.1-flash-free": "deepseek-v4.1-flash-free",
  "deepseek-v4.1-flash": "deepseek-v4.1-flash-free",
  deepseek: "deepseek-v4.1-flash-free",
};

export const EFFORT_CURVES = {
  "claude-opus-5-5": {
    ability: { low: -0.6, medium: -0.25, high: 0.0, max: 0.35 },
    burn: { low: 0.25, medium: 0.45, high: 0.7, max: 1.5 },
  },
  "claude-sonnet-5-5": {
    ability: { low: -0.6, medium: -0.25, high: 0.0, max: 0.55 },
    burn: { low: 0.25, medium: 0.45, high: 0.7, max: 2.1 },
  },
  "gpt-6-astra": {
    ability: { low: -0.6, medium: -0.25, high: 0.0, xhigh: 0.22 },
    burn: { low: 0.25, medium: 0.45, high: 0.7, xhigh: 1.4 },
  },
  "gpt-6.1-sol": {
    ability: { low: -0.55, medium: -0.2, high: 0.0, xhigh: 0.2 },
    burn: { low: 0.25, medium: 0.45, high: 0.7, xhigh: 1.58 },
  },
  "gemini-4-argon-high": {
    ability: { low: -0.6, medium: -0.25, high: 0.0, max: 0.25 },
    burn: { low: 0.25, medium: 0.45, high: 0.7, max: 1.3 },
  },
};

export const DEFAULT_SCORING_POLICY = {
  weights: {
    fit: 0.3,
    ability: 0.1,
    continuity: 0.25,
  },
  fallback_fit: {
    start: 0.6,
    step: 0.015,
    floor: 0.4,
  },
  extra_effort_penalty: 0.025,
  high_precision_effort_weight: 0.14,
  ability_floor: {
    routine: 3.0,
    hard: 3.3,
    coupled: 3.6,
    frontier: 4.2,
  },
  ability_span: 0.6,
  critical_headroom: 0.3,
  effort_ability: {
    low: -0.7,
    medium: -0.3,
    high: 0.0,
    xhigh: 0.2,
    max: 0.4,
  },
  effort_burn: {
    low: 0.2,
    medium: 0.4,
    high: 0.7,
    xhigh: 1.0,
    max: 1.3,
  },
  demand: {
    property_span: 0.5,
    default_load: 0.5,
    depth_coupling: 0.06,
    shortfall_weight: 0.35,
    precision_headroom: 0.15,
    sprint_effort_weight: 0.06,
    property_weights: {
      code_complexity: 1.0,
      context_scale: 0.8,
      divergence: 0.8,
      hallucination_risk: 1.0,
      error_cost: 0.5,
    },
  },
  profile: {
    difficulty_by_depth: {
      1: "routine",
      2: "hard",
      3: "coupled",
      4: "frontier",
    },
    saturation_span: 0.3,
    vector_weight: 0.5,
    // In pure intent routing, subjective Model DNA (divergence / global_rigor / module_precision)
    // is blended with objective capability vector_fit and route_fit so specialist models win their DNA niche.
    subjective: {
      weight: 0.45,
      vector_weight: 0.35,
      route_weight: 0.2,
    },
    overqualification_weight: 0.08,
    overqualification_span: 0.6,
    overqualification_ref_usd_per_hour: 10.0,
    overqualification_price_cap: 3.0,
    requirements: {
      reasoning: { 1: 0.45, 2: 0.6, 3: 0.75, 4: 0.9 },
      coding: { 0: 0.0, 1: 0.5, 2: 0.65, 3: 0.8 },
      exploration: { 1: 0.4, 2: 0.6, 3: 0.75 },
      anti_hallucination: { 1: 0.4, 2: 0.6, 3: 0.8 },
      visual: 0.6,
      gui: { 1: 0.5, 2: 0.7, 3: 0.8, 4: 0.85 },
    },
    requirement_weights: {
      reasoning: 1.0,
      coding: 1.0,
      exploration: 0.5,
      exploration_style: 1.0,
      anti_hallucination: 0.5,
      anti_hallucination_high: 1.0,
      visual: 1.0,
      gui: 1.5,
    },
    kind_by_style: {
      engineering: "general_implementation",
      exploration: "exploration_analysis",
      text_only: "text_in_text_out",
      advisory: "direction_reasoning",
    },
  },
};

/**
 * Strip provider prefix (`provider/model`) and `:effort` suffix if present, then resolve alias.
 */
export function canonicalModel(rawModel, aliases = MODEL_ALIASES) {
  if (!rawModel || typeof rawModel !== "string") return "";
  let clean = rawModel.trim().replace(/\[1m\]$/i, "");
  const colonIdx = clean.lastIndexOf(":");
  if (colonIdx > 0) {
    const suffix = clean.slice(colonIdx + 1).toLowerCase();
    if (["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"].includes(suffix)) {
      clean = clean.slice(0, colonIdx);
    }
  }
  if (aliases[clean]) return aliases[clean];
  const slashIdx = clean.indexOf("/");
  const unprefixed = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
  if (aliases[unprefixed]) return aliases[unprefixed];
  const lower = unprefixed.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  return unprefixed;
}

export function resolveModelSpec(rawModel, models = DEFAULT_MODELS, aliases = MODEL_ALIASES) {
  const name = canonicalModel(rawModel, aliases);
  if (models[name]) return { canonical: name, spec: models[name] };
  // Fuzzy family fallback for provider-specific model IDs
  const lower = name.toLowerCase();
  if (lower.includes("opus")) return { canonical: "claude-opus-5-5", spec: models["claude-opus-5-5"] };
  if (lower.includes("fable")) return { canonical: "claude-fable-5-1", spec: models["claude-fable-5-1"] };
  if (lower.includes("sonnet")) return { canonical: "claude-sonnet-5-5", spec: models["claude-sonnet-5-5"] };
  if (lower.includes("haiku")) return { canonical: "claude-haiku-5-5", spec: models["claude-haiku-5-5"] };
  if (lower.includes("argon") || (lower.includes("gemini") && (lower.includes("pro") || lower.includes("ultra")))) {
    return { canonical: "gemini-4-argon-high", spec: models["gemini-4-argon-high"] };
  }
  if (lower.includes("flash")) return { canonical: "gemini-3.8-flash-high", spec: models["gemini-3.8-flash-high"] };
  if (lower.includes("astra") || lower.includes("gpt-5.4") || lower.includes("gpt-6-pro")) {
    return { canonical: "gpt-6-astra", spec: models["gpt-6-astra"] };
  }
  if (lower.includes("terra")) return { canonical: "gpt-6.1-terra", spec: models["gpt-6.1-terra"] };
  if (lower.includes("luna") || lower.includes("mini")) return { canonical: "gpt-6-luna", spec: models["gpt-6-luna"] };
  if (lower.includes("sol") || lower.includes("codex")) return { canonical: "gpt-6.1-sol", spec: models["gpt-6.1-sol"] };
  if (lower.includes("grok")) return { canonical: "grok-4.7", spec: models["grok-4.7"] };
  if (lower.includes("deepseek")) return { canonical: "deepseek-v4.1-flash-free", spec: models["deepseek-v4.1-flash-free"] };
  return {
    canonical: name || "unknown",
    spec: {
      tier: 3.4,
      cost: 2,
      visual: 0.5,
      usd_per_hour: 3.0,
      efforts: ["low", "medium", "high"],
      capabilities: {
        reasoning: 0.65,
        coding: 0.65,
        exploration: 0.65,
        anti_hallucination: 0.65,
        visual: 0.5,
        gui: 0.4,
      },
      subjective: {
        divergence: 0.5,
        global_rigor: 0.5,
        module_precision: 0.5,
      },
    },
  };
}
