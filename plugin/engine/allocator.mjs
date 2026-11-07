// Vendored from akiiwa-games/magpie-agentcompass-router src/allocator.js at 34448f9e9b82a2506fbda7481371e55526757c14 (MIT), itself ported from AgentCompass.
// Only the import paths differ from the source; regenerate with scripts/vendor_engine.mjs rather than edit.
/**
 * AgentCompass Core Pure Intent & Multi-Dimensional Capability Allocator
 *
 * Exact port of the intent, capability vector, Model DNA (`divergence`, `global_rigor`,
 * `module_precision`), continuous `taskDemand`, `effortAbility`, ability floor, and
 * overqualification pricing algorithms from `skills/agent-compass/scripts/allocator.py`.
 *
 * Pure ES2022 module with zero external dependencies so it runs in both Bun (`magpie.hooks`
 * and `/v1/systemone` Decision Provider) and Magpie's in-process `moejs` (`magpie.middleware`).
 */

import {
  CANONICAL_ROUTES,
  CAPABILITY_DIMENSIONS,
  DEFAULT_MODELS,
  DEFAULT_SCORING_POLICY,
  DIFFICULTY_ORDER,
  DISPATCH_EFFORTS,
  EFFORT_CURVES,
  EFFORT_ORDER,
  EFFORT_RESPONSIVENESS,
  FLAT_EFFORT_CURVE,
  FLAT_EFFORT_CURVE_MODELS,
  KIND_TRAITS,
  MODEL_ALIASES,
  ROUTE_FIT_PEERS,
  SUBJECTIVE_DIMENSIONS,
  canonicalModel,
  resolveModelSpec,
  resolveResponsivenessModelKey,
} from "./catalog.mjs";
import { inferTaskProfile, validateProfile } from "./profiler.mjs";
import { evaluateModelQuota, normalizeQuotaSnapshot } from "./quota.mjs";

export const EFFORT_SCALED_CAPABILITIES = [
  "reasoning",
  "coding",
  "exploration",
  "anti_hallucination",
];

export const SUBJECTIVE_DIVERGENCE_SHARE = 0.4;

export function clamp(val, low, high) {
  return Math.max(low, Math.min(high, val));
}

export function round4(val) {
  return Math.round(val * 10000) / 10000;
}

export function round3(val) {
  return Math.round(val * 1000) / 1000;
}

export function profileDifficulty(profile, policy = DEFAULT_SCORING_POLICY) {
  const table = policy?.profile?.difficulty_by_depth || {};
  const depth = profile?.reasoning_depth || 2;
  return table[depth] || table[String(depth)] || { 1: "routine", 2: "hard", 3: "coupled", 4: "frontier" }[depth] || "hard";
}

export function namedRoute(profile) {
  if (!profile || typeof profile !== "object") return null;
  const named = profile.work_kind;
  if (named && named in KIND_TRAITS && named !== "other_or_mixed") return named;
  return null;
}

export function profileKind(profile, policy = DEFAULT_SCORING_POLICY) {
  const named = namedRoute(profile);
  if (named) return named;
  if (profile.needs_gui) return "computer_use";
  if (profile.needs_visual && profile.code_complexity === 0 && profile.interaction_style !== "text_only") {
    return "visual_analysis";
  }
  if (profile.interaction_style === "engineering" && profile.code_complexity === 0) {
    return "tool_execution";
  }
  return policy?.profile?.kind_by_style?.[profile.interaction_style] || "other_or_mixed";
}

/**
 * One effort's ability delta or burn (`allocator.py:effort_value`), plus two plugin-side fallbacks AgentCompass
 * doesn't have: `ultra` without its own calibration reads as the model's Max, and `none`/`off`/`minimal` sit
 * below the model's own Low rather than at the policy table's generic value. Upstream scores both at High.
 */
export function effortValue(policy, curves, name, effort, fallback) {
  const own = curves?.[name] || {};
  if (effort in own) return own[effort];
  if (effort === "ultra" && "max" in own) return own.max;
  const policyTable = policy?.[`effort_${name}`] || {};
  if ((effort === "minimal" || effort === "none" || effort === "off") && "low" in own) {
    if (name === "ability") {
      const delta = (policyTable[effort] ?? -1.0) - (policyTable.low ?? -0.54);
      return own.low + Math.min(delta, -0.2);
    }
    if (name === "burn") {
      const ratio = (policyTable[effort] ?? 0.12) / (policyTable.low || 0.2);
      return round4(own.low * Math.min(ratio, 0.75));
    }
  }
  if (effort in policyTable) return policyTable[effort];
  if (effort === "ultra" && "max" in policyTable) return policyTable.max;
  return fallback;
}

/**
 * The model's effective tier at one effort level (`allocator.py:effort_ability`).
 */
export function effortAbility(policy, curves, info, effort = "high") {
  const tier = Number(info?.tier || 0);
  const mult = curves?.ability_mult || {};
  if (effort in mult) {
    return tier * Number(mult[effort]);
  }
  return tier + effortValue(policy, curves, "ability", effort, 0);
}

/**
 * Relative burn scale of `effort` compared to `high` (`allocator.py:burn_scale`).
 */
export function burnScale(policy, curves, effort = "high") {
  const mult = curves?.burn_mult || {};
  if (effort in mult) return Number(mult[effort]);
  const ref = effortValue(policy, curves, "burn", "high", 0.7);
  return effortValue(policy, curves, "burn", effort, ref) / (ref || 1.0);
}

export function capabilityVector(info) {
  const raw = info?.capabilities || {};
  const legacyVisual = typeof info?.visual === "number" ? info.visual : 0.0;
  const out = {};
  for (const dim of CAPABILITY_DIMENSIONS) {
    let val = raw[dim];
    if (dim === "visual" && val === undefined) {
      val = legacyVisual;
    }
    out[dim] = clamp(Number(val || 0.0), 0.0, 1.0);
  }
  return out;
}

export function capabilityScore(weights, model, catalog = {}) {
  const { spec } = resolveModelSpec(model, catalog.models, catalog.aliases);
  const caps = capabilityVector(spec);
  let total = 0;
  let sum = 0;
  for (const [dim, w] of Object.entries(weights || {})) {
    if (dim in caps) {
      total += w;
      sum += w * caps[dim];
    }
  }
  return total > 0 ? sum / total : 0.0;
}

/**
 * Collapse models that share a route-fit slot (`allocator.py:route_preference`).
 */
export function routePreference(preferred = [], peers = ROUTE_FIT_PEERS, aliases = MODEL_ALIASES) {
  const collapsed = [];
  for (const rawItem of preferred) {
    const item = canonicalModel(rawItem, aliases);
    const target = peers?.[item] ? canonicalModel(peers[item], aliases) : item;
    if (!collapsed.includes(target)) {
      collapsed.push(target);
    }
  }
  return collapsed;
}

/**
 * Route preference score (`allocator.py:fit_score`).
 */
export function fitScore(kind, model, catalog = {}, options = {}) {
  const routes = catalog.routes || CANONICAL_ROUTES;
  const policy = catalog.policy || DEFAULT_SCORING_POLICY;
  const peers = catalog.routeFitPeers || ROUTE_FIT_PEERS;
  const route = routes[kind] || {};
  const rawCanonical = canonicalModel(model, catalog.aliases);
  const canonical = peers?.[rawCanonical]
    ? canonicalModel(peers[rawCanonical], catalog.aliases)
    : rawCanonical;
  let preferred = routePreference(route.preferred || [], peers, catalog.aliases);
  if (
    preferred[0] === "dot" &&
    (options.local_only || (options.dotAvailable === false && canonical !== "dot"))
  ) {
    preferred = preferred.slice(1);
  }

  if (preferred.length === 0 && !route.capability_fit) {
    return 0.6;
  }
  const place = preferred.indexOf(canonical);
  if (place === -1 && route.capability_fit) {
    return round4(0.2 + 0.5 * capabilityScore(route.capability_fit, rawCanonical, catalog));
  }
  if (route.strict_order) {
    if (place === -1) return 0.3;
    const step = preferred.length <= 5 ? 0.2 : 0.8 / (preferred.length - 1);
    return Math.max(0.2, round4(1 - step * place));
  }
  if (place === 0) return 1.0;
  const band = policy.fallback_fit || { start: 0.6, step: 0.015, floor: 0.4 };
  if (place === -1) return band.floor;
  return Math.max(band.floor, round4(band.start - band.step * (place - 1)));
}

/**
 * The minimum ability a route's work needs at a difficulty (`allocator.py:ability_floor`).
 */
export function abilityFloor(policy = DEFAULT_SCORING_POLICY, route = null, difficulty = "hard") {
  const own = route?.ability_floor || {};
  return difficulty in own ? Number(own[difficulty]) : Number(policy.ability_floor?.[difficulty] ?? 3.0);
}

/**
 * Extra ability critical work needs above the difficulty's floor (`allocator.py:critical_headroom`).
 */
export function criticalHeadroom(policy = DEFAULT_SCORING_POLICY, difficulty = "hard") {
  const own = policy?.critical_headroom_by_difficulty || {};
  return difficulty in own ? Number(own[difficulty]) : Number(policy?.critical_headroom ?? 0.3);
}

/**
 * Continuous task ability demand (`allocator.py:task_demand`).
 */
export function taskDemand(
  profile,
  difficulty,
  critical,
  divergence,
  policy = DEFAULT_SCORING_POLICY,
  highPrecision = false,
  floorOverride = null,
) {
  const cfg = policy.demand || DEFAULT_SCORING_POLICY.demand;
  const floor =
    floorOverride === null || floorOverride === undefined
      ? Number(policy.ability_floor?.[difficulty] ?? 3.3)
      : Number(floorOverride);
  const headroom = critical ? criticalHeadroom(policy, difficulty) : 0.0;
  const precision = highPrecision && !critical ? Number(cfg.precision_headroom ?? 0.15) : 0.0;
  const span = Number(policy.profile?.saturation_span ?? 0.3);

  let depth = 2;
  let load = Number(cfg.default_load ?? 0.5);
  let levels = {};
  let source = "difficulty";

  if (profile) {
    depth = profile.reasoning_depth;
    levels = {
      code_complexity: profile.code_complexity / 3.0,
      context_scale: (profile.context_scale - 1) / 2.0,
      divergence: (divergence - 1) / 2.0,
      hallucination_risk: (profile.hallucination_risk - 1) / 2.0,
      error_cost: Math.min(profile.error_cost, 2) - 1,
    };
    const weights = cfg.property_weights || DEFAULT_SCORING_POLICY.demand.property_weights;
    let totalW = 0;
    let weightedSum = 0;
    for (const [k, v] of Object.entries(levels)) {
      const w = Number(weights[k] || 0);
      totalW += w;
      weightedSum += w * v;
    }
    load = totalW > 0 ? weightedSum / totalW : 0.0;
    source = "profile";
  } else {
    const idx = DIFFICULTY_ORDER.indexOf(difficulty);
    depth = idx >= 0 ? idx + 1 : 2;
  }

  const extra = Number(cfg.property_span ?? 0.5) * (depth / 4.0) * load;
  const required = floor + headroom + precision + extra;
  return {
    required_ability: round4(required),
    floor,
    critical_headroom: headroom,
    precision_headroom: precision,
    property_extra: round4(extra),
    reasoning_depth: depth,
    property_load: round4(load),
    saturation_span: span,
    saturates_at: round4(required + span),
    source,
  };
}

export function effortScaledCapabilities(info, policy, curves, effort) {
  const caps = capabilityVector(info);
  const base = effortAbility(policy, curves, info, "high");
  const ratio = base > 0 ? effortAbility(policy, curves, info, effort) / base : 1.0;
  const out = {};
  for (const [dim, val] of Object.entries(caps)) {
    out[dim] = EFFORT_SCALED_CAPABILITIES.includes(dim) ? clamp(val * ratio, 0.0, 1.0) : val;
  }
  return out;
}

export function profileRequirements(profile, policy = DEFAULT_SCORING_POLICY) {
  const cfg = policy.profile || DEFAULT_SCORING_POLICY.profile;
  const table = cfg.requirements;
  const weights = cfg.requirement_weights || {};
  const depthCoupling = Number(policy.demand?.depth_coupling ?? 0.06);
  const amp = 1.0 + depthCoupling * (profile.reasoning_depth - 2);
  const need = (level) => round4(Math.min(0.98, Number(level) * amp));

  const out = {
    reasoning: [table.reasoning[profile.reasoning_depth], weights.reasoning ?? 1.0],
  };
  if (profile.code_complexity > 0) {
    out.coding = [need(table.coding[profile.code_complexity]), weights.coding ?? 1.0];
  }
  const exploreKey = profile.interaction_style === "exploration" ? "exploration_style" : "exploration";
  out.exploration = [need(table.exploration[profile.context_scale]), weights[exploreKey] ?? 0.5];
  const riskKey = profile.hallucination_risk >= 3 ? "anti_hallucination_high" : "anti_hallucination";
  out.anti_hallucination = [need(table.anti_hallucination[profile.hallucination_risk]), weights[riskKey] ?? 0.5];
  if (profile.needs_visual || profile.needs_gui) {
    out.visual = [table.visual, weights.visual ?? 1.0];
  }
  if (profile.needs_gui) {
    out.gui = [table.gui[profile.reasoning_depth], weights.gui ?? 1.5];
  }
  return out;
}

export function vectorFit(requirements, caps) {
  let totalW = 0;
  let sum = 0;
  for (const [dim, [need, weight]] of Object.entries(requirements)) {
    totalW += weight;
    sum += weight * (need <= 0 ? 1.0 : Math.min(1.0, (caps[dim] ?? 0.0) / need));
  }
  return totalW > 0 ? sum / totalW : 1.0;
}

export function subjectiveVector(info) {
  const raw = info?.subjective || {};
  const out = {};
  for (const dim of SUBJECTIVE_DIMENSIONS) {
    out[dim] = clamp(Number(raw[dim] ?? 0.5), 0.0, 1.0);
  }
  return out;
}

export function convergentWeights(depth, code, scale, style) {
  let g;
  if (code === 3 || scale === 3 || (depth >= 3 && scale >= 2)) {
    g = 0.85;
  } else if (depth >= 3 || code === 0) {
    g = scale >= 2 ? 0.75 : 0.65;
  } else if (code >= 1 && style !== "exploration") {
    g = scale >= 2 ? 0.25 : 0.0;
  } else {
    g = scale >= 2 ? 0.65 : 0.5;
  }
  const out = {};
  const mp = Math.round((1 - g) * 100) / 100;
  if (mp > 0) out.module_precision = mp;
  if (g > 0) out.global_rigor = g;
  return out;
}

export function subjectiveWeights(profile, kind = null) {
  if (!profile || typeof profile !== "object") return {};
  const depth = profile.reasoning_depth;
  const code = profile.code_complexity;
  const scale = profile.context_scale;
  const style = profile.interaction_style;
  const isGui = kind === "computer_use" || Boolean(profile.needs_gui);
  const div = isGui ? Math.min(profile.divergence || 1, 2) : profile.divergence || 1;

  if (depth === 1 && div === 1 && scale <= 2 && code <= 2) {
    return {};
  }
  if (div >= 3 || kind === "direction_reasoning") {
    const g = scale >= 2 ? 0.15 : 0.05;
    return { divergence: Math.round((1 - g) * 100) / 100, global_rigor: g };
  }
  if (kind === "frontend_implementation") {
    return { global_rigor: 0.65, divergence: 0.35 };
  }
  let base = convergentWeights(depth, isGui ? 0 : code, scale, style);
  if (div === 2 || kind === "complex_build_plan") {
    const g = Math.max(0.75, base.global_rigor || 0.0);
    base = {};
    const mp = Math.round((1 - g) * 100) / 100;
    if (mp > 0) base.module_precision = mp;
    if (g > 0) base.global_rigor = g;
    const share = SUBJECTIVE_DIVERGENCE_SHARE;
    const out = { divergence: share };
    for (const [k, v] of Object.entries(base)) {
      out[k] = round3(v * (1 - share));
    }
    return out;
  }
  return base;
}

export function subjectiveFit(weights, subj) {
  let totalW = 0;
  let sum = 0;
  for (const [dim, w] of Object.entries(weights || {})) {
    totalW += w;
    sum += w * (subj[dim] ?? 0.5);
  }
  return totalW > 0 ? sum / totalW : 1.0;
}

export const RESPONSIVENESS_DEFAULTS = {
  floor: 0.5,
  default: 0.52,
  weight: 0.35,
  fast_turn_seconds: 4.0,
  slow_turn_seconds: 45.0,
  output_tokens_per_turn: 400,
  harness_overhead: {
    default: 1.0,
    antigravity: 1.0,
    "antigravity-resilient": 1.0,
    codex: 1.0,
    claude: 1.0,
    pi: 1.0,
    opencode: 1.0,
    grok: 1.0,
  },
  local_telemetry: {
    min_samples: 20,
    max_blend: 0.3,
    max_shift: 0.15,
  },
};

export const REALTIME_EFFORT_ORDER = [
  "none",
  "off",
  "minimal",
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function effortRank(effort) {
  const eff = String(effort || "high").trim().toLowerCase();
  const idx = REALTIME_EFFORT_ORDER.indexOf(eff);
  return idx >= 0 ? idx : REALTIME_EFFORT_ORDER.indexOf("high");
}

/**
 * Merged `scoring.responsiveness` policy with defaults (`allocator.py:responsiveness_config`).
 */
export function responsivenessConfig(policy = DEFAULT_SCORING_POLICY) {
  const cfg = {
    ...RESPONSIVENESS_DEFAULTS,
    harness_overhead: { ...RESPONSIVENESS_DEFAULTS.harness_overhead },
    local_telemetry: { ...RESPONSIVENESS_DEFAULTS.local_telemetry },
  };
  const own =
    policy && typeof policy === "object" && policy.responsiveness && typeof policy.responsiveness === "object"
      ? policy.responsiveness
      : {};
  for (const [key, value] of Object.entries(own)) {
    if ((key === "harness_overhead" || key === "local_telemetry") && value && typeof value === "object") {
      Object.assign(cfg[key], value);
    } else if (key in cfg || key === "basis" || key === "reasoning_tokens_by_effort") {
      cfg[key] = value;
    }
  }
  return cfg;
}

/**
 * Per-turn CLI harness overhead coefficient (`allocator.py:harness_overhead_multiplier`).
 */
export function harnessOverheadMultiplier(harness, policy = DEFAULT_SCORING_POLICY) {
  const table = responsivenessConfig(policy).harness_overhead || {};
  if (harness && typeof table[harness] === "number" && Number.isFinite(table[harness])) {
    return Math.max(0.1, Number(table[harness]));
  }
  const def = table.default;
  return Math.max(0.1, typeof def === "number" && Number.isFinite(def) ? Number(def) : 1.0);
}

/**
 * Estimated seconds per live-loop turn (`allocator.py:compute_turn_seconds`):
 * `T_turn = (ttft_s + output_tokens / output_tps) * harness_overhead`.
 */
export function computeTurnSeconds(
  ttftS,
  outputTps,
  effort = "high",
  reasoningTokens = null,
  outputTokens = null,
  harness = null,
  policy = DEFAULT_SCORING_POLICY,
) {
  void effort;
  void reasoningTokens;
  const cfg = responsivenessConfig(policy);
  const outTokens = outputTokens === null || outputTokens === undefined ? Number(cfg.output_tokens_per_turn ?? 400) : Number(outputTokens);
  const tps = Math.max(1e-6, Number(outputTps));
  const baseTurn = Math.max(0.0, Number(ttftS)) + Math.max(0.0, outTokens) / tps;
  return baseTurn * harnessOverheadMultiplier(harness, policy);
}

/**
 * Map per-turn duration in seconds onto 0..1 (`allocator.py:turn_seconds_to_responsiveness`).
 */
export function turnSecondsToResponsiveness(turnSeconds, policy = DEFAULT_SCORING_POLICY) {
  const cfg = responsivenessConfig(policy);
  const fast = Number(cfg.fast_turn_seconds ?? 4.0);
  const slow = Math.max(fast + 1e-6, Number(cfg.slow_turn_seconds ?? 45.0));
  return round4(clamp((slow - Number(turnSeconds)) / (slow - fast), 0.0, 1.0));
}

export function lookupCurveResponsiveness(curvesResp, effort, defaultEffort = "high") {
  if (!curvesResp || typeof curvesResp !== "object") return null;
  const eff = String(effort || defaultEffort || "high");
  if (eff in curvesResp) {
    const val = curvesResp[eff];
    if (typeof val === "number" && Number.isFinite(val)) {
      return clamp(val, 0.0, 1.0);
    }
  }
  const values = Object.values(curvesResp);
  if (values.length === 1) {
    const only = values[0];
    if (typeof only === "number" && Number.isFinite(only)) {
      return clamp(only, 0.0, 1.0);
    }
  }
  let fallbacks;
  if (["high", "xhigh", "max", "ultra"].includes(eff)) {
    fallbacks = ["high", "default", "max", "xhigh"];
  } else if (["none", "minimal", "low", "default"].includes(eff)) {
    fallbacks = ["low", "none", "default", "medium"];
  } else {
    fallbacks = ["medium", "low", "default", "none", "high"];
  }
  for (const fb of fallbacks) {
    if (fb in curvesResp) {
      const val = curvesResp[fb];
      if (typeof val === "number" && Number.isFinite(val)) {
        return clamp(val, 0.0, 1.0);
      }
    }
  }
  return null;
}

/**
 * Split an effort suffix encoded directly in a model ID (`auto_bundles.py:split_effort`).
 */
export function splitEffortFromModelId(rawModel, models = DEFAULT_MODELS, aliases = MODEL_ALIASES) {
  const raw = String(rawModel || "").trim();
  const baseNoBracket = raw.replace(/\[1m\]$/i, "");
  const match = baseNoBracket.match(/^(.+)-(low|medium|high|xhigh|max)$/i);
  if (!match) {
    return { base: raw, effort: null };
  }
  const base = match[1];
  const effort = match[2].toLowerCase();
  const baseLeaf = base.split("/").pop();
  if (
    effort === "max" &&
    !(base in (models || {})) &&
    !(baseLeaf in (models || {})) &&
    !(base in (aliases || {})) &&
    !(baseLeaf in (aliases || {}))
  ) {
    return { base: raw, effort: null };
  }
  return { base, effort };
}

export function bundleHarness(bundle, account = null, bundleId = null) {
  const explicit = String(bundle?.harness || "").trim().toLowerCase();
  if (explicit) return explicit;
  const prov = String(bundle?.provider || account || "").trim().toLowerCase();
  const bid = String(bundleId || bundle?.id || "").trim().toLowerCase();
  const launchM = String(bundle?.launch_model || "").trim().toLowerCase();
  const model = String(bundle?.model || "").trim().toLowerCase();
  const modelLeaf = model.replace(/\[1m\]$/i, "").split("/").pop();
  if (
    [
      "claude",
      "codex",
      "pi",
      "omp",
      "opencode",
      "grok",
      "grok-bot",
      "antigravity",
      "antigravity-resilient",
    ].includes(prov)
  ) {
    return prov === "antigravity" ? "antigravity-resilient" : prov;
  }
  if (bid.startsWith("pi_") || bid.includes("__pi_") || launchM.startsWith("openai-codex/")) {
    return "pi";
  }
  if (launchM.startsWith("opencode/")) {
    return "opencode";
  }
  if (prov === "dot" || prov === "chatgpt-web") {
    return prov;
  }
  if (prov) {
    return model.includes("claude") ? "claude" : "codex";
  }
  // No provider to go by (a bare candidate): the model family decides which dispatch table applies.
  const leafKey = resolveResponsivenessModelKey(modelLeaf).key.toLowerCase();
  const leafOrKey = (test) => test(modelLeaf) || test(leafKey);
  if (model.startsWith("opencode/") || leafOrKey((m) => m.includes("deepseek-v4.1-flash-free"))) {
    return "opencode";
  }
  if (leafOrKey((m) => m === "dot")) {
    return "dot";
  }
  if (leafOrKey((m) => m.startsWith("grok-bot"))) {
    return "grok-bot";
  }
  if (leafOrKey((m) => m.startsWith("grok-"))) {
    return "grok";
  }
  if (leafOrKey((m) => m.startsWith("gemini-"))) {
    return "antigravity-resilient";
  }
  if (leafOrKey((m) => m === "glm-5.2")) {
    return "omp";
  }
  if (leafOrKey((m) => m.includes("claude"))) {
    return "claude";
  }
  return "codex";
}

export function scoringEffort(bundle, info) {
  const raw = bundle?.effort || info?.fixed_effort || info?.default_effort || "high";
  return String(raw).trim().toLowerCase() || "high";
}

export function bundleApplies(bundle, taskCtx = {}) {
  const rule = bundle?.when;
  if (!rule || typeof rule !== "object") return true;
  const pinnedId =
    taskCtx?.pinned_bundle ||
    taskCtx?.pinnedBundle ||
    taskCtx?.constraint_bundle ||
    taskCtx?.constraintBundle ||
    taskCtx?.constraints?.bundle;
  if (pinnedId && bundle?.id && pinnedId === bundle.id) {
    return true;
  }
  if ("max_reasoning_depth" in rule) {
    const depth = taskCtx?.profile?.reasoning_depth;
    if (!Number.isFinite(depth) || depth > Number(rule.max_reasoning_depth)) {
      return false;
    }
  }
  if ("min_difficulty" in rule) {
    const diff = taskCtx?.difficulty;
    const req = rule.min_difficulty;
    if (
      DIFFICULTY_ORDER.includes(diff) &&
      DIFFICULTY_ORDER.includes(req) &&
      DIFFICULTY_ORDER.indexOf(diff) < DIFFICULTY_ORDER.indexOf(req)
    ) {
      return false;
    }
  }
  return true;
}

export function bundleCooldownReason(bundle, launchFailures, nowMs = Date.now()) {
  if (!launchFailures || typeof launchFailures !== "object") return null;
  const entries = launchFailures.entries && typeof launchFailures.entries === "object" ? launchFailures.entries : launchFailures;
  const account = bundle?.account || bundle?.provider;
  if (!account) return null;
  const keys = [String(account), bundle?.model ? `${account}/${bundle.model}` : null].filter(Boolean);
  for (const k of keys) {
    const entry = entries[k];
    if (!entry || typeof entry !== "object") continue;
    const untilMs = entry.until ? Date.parse(String(entry.until)) : NaN;
    if (Number.isFinite(untilMs) && untilMs <= nowMs) continue;
    const left = Number.isFinite(untilMs) ? Math.max(1, Math.round((untilMs - nowMs) / 60000)) : 15;
    const scope = k === String(account) ? "account" : "model";
    return `host refused to create a worker on this ${scope} (${entry.failure_class || "unknown"}); cooling down ${left} more min, then reroute`;
  }
  return null;
}

const KNOWN_EFFORT_SUFFIXES = [
  "none",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "auto",
  "default",
];

function splitPinModelAndEffort(normConstraint) {
  const colonIdx = normConstraint.lastIndexOf(":");
  if (colonIdx > 0) {
    const suffix = normConstraint.slice(colonIdx + 1).trim().toLowerCase();
    if (KNOWN_EFFORT_SUFFIXES.includes(suffix)) {
      return { modelPart: normConstraint.slice(0, colonIdx).trim(), effortPart: suffix };
    }
  }
  return { modelPart: normConstraint, effortPart: null };
}

/**
 * Whether a pinned model names this candidate. Identity is the responsiveness key, as `allocator.py` compares
 * `canonical()` of both sides: `claude-opus-4-6` and `claude-opus-5-5` are different models here even though routing
 * folds one into the other.
 */
function matchesPinnedModel(bundle, computedId, normConstraint, modelPart, taskCtx) {
  const rawModel = bundle?.model;
  const rawLeaf = rawModel ? String(rawModel).split("/").pop() : rawModel;
  const bid = bundle?.id;
  if (
    normConstraint === bid ||
    normConstraint === computedId ||
    modelPart === bid ||
    modelPart === rawModel ||
    modelPart === rawLeaf
  ) {
    return true;
  }
  const models = taskCtx.models || DEFAULT_MODELS;
  const aliases = taskCtx.aliases || MODEL_ALIASES;
  const wanted = resolveResponsivenessModelKey(modelPart, models, aliases).key;
  if (!wanted) return false;
  return wanted === bid || wanted === resolveResponsivenessModelKey(rawModel, models, aliases).key;
}

/**
 * Whether the user pinned this `realtime_loop` candidate; a pin keeps it from stepping down or being excluded.
 * Pin options have no effect on non-realtime routing.
 */
export function isCandidatePinned(bundle, canonical, taskCtx = {}) {
  if (!taskCtx || typeof taskCtx !== "object") return false;
  const bid = bundle?.id;
  const rawModel = bundle?.model;
  const candEff = String(bundle?.effort || "high").trim().toLowerCase();
  const computedId = rawModel ? `${rawModel}:${candEff}` : null;
  const pinnedBundle = taskCtx.pinned_bundle || taskCtx.pinnedBundle;
  const constraintBundle = taskCtx.constraint_bundle || taskCtx.constraintBundle || taskCtx.constraints?.bundle;
  const constraintModel =
    taskCtx.constraint_model ||
    taskCtx.constraintModel ||
    taskCtx.pinned_model ||
    taskCtx.pinnedModel ||
    taskCtx.constraints?.model;
  const constraintEffort =
    taskCtx.constraint_effort ||
    taskCtx.constraintEffort ||
    taskCtx.pinned_effort ||
    taskCtx.pinnedEffort ||
    taskCtx.constraints?.effort;
  if (
    (bid && (pinnedBundle === bid || constraintBundle === bid)) ||
    (computedId && (pinnedBundle === computedId || constraintBundle === computedId))
  ) {
    return true;
  }
  if (constraintModel) {
    const normConstraint = String(constraintModel).trim();
    const { modelPart, effortPart } = splitPinModelAndEffort(normConstraint);
    const candidate = rawModel ? bundle : { ...bundle, model: canonical };
    if (matchesPinnedModel(candidate, computedId, normConstraint, modelPart, taskCtx)) {
      if (!effortPart && !constraintEffort) return true;
      const normConstraintEff = constraintEffort ? String(constraintEffort).trim().toLowerCase() : null;
      if ((!effortPart || effortPart === candEff) && (!normConstraintEff || normConstraintEff === candEff)) {
        return true;
      }
      return false;
    }
  }
  return false;
}

/**
 * Effort curves a `realtime_loop` task reads: `accounts.json` `effort_curves` of the responsiveness key, not of the routing
 * canonical. A name with no calibrated row has no speed data, and scores on the curve of the family routing puts it in.
 */
export function resolveRealtimeCurves(rawModel, canonical, catalog = {}) {
  const models = catalog.models || DEFAULT_MODELS;
  const aliases = catalog.aliases || MODEL_ALIASES;
  const curvesTable = catalog.effortCurves || EFFORT_CURVES;
  const respTable = catalog.effortResponsiveness || EFFORT_RESPONSIVENESS;
  const { key, known } = resolveResponsivenessModelKey(rawModel || canonical, models, aliases, curvesTable, respTable);
  if (!known) {
    const { responsiveness: _unmeasured, ...scoring } = curvesTable?.[canonical] || {};
    return scoring;
  }
  const own = curvesTable?.[key];
  const flat = FLAT_EFFORT_CURVE_MODELS.includes(key) ? FLAT_EFFORT_CURVE : null;
  const resp = own?.responsiveness || respTable?.[key];
  return { ...flat, ...own, ...(resp ? { responsiveness: resp } : {}) };
}

function attachTupleIterator(obj, tupleValues) {
  Object.defineProperty(obj, Symbol.iterator, {
    value: function* () {
      yield* tupleValues;
    },
    enumerable: false,
    configurable: true,
  });
  return obj;
}

/**
 * Resolve `(responsiveness, source)` for a `(bundle, effort)` on `0..1` (`allocator.py:bundle_responsiveness`).
 * `source` is `'measured'`, `'local_blended'`, `'default'`, or `'not_applicable'`.
 * Returns `{ value, source }` (also iterable as `[value, source]`).
 */
export function bundleResponsiveness(
  bundle,
  info = null,
  policy = DEFAULT_SCORING_POLICY,
  curves = null,
  options = {},
) {
  const cfg = responsivenessConfig(policy);
  const rawModel = bundle?.model || bundle?.canonicalModel || "";
  const models = options.models || DEFAULT_MODELS;
  const aliases = options.aliases || MODEL_ALIASES;
  const { key, known } = resolveResponsivenessModelKey(
    rawModel,
    models,
    aliases,
    options.effortCurves || EFFORT_CURVES,
    options.effortResponsiveness || EFFORT_RESPONSIVENESS,
  );
  const givenSpec = info && typeof info === "object" && "spec" in info && info.spec ? info.spec : info;
  // The row routing folds this name into is not its speed data; only a row the caller supplied is.
  const routingSpec = resolveModelSpec(rawModel, models, aliases).spec;
  const spec = givenSpec && givenSpec !== routingSpec ? givenSpec : (known && models[key]) || {};
  const canonical = key;

  const status = spec.responsiveness_status;
  const rawResp = spec.responsiveness;
  if (rawResp === "not_applicable" || status === "not_applicable") {
    return attachTupleIterator({ value: null, source: "not_applicable" }, [null, "not_applicable"]);
  }

  const eff = String(options.effort || scoringEffort(bundle, spec) || "high");
  const defaultEff = String(spec.default_effort || spec.fixed_effort || "high");

  let effectiveCurves = curves;
  if (!effectiveCurves || !effectiveCurves.responsiveness) {
    const resolvedCurves = resolveRealtimeCurves(rawModel, canonicalModel(rawModel, aliases), {
      models,
      aliases,
      effortCurves: options.effortCurves,
      effortResponsiveness: options.effortResponsiveness,
    });
    effectiveCurves = effectiveCurves
      ? { ...resolvedCurves, ...effectiveCurves, responsiveness: effectiveCurves.responsiveness || resolvedCurves.responsiveness }
      : resolvedCurves;
  }

  const curvesResp = effectiveCurves && typeof effectiveCurves === "object" ? effectiveCurves.responsiveness : null;
  let base = lookupCurveResponsiveness(curvesResp, eff, defaultEff);

  if (base === null) {
    if (rawResp && typeof rawResp === "object") {
      base = lookupCurveResponsiveness(rawResp, eff, defaultEff);
    } else if (typeof rawResp === "number" && Number.isFinite(rawResp)) {
      if (!spec.score_estimated && eff === defaultEff) {
        base = clamp(Number(rawResp), 0.0, 1.0);
      }
    }
  }

  if (base === null) {
    const metrics = spec.speed_metrics && typeof spec.speed_metrics === "object" ? spec.speed_metrics : {};
    const ttft = metrics.ttft_s;
    const tps = metrics.output_tps;
    if (typeof ttft === "number" && Number.isFinite(ttft) && typeof tps === "number" && Number.isFinite(tps) && tps > 0 && eff === defaultEff) {
      const effHarness = options.harness || bundle?.harness || bundleHarness(bundle, bundle?.account, bundle?.id);
      const turnS = computeTurnSeconds(ttft, tps, eff, metrics.reasoning_tokens, null, effHarness, policy);
      base = turnSecondsToResponsiveness(turnS, policy);
    }
  }

  let source = "measured";
  if (base === null) {
    base = clamp(Number(cfg.default ?? 0.52), 0.0, 1.0);
    source = "default";
  }

  // Optional local telemetry shrinkage when supplied in `options.localTelemetry`
  const telemetryDoc = options.localTelemetry;
  if (telemetryDoc && typeof telemetryDoc === "object" && canonical) {
    const modelsMap = telemetryDoc.models && typeof telemetryDoc.models === "object" ? telemetryDoc.models : telemetryDoc;
    const row = modelsMap[canonical] || modelsMap[rawModel];
    if (row && typeof row === "object") {
      const target = row.by_effort && typeof row.by_effort[eff] === "object" ? row.by_effort[eff] : row;
      const samples = Number(target.samples ?? 0);
      const telCfg = cfg.local_telemetry || {};
      const minSamples = Math.max(1, Number(telCfg.min_samples ?? 20));
      if (Number.isFinite(samples) && samples >= minSamples) {
        let localResp = target.responsiveness;
        if (typeof localResp !== "number" || !Number.isFinite(localResp)) {
          const turnS = target.median_turn_seconds ?? target.turn_seconds;
          if (typeof turnS === "number" && Number.isFinite(turnS)) {
            localResp = turnSecondsToResponsiveness(turnS, policy);
          }
        }
        if (typeof localResp === "number" && Number.isFinite(localResp)) {
          localResp = clamp(localResp, 0.0, 1.0);
          const maxBlend = clamp(Number(telCfg.max_blend ?? 0.3), 0.0, 1.0);
          const maxShift = clamp(Number(telCfg.max_shift ?? 0.15), 0.0, 1.0);
          const blend = Math.min(maxBlend, maxBlend * Math.min(1.0, samples / (minSamples * 2)));
          const delta = clamp(blend * (localResp - base), -maxShift, maxShift);
          base = round4(clamp(base + delta, 0.0, 1.0));
          source = "local_blended";
        }
      }
    }
  }

  const finalVal = round4(base);
  return attachTupleIterator({ value: finalVal, source }, [finalVal, source]);
}

/**
 * Efforts `dispatch_efforts` allows this bundle, or `null` when no row covers it. An explicit provider reads its own table
 * (`allocator.py:resolve_realtime_effort`); a bare candidate has none, so it reads the table of its inferred harness.
 */
function dispatchAllowedEfforts(
  bundle,
  provider,
  harness,
  canonical,
  models,
  aliases,
  dispatchEffortsTable,
  curvesTable,
  respTable,
) {
  const owner = provider || harness;
  const table = owner && dispatchEffortsTable && typeof dispatchEffortsTable[owner] === "object" ? dispatchEffortsTable[owner] : null;
  if (!table) return null;
  const rawModel = bundle?.model || canonical;
  const { key } = resolveResponsivenessModelKey(rawModel, models, aliases, curvesTable, respTable);
  return table[rawModel] || table[key] || null;
}

/**
 * When `realtime_loop` is active and a bundle's default effort is below the responsiveness floor,
 * step down to the highest faster effort in the model's curve that clears both the ability gate (`gate`)
 * and `responsiveness.floor` (`allocator.py:resolve_realtime_effort`).
 *
 * Supports both JS signature `resolveRealtimeEffort(bundle, taskCtx, catalog, context)` and
 * Python-style signature `resolveRealtimeEffort(bundle, task, ctx, model, info, policy, curves, gate)`.
 * Returns `{ effort, responsiveness, source, steppedFrom }` (also iterable as `[effort, responsiveness, source, steppedFrom]`).
 */
export function resolveRealtimeEffort(
  bundle,
  taskCtx = {},
  catalogOrCtx = {},
  modelOrContext = {},
  infoArg = null,
  policyArg = null,
  curvesArg = null,
  gateArg = null,
) {
  let catalog = {};
  let ctx = {};
  let canonical = null;
  let info = null;
  let policy = null;
  let curves = null;
  let gate = 0.0;

  if (typeof modelOrContext === "string" || policyArg !== null || curvesArg !== null || gateArg !== null) {
    // Called with Python 8-arg signature: (bundle, task, ctx, modelOrPolicy, info, policy, curves, gate)
    ctx = catalogOrCtx || {};
    const accounts = ctx.accounts || {};
    const modelsMap = accounts.models || DEFAULT_MODELS;
    const aliasesMap = accounts.aliases || MODEL_ALIASES;
    const resolved = resolveModelSpec(bundle?.model || "", modelsMap, aliasesMap);
    const curveCatalog = {
      models: modelsMap,
      aliases: aliasesMap,
      effortCurves: accounts.effort_curves || EFFORT_CURVES,
      effortResponsiveness: accounts.effort_responsiveness || EFFORT_RESPONSIVENESS,
    };
    if (infoArg === null && policyArg === null && curvesArg === null && typeof modelOrContext === "object") {
      policy = modelOrContext || DEFAULT_SCORING_POLICY;
      canonical = resolved.canonical;
      info = modelsMap?.[canonical] || resolved.spec || {};
      curves = resolveRealtimeCurves(bundle?.model || canonical, canonical, curveCatalog);
    } else {
      canonical = String(modelOrContext || resolved.canonical);
      info = infoArg || modelsMap?.[canonical] || resolved.spec || {};
      policy = policyArg || ctx.policy || accounts.scoring || DEFAULT_SCORING_POLICY;
      const baseResolvedCurves = resolveRealtimeCurves(bundle?.model || canonical, canonical, curveCatalog);
      curves = curvesArg
        ? { ...baseResolvedCurves, ...curvesArg, responsiveness: curvesArg.responsiveness || baseResolvedCurves.responsiveness }
        : baseResolvedCurves;
    }
    const route = (ctx.capabilities?.routes || CANONICAL_ROUTES)?.[taskCtx?.kind || "other_or_mixed"] || {};
    const floor = taskCtx?.demand?.floor ?? abilityFloor(policy, route, taskCtx?.difficulty || "hard");
    const headroom = taskCtx?.critical ? criticalHeadroom(policy, taskCtx?.difficulty || "hard") : 0.0;
    gate = gateArg !== null && gateArg !== undefined ? Number(gateArg) : floor + headroom;
    catalog = {
      models: modelsMap,
      aliases: aliasesMap,
      policy,
      effortCurves: accounts.effort_curves || EFFORT_CURVES,
      effortResponsiveness: accounts.effort_responsiveness || EFFORT_RESPONSIVENESS,
      dispatchEfforts: accounts.dispatch_efforts || DISPATCH_EFFORTS,
    };
  } else {
    catalog = catalogOrCtx || {};
    ctx = modelOrContext || {};
    const models = catalog.models || DEFAULT_MODELS;
    const aliases = catalog.aliases || MODEL_ALIASES;
    policy = ctx.policy || catalog.policy || DEFAULT_SCORING_POLICY;
    const resolved = ctx.info
      ? { canonical: ctx.canonical || canonicalModel(bundle?.model || "", aliases), spec: ctx.info }
      : resolveModelSpec(bundle?.model || "", models, aliases);
    canonical = resolved.canonical;
    info = resolved.spec || {};
    const resolvedCurves = resolveRealtimeCurves(bundle?.model || "", canonical, catalog);
    curves = ctx.curves
      ? { ...resolvedCurves, ...ctx.curves, responsiveness: ctx.curves.responsiveness ?? resolvedCurves.responsiveness }
      : resolvedCurves;
    const routes = catalog.routes || CANONICAL_ROUTES;
    const route = routes[taskCtx?.kind || "other_or_mixed"] || {};
    const floor = taskCtx?.demand?.floor ?? abilityFloor(policy, route, taskCtx?.difficulty || "hard");
    const headroom = taskCtx?.critical ? criticalHeadroom(policy, taskCtx?.difficulty || "hard") : 0.0;
    gate = ctx.gate !== undefined && ctx.gate !== null ? Number(ctx.gate) : floor + headroom;
  }

  const models = catalog.models || DEFAULT_MODELS;
  const aliases = catalog.aliases || MODEL_ALIASES;
  const dispatchEffortsTable = catalog.dispatchEfforts || DISPATCH_EFFORTS;
  const hasExplicitEffort = Boolean(bundle?.effort || info?.fixed_effort || info?.default_effort);
  const rawEffort = scoringEffort(bundle, info);
  const effHarness = ctx.harness || bundle?.harness || bundleHarness(bundle, bundle?.account, bundle?.id);

  const initialResp = bundleResponsiveness(bundle, info, policy, curves, {
    effort: rawEffort,
    harness: effHarness,
    models,
    aliases,
    effortCurves: catalog.effortCurves,
    effortResponsiveness: catalog.effortResponsiveness,
    localTelemetry: ctx.localTelemetry || taskCtx?.localTelemetry,
  });
  const respVal = initialResp.value;
  const respSource = initialResp.source;

  const makeReturn = (eff, rVal, rSrc, steppedFrom) =>
    attachTupleIterator(
      { effort: eff, responsiveness: rVal, source: rSrc, steppedFrom, stepped_from: steppedFrom },
      [eff, rVal, rSrc, steppedFrom],
    );

  if (respSource === "not_applicable" || respVal === null || respVal === undefined) {
    const naEffort = hasExplicitEffort ? rawEffort : (bundle?.effort ?? info?.fixed_effort ?? null);
    return makeReturn(naEffort, respVal, respSource, null);
  }
  const respFloor = Number(responsivenessConfig(policy).floor ?? 0.5);
  if (respVal >= respFloor) {
    return makeReturn(rawEffort, respVal, respSource, null);
  }
  const curvesResp = curves && typeof curves === "object" ? curves.responsiveness : null;
  if (!curvesResp || typeof curvesResp !== "object" || Object.keys(curvesResp).length === 0) {
    return makeReturn(rawEffort, respVal, respSource, null);
  }

  const provider = bundle?.provider || bundle?.account;
  if (
    effHarness === "antigravity" ||
    effHarness === "antigravity-resilient" ||
    provider === "antigravity" ||
    provider === "antigravity-resilient"
  ) {
    return makeReturn(rawEffort, respVal, respSource, null);
  }

  const rawLaunchId = String(bundle?.launch_model || bundle?.model || "");
  if (splitEffortFromModelId(rawLaunchId, models, aliases).effort !== null) {
    return makeReturn(rawEffort, respVal, respSource, null);
  }

  const explicitEffortPin =
    taskCtx?.constraint_effort ||
    taskCtx?.constraintEffort ||
    taskCtx?.pinned_effort ||
    taskCtx?.pinnedEffort ||
    taskCtx?.constraints?.effort;
  if (isCandidatePinned(bundle, canonical, taskCtx) || explicitEffortPin) {
    return makeReturn(rawEffort, respVal, respSource, null);
  }

  // Deference to an existing faster sibling bundle: when the same account + harness + model
  // already has a separate active bundle at a faster effort that clears BOTH the responsiveness floor
  // and the ability gate, and is available, not disabled, not unhealthy, and not in cooldown, let that
  // sibling compete natively instead of duplicating it.
  const rawBundles = ctx.bundles || taskCtx?.bundles || taskCtx?.all_bundles || null;
  const bundleEntries = Array.isArray(rawBundles)
    ? rawBundles.map((b, idx) => [b?.id || `${b?.model || ""}:${b?.effort || idx}`, b])
    : rawBundles && typeof rawBundles === "object"
      ? Object.entries(rawBundles)
      : [];

  if (bundleEntries.length > 0) {
    const unavailableIds = new Set(ctx.unavailable || taskCtx?.unavailable || []);
    const unhealthySet = taskCtx?.unhealthy_models instanceof Set ? taskCtx.unhealthy_models : new Set(taskCtx?.unhealthy_models || []);
    const failuresMap = ctx.launch_failures || ctx.launchFailures || taskCtx?.launch_failures || taskCtx?.launchFailures || null;
    const nowMs = Number.isFinite(ctx.now ?? taskCtx?.now) ? Number(ctx.now ?? taskCtx?.now) : Date.now();
    const selfKey = resolveResponsivenessModelKey(
      bundle?.model || canonical,
      models,
      aliases,
      catalog.effortCurves || EFFORT_CURVES,
      catalog.effortResponsiveness || EFFORT_RESPONSIVENESS,
    ).key;
    const siblings = [];
    for (const [bid, b] of bundleEntries) {
      if (!b || typeof b !== "object") continue;
      const sibId = b.id || bid;
      if (unavailableIds.has(sibId) || (b.account && unavailableIds.has(b.account))) continue;
      if ((b.account || null) !== (bundle?.account || null)) continue;
      const sibHarness = b.harness || bundleHarness(b, b.account, sibId);
      if (sibHarness !== effHarness) continue;
      const sibKey = resolveResponsivenessModelKey(
        b.model || "",
        models,
        aliases,
        catalog.effortCurves || EFFORT_CURVES,
        catalog.effortResponsiveness || EFFORT_RESPONSIVENESS,
      ).key;
      if (sibKey !== selfKey) continue;
      if (unhealthySet.has(canonicalModel(b.model || "", aliases))) continue;
      if (b.disabled || b.discovery_unavailable || !bundleApplies(b, taskCtx)) continue;
      const sibBundle = { ...b, id: sibId };
      if (bundleCooldownReason(sibBundle, failuresMap, nowMs)) continue;
      siblings.push(sibBundle);
    }

    const selfId = bundle?.id;
    for (const sib of siblings) {
      if ((selfId && sib.id === selfId) || (!selfId && scoringEffort(sib, info) === rawEffort)) {
        continue;
      }
      const sibEff = scoringEffort(sib, info);
      const { value: sibResp, source: sibSrc } = bundleResponsiveness(sib, info, policy, curves, {
        effort: sibEff,
        harness: effHarness,
        models,
        aliases,
        effortCurves: catalog.effortCurves,
        effortResponsiveness: catalog.effortResponsiveness,
        localTelemetry: ctx.localTelemetry || taskCtx?.localTelemetry,
      });
      const sibAb = effortAbility(policy, curves, info, sibEff);
      if (sibSrc !== "not_applicable" && sibResp !== null && sibResp >= respFloor && sibAb >= gate) {
        return makeReturn(rawEffort, respVal, respSource, null);
      }
    }

    if (siblings.length > 0) {
      const gateClearingPeers = siblings.filter(
        (s) => effortAbility(policy, curves, info, scoringEffort(s, info)) >= gate,
      );
      const stepDownPeers = gateClearingPeers.length > 0 ? gateClearingPeers : siblings;
      const minRank = Math.min(...stepDownPeers.map((s) => effortRank(scoringEffort(s, info))));
      if (effortRank(rawEffort) > minRank) {
        return makeReturn(rawEffort, respVal, respSource, null);
      }
    }
  }

  const allowedEfforts = dispatchAllowedEfforts(
    bundle,
    provider,
    effHarness,
    canonical,
    models,
    aliases,
    dispatchEffortsTable,
    catalog.effortCurves || EFFORT_CURVES,
    catalog.effortResponsiveness || EFFORT_RESPONSIVENESS,
  );

  const abilityCurve = curves && typeof curves.ability === "object" ? curves.ability : null;
  const hasAbilityCurve = abilityCurve && Object.keys(abilityCurve).length > 0;
  const rawRank = effortRank(rawEffort);

  const faster = REALTIME_EFFORT_ORDER.filter(
    (eff) =>
      eff in curvesResp &&
      effortRank(eff) < rawRank &&
      (!hasAbilityCurve || eff in abilityCurve) &&
      (!allowedEfforts || allowedEfforts.includes(eff)),
  );
  faster.sort((a, b) => effortRank(b) - effortRank(a));

  let bestClearingBoth = null;
  let bestClearingResp = null;
  for (const candEff of faster) {
    const { value: candResp, source: candSrc } = bundleResponsiveness(bundle, info, policy, curves, {
      effort: candEff,
      harness: effHarness,
      models,
      aliases,
      effortCurves: catalog.effortCurves,
      effortResponsiveness: catalog.effortResponsiveness,
      localTelemetry: ctx.localTelemetry || taskCtx?.localTelemetry,
    });
    if (candSrc === "not_applicable" || candResp === null || candResp < respFloor) {
      continue;
    }
    if (bestClearingResp === null) {
      bestClearingResp = [candEff, candResp, candSrc];
    }
    if (effortAbility(policy, curves, info, candEff) >= gate) {
      bestClearingBoth = [candEff, candResp, candSrc];
      break;
    }
  }

  const chosen = bestClearingBoth || bestClearingResp;
  if (chosen !== null) {
    return makeReturn(chosen[0], chosen[1], chosen[2], rawEffort);
  }
  return makeReturn(rawEffort, respVal, respSource, null);
}

/**
 * Bundle-level exclusions a `realtime_loop` task applies: availability, the launch cooldown, and user pins.
 */
function realtimeAvailabilityExclusions(candidate, rawEffort, taskCtx) {
  const excluded = [];
  const rawModel = candidate.model;
  if (candidate.disabled) {
    excluded.push("unchecked in model management");
  }
  if (candidate.discovery_unavailable) {
    excluded.push(
      typeof candidate.discovery_unavailable === "string"
        ? candidate.discovery_unavailable
        : "model not detected by discovery for 7+ days",
    );
  }
  if (candidate.id && taskCtx.unavailable instanceof Set && taskCtx.unavailable.has(candidate.id)) {
    excluded.push("marked unavailable by the parent");
  }
  const computedId = rawModel ? `${rawModel}:${rawEffort}` : null;
  const pinnedBundle =
    taskCtx.pinned_bundle ||
    taskCtx.pinnedBundle ||
    taskCtx.constraint_bundle ||
    taskCtx.constraintBundle ||
    taskCtx.constraints?.bundle;
  if (pinnedBundle && candidate.id !== pinnedBundle && computedId !== pinnedBundle) {
    excluded.push("explicit bundle constraint");
  }
  const constraintModel =
    taskCtx.constraint_model ||
    taskCtx.constraintModel ||
    taskCtx.pinned_model ||
    taskCtx.pinnedModel ||
    taskCtx.constraints?.model;
  if (constraintModel) {
    const normConstraint = String(constraintModel).trim();
    const { modelPart, effortPart } = splitPinModelAndEffort(normConstraint);
    if (!matchesPinnedModel(candidate, computedId, normConstraint, modelPart, taskCtx)) {
      excluded.push("explicit model constraint");
    } else if (effortPart && String(rawEffort).toLowerCase() !== effortPart) {
      excluded.push("explicit effort constraint");
    }
  }
  const constraintEffort =
    taskCtx.constraint_effort ||
    taskCtx.constraintEffort ||
    taskCtx.pinned_effort ||
    taskCtx.pinnedEffort ||
    taskCtx.constraints?.effort;
  if (constraintEffort && String(rawEffort).toLowerCase() !== String(constraintEffort).trim().toLowerCase()) {
    excluded.push("explicit effort constraint");
  }
  const cooling = bundleCooldownReason(candidate, taskCtx.launch_failures || taskCtx.launchFailures, taskCtx.now);
  if (cooling) {
    excluded.push(cooling);
  }
  return excluded;
}

/**
 * Evaluate one `(model, effort)` candidate against a profiled task (`allocator.py:evaluate_bundle`).
 */
export function evaluateCandidate(candidate, taskCtx, catalog = {}) {
  const models = catalog.models || DEFAULT_MODELS;
  const aliases = catalog.aliases || MODEL_ALIASES;
  const policy = catalog.policy || DEFAULT_SCORING_POLICY;

  const rawModel = candidate.model;
  const { canonical, spec: info } = resolveModelSpec(rawModel, models, aliases);
  const realtime = Boolean(taskCtx.realtime_loop);
  const rawEffort = realtime ? scoringEffort(candidate, info) : candidate.effort || "high";
  const curves = realtime
    ? resolveRealtimeCurves(rawModel, canonical, catalog)
    : (catalog.effortCurves || EFFORT_CURVES)[canonical] || {};
  const excluded = [];
  const notes = [];

  if (realtime) {
    excluded.push(...realtimeAvailabilityExclusions(candidate, rawEffort, taskCtx));
  }

  if (taskCtx.needs_visual && !info.visual) {
    excluded.push("task needs visual input");
  }
  if (taskCtx.unhealthy_models && taskCtx.unhealthy_models.has(canonical)) {
    excluded.push("model is currently marked unhealthy");
  }
  if (
    taskCtx.min_context_tokens &&
    Number(info.context_window || 128000) * 0.95 < taskCtx.min_context_tokens
  ) {
    excluded.push(
      `context window ${info.context_window || 128000} outgrown by ${taskCtx.min_context_tokens} tokens`
    );
  }
  const routes = catalog.routes || CANONICAL_ROUTES;
  const route = routes[taskCtx.kind] || {};
  const demand = taskCtx.demand;
  const target = demand.required_ability;
  const floor = demand.floor ?? abilityFloor(policy, route, taskCtx.difficulty);
  const headroom = taskCtx.critical ? criticalHeadroom(policy, taskCtx.difficulty) : 0.0;
  const gate = floor + headroom;

  let effort = rawEffort;
  let respVal = null;
  let respSource = null;
  let steppedFrom = null;
  const extraComponents = {};

  if (taskCtx.realtime_loop) {
    const resolved = resolveRealtimeEffort(candidate, taskCtx, catalog, {
      canonical,
      info,
      policy,
      curves,
      gate,
      now: taskCtx.now,
    });
    effort = resolved.effort || rawEffort;
    respVal = resolved.responsiveness;
    respSource = resolved.source;
    steppedFrom = resolved.steppedFrom;
    if (steppedFrom !== null) {
      extraComponents.effort_stepped_down_from = steppedFrom;
      notes.push(`effort stepped down from ${steppedFrom} to ${effort} for realtime_loop`);
    }
  }

  const ability = effortAbility(policy, curves, info, effort);
  const highAbility = effortAbility(policy, curves, info, "high");

  if (
    route.restrict_models &&
    taskCtx.specialist_available &&
    !(route.preferred || []).map((m) => canonicalModel(m, aliases)).includes(canonical)
  ) {
    excluded.push(`not in the allowed model list for ${taskCtx.kind}`);
  }

  if (ability < gate) {
    excluded.push(`ability ${ability.toFixed(2)} below the ${taskCtx.difficulty} floor ${gate.toFixed(2)}`);
  }

  if (taskCtx.realtime_loop) {
    const respCfg = responsivenessConfig(policy);
    const pinnedChoice = isCandidatePinned(candidate, canonical, taskCtx);
    const measuredAs = resolveResponsivenessModelKey(rawModel || canonical, models, aliases).key;
    extraComponents.responsiveness_source = respSource;
    if (respSource === "not_applicable" || respVal === null || respVal === undefined) {
      extraComponents.responsiveness = null;
      if (pinnedChoice) {
        const warn = `pinned ${candidate.id || rawModel} (${measuredAs}@${effort}) responsiveness is not_applicable for realtime_loop (too slow per turn for a live loop); kept per explicit user selection`;
        extraComponents.realtime_slow_pin_warning = warn;
        notes.push(warn);
      } else {
        excluded.push("responsiveness not_applicable for this channel (too slow per turn for a live loop)");
      }
    } else {
      extraComponents.responsiveness = round3(respVal);
      if (respSource === "default") {
        notes.push("responsiveness: default");
      }
      const respFloor = Number(respCfg.floor ?? 0.5);
      if (respVal < respFloor) {
        if (pinnedChoice) {
          const warn = `pinned ${candidate.id || rawModel} (${measuredAs}@${effort}) responsiveness ${respVal.toFixed(2)} is below the realtime_loop floor ${respFloor} (too slow per turn for a live loop); kept per explicit user selection`;
          extraComponents.realtime_slow_pin_warning = warn;
          notes.push(warn);
        } else {
          excluded.push(
            `responsiveness ${respVal.toFixed(2)} below the realtime_loop floor ${respFloor} (too slow per turn for a live loop)`
          );
        }
      }
    }
  }

  // Subscription quota, safety margin, opportunity cost & pre-reset sprint evaluation (at stepped-down effort)
  const quotaEval = taskCtx.quotas
    ? evaluateModelQuota(
        rawModel,
        effort,
        taskCtx,
        taskCtx.quotas,
        catalog,
        taskCtx.now
      )
    : null;
  if (quotaEval && !quotaEval.eligible) {
    excluded.push(...(quotaEval.excluded || [`${rawModel}: subscription quota exhausted`]));
  }

  let fit = fitScore(taskCtx.kind, canonical, catalog, {
    local_only: taskCtx.local_only,
    dotAvailable: taskCtx.dot_available,
  });
  const visual = info.visual;
  if (
    taskCtx.needs_visual &&
    taskCtx.kind !== "visual_analysis" &&
    !route.capability_fit &&
    typeof visual === "number"
  ) {
    fit = (fit + visual) / 2.0;
  }

  let vfit = 1.0;
  let sfit = 1.0;
  const routeFitRaw = fit;

  if (taskCtx.profile && (!route.strict_order || route.capability_fit)) {
    vfit = vectorFit(taskCtx.requirements, effortScaledCapabilities(info, policy, curves, effort));
    const sWeights = taskCtx.subjective_weights || {};
    const sCfg = policy.profile?.subjective;
    if (Object.keys(sWeights).length > 0 && sCfg && info.subjective) {
      const subjScale = highAbility > 0 ? Math.min(1.0, ability / highAbility) : 1.0;
      const scaledSubj = {};
      for (const [k, v] of Object.entries(subjectiveVector(info))) {
        scaledSubj[k] = v * subjScale;
      }
      sfit = subjectiveFit(sWeights, scaledSubj);
      const wS = Number(sCfg.weight ?? 0.45);
      const wV = Number(sCfg.vector_weight ?? 0.35);
      const wR = Number(sCfg.route_weight ?? Math.max(0.0, 1.0 - wS - wV));
      fit = wR * fit + wV * vfit + wS * sfit;
    } else {
      const wV = Number(policy.profile?.vector_weight ?? 0.5);
      fit = (1 - wV) * fit + wV * vfit;
    }
  }

  if (taskCtx.realtime_loop && respVal !== null && respVal !== undefined) {
    if ((taskCtx.needs_gui || taskCtx.profile?.needs_gui) && !route.capability_fit) {
      const cuCap = routes.computer_use?.capability_fit || { gui: 1.0 };
      const guiFit = capabilityScore(cuCap, canonical, catalog);
      extraComponents.gui_fit = round3(guiFit);
      fit = 0.5 * fit + 0.5 * guiFit;
    }
    const wResp = clamp(Number(responsivenessConfig(policy).weight ?? 0.35), 0.0, 1.0);
    fit = (1.0 - wResp) * fit + wResp * respVal;
  }

  const sunkWeight = Number(quotaEval?.reset_sunk_weight ?? 0.0);
  const sprintSunk = taskCtx.difficulty === "routine" ? 0.0 : sunkWeight;
  const effortScale = burnScale(policy, curves, effort);
  const routineEffortOverhead =
    taskCtx.difficulty === "routine" &&
    taskCtx.minimum_sufficient &&
    ability >= target &&
    vfit >= 0.999 &&
    Array.isArray(info?.efforts) &&
    info.efforts.includes("low")
      ? effort === "high"
        ? 0.004
        : effort === "medium"
          ? 0.002
          : 0.0
      : 0.0;
  const effortPenalty = round4(
    (policy.extra_effort_penalty ?? 0.025) *
      Math.max(0.0, effortScale - 1.0) *
      (1.0 - sprintSunk) +
      routineEffortOverhead
  );
  const effortGain = Math.max(0.0, ability - highAbility);
  const saturationSpan = Number(policy.profile?.saturation_span ?? 0.3);
  const sprintQuality =
    sprintSunk > 0 && effortGain > 0
      ? round4(
          Number(policy.demand?.sprint_effort_weight ?? 0.06) *
            sprintSunk *
            clamp(effortGain / saturationSpan, 0, 1)
        )
      : 0.0;
  const credited = Math.min(ability, Math.max(highAbility, target));
  const shortfall = Math.max(0.0, target - ability);
  const shortfallPenalty = round4((policy.demand?.shortfall_weight ?? 0.35) * shortfall);

  let span = Number(policy.ability_span ?? 0.6);
  if (
    ["frontend_implementation", "complex_build_plan", "direction_reasoning"].includes(taskCtx.kind) &&
    !taskCtx.high_precision
  ) {
    span = Number(policy.profile?.saturation_span ?? 0.3);
  }

  const origin = Math.max(floor, Number(policy.ability_score_origin?.[taskCtx.difficulty] ?? floor));
  let abilityScore = clamp((credited - origin - (taskCtx.high_precision ? gate - floor : 0.0)) / span, 0, 1);
  const qualityBonus = taskCtx.high_precision
    ? round4(Number(policy.high_precision_effort_weight ?? 0.14) * effortGain)
    : 0.0;

  let overqualification = 0.0;
  if (taskCtx.minimum_sufficient) {
    const pCfg = policy.profile || DEFAULT_SCORING_POLICY.profile;
    const satSpan = Number(pCfg.saturation_span ?? 0.3);
    abilityScore = ability >= gate ? 1.0 : 0.0;
    const excess = clamp((ability - target - satSpan) / Number(pCfg.overqualification_span ?? 0.6), 0, 1);
    const usd = Number(info.usd_per_hour ?? 3.0) * Math.max(effortScale, 0.0);
    let price = usd / Number(pCfg.overqualification_ref_usd_per_hour ?? 10.0);
    const gui = taskCtx.kind === "computer_use" || Boolean(taskCtx.profile?.needs_gui);
    const guiCapable = (capabilityVector(info).gui ?? 0) >= 0.7;
    price = gui && guiCapable ? Math.min(1.0, price) : Math.min(Number(pCfg.overqualification_price_cap ?? 3.0), price);
    if (((gui && guiCapable) || taskCtx.kind === "frontend_implementation") && (taskCtx.profile?.reasoning_depth ?? 1) >= 2) {
      price = 0.0;
    }
    overqualification = round4(
      Number(pCfg.overqualification_weight ?? 0.08) * excess * price * (1.0 - sprintSunk)
    );
  }

  if (taskCtx.difficulty !== "routine" && ability < highAbility) {
    abilityScore = clamp(
      abilityScore - (0.2 * (highAbility - ability)) / Number(policy.ability_span ?? 0.6),
      0,
      1,
    );
  }

  const weights = policy.weights || { fit: 0.3, ability: 0.1, continuity: 0.25 };
  let continuityBonus = 0.0;
  const cont = taskCtx.continuity;
  if (cont && cont.previousModel) {
    const prevCanonical = canonicalModel(cont.previousModel, aliases);
    if (canonical === prevCanonical && cont.active !== false) {
      let coupling = 0.0;
      if (Number.isFinite(cont.coupling)) {
        coupling = clamp(Number(cont.coupling), 0.0, 1.0);
      } else if (cont.cacheWarm === true) {
        coupling = 1.0;
      } else if (cont.why === "cold" || cont.why === "compacted") {
        coupling = taskCtx.difficulty === "coupled" || taskCtx.difficulty === "frontier" ? 0.35 : 0.0;
      } else if (
        taskCtx.difficulty === "coupled" ||
        taskCtx.difficulty === "frontier" ||
        (taskCtx.profile?.context_scale ?? 1) >= 2
      ) {
        coupling = 0.65;
      }
      if (cont.cacheWarm && cont.previousEffort) {
        const prevIdx = EFFORT_ORDER.indexOf(cont.previousEffort);
        const curIdx = EFFORT_ORDER.indexOf(effort);
        if (prevIdx >= 0 && curIdx >= 0 && curIdx < prevIdx) {
          coupling *= 0.25;
        }
      }
      continuityBonus = round4(Number(weights.continuity ?? 0.25) * coupling);
    }
  }

  const resetBonus = Number(quotaEval?.reset_bonus ?? 0.0);
  const opportunityCost = Number(quotaEval?.opportunity_cost ?? 0.0);
  const freeUsage = Number(quotaEval?.free_usage ?? 0.0);
  const fastBonus = Number(quotaEval?.fast_bonus ?? 0.0);

  const totalScore = round4(
    weights.fit * fit +
      weights.ability * abilityScore +
      continuityBonus +
      qualityBonus +
      freeUsage +
      resetBonus +
      sprintQuality +
      fastBonus -
      opportunityCost -
      effortPenalty -
      overqualification -
      shortfallPenalty,
  );

  const hours = Number(taskCtx.hours ?? taskCtx.profile?.expected_hours ?? 0.5);
  const expectedUsd = round4(hours * Number(info.usd_per_hour ?? 3.0) * Math.max(effortScale, 0.0));

  const out = {
    id: realtime && candidate.id ? candidate.id : `${rawModel}:${effort}`,
    model: rawModel,
    canonicalModel: canonical,
    effort,
    fast: Boolean(quotaEval?.fast),
    excluded,
    eligible: excluded.length === 0,
    score: excluded.length === 0 ? totalScore : null,
    quota: quotaEval
      ? {
          account: quotaEval.account,
          provider: quotaEval.provider,
          kind: quotaEval.kind,
          opportunity_cost: opportunityCost,
          reset_bonus: resetBonus,
          reset_sunk_weight: sunkWeight,
          free_usage: freeUsage,
          fast_bonus: fastBonus,
          fast: Boolean(quotaEval.fast),
          shortage_probability: quotaEval.shortage_probability ?? 0.0,
          binding_window: quotaEval.binding_window || null,
        }
      : null,
    components: {
      fit: round3(fit),
      route_fit: round3(routeFitRaw),
      vector_fit: round3(vfit),
      subjective_fit: round3(sfit),
      ability: round3(abilityScore),
      ability_value: round3(ability),
      required_ability: round3(target),
      continuity: continuityBonus,
      quality_bonus: qualityBonus,
      free_usage: freeUsage,
      reset_bonus: resetBonus,
      sprint_quality: sprintQuality,
      fast_bonus: fastBonus,
      opportunity_cost: opportunityCost,
      effort_penalty: effortPenalty,
      overqualification,
      shortfall: shortfallPenalty,
      ...extraComponents,
    },
  };

  if (steppedFrom !== null) {
    out.realtime_stepped_from = steppedFrom;
  }
  if (notes.length > 0) {
    out.notes = notes;
  }
  if (taskCtx.realtime_loop) {
    out.expected_usd = expectedUsd;
  }

  return out;
}

function realtimeBareCandidateEfforts(
  entryObj,
  spec,
  canonical,
  models = DEFAULT_MODELS,
  aliases = MODEL_ALIASES,
  dispatchEffortsTable = DISPATCH_EFFORTS,
  curvesTable = EFFORT_CURVES,
  respTable = EFFORT_RESPONSIVENESS,
) {
  const rawModel = String(entryObj?.model || "").trim();
  const encodedRaw = splitEffortFromModelId(rawModel, models, aliases).effort;
  if (encodedRaw) return [encodedRaw];
  const encodedCanon = splitEffortFromModelId(canonical, models, aliases).effort;
  if (encodedCanon) return [encodedCanon];

  const baseEfforts =
    Array.isArray(spec?.efforts) && spec.efforts.length > 0 ? spec.efforts : ["medium", "high"];
  const effHarness = entryObj?.harness || bundleHarness(entryObj, entryObj?.account, entryObj?.id);
  const provider = entryObj?.provider || entryObj?.account;
  if (
    effHarness === "antigravity" ||
    effHarness === "antigravity-resilient" ||
    provider === "antigravity" ||
    provider === "antigravity-resilient"
  ) {
    return [scoringEffort(entryObj, spec)];
  }
  const allowed = dispatchAllowedEfforts(
    entryObj,
    provider,
    effHarness,
    canonical,
    models,
    aliases,
    dispatchEffortsTable,
    curvesTable,
    respTable,
  );
  if (Array.isArray(allowed) && allowed.length > 0) {
    const filtered = baseEfforts.filter((e) => allowed.includes(e));
    if (filtered.length > 0) return filtered;
    const validAllowed = allowed.filter((e) => EFFORT_ORDER.includes(e));
    if (validAllowed.length > 0) return validAllowed;
  }
  return baseEfforts;
}

/**
 * Expand candidate models into `(model, effort)` bundles and rank them for the given task profile.
 */
export function rankCandidates(profileInput, options = {}) {
  const catalog = options.catalog || {};
  const policy = catalog.policy || DEFAULT_SCORING_POLICY;
  const routes = catalog.routes || CANONICAL_ROUTES;
  const models = catalog.models || DEFAULT_MODELS;
  const aliases = catalog.aliases || MODEL_ALIASES;
  const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  const callerNeeds = profileInput?.needs && typeof profileInput.needs === "object" ? profileInput.needs : {};
  // A task wrapper (`{ profile, realtime_loop, constraints, ... }`) is a realtime-only input; anything else is inferred as on main.
  const wrappedProfile = !profileInput?.reasoning_depth && profileInput?.profile?.reasoning_depth ? profileInput.profile : null;
  const wrapperRealtime =
    wrappedProfile &&
    (typeof options.realtime_loop === "boolean"
      ? options.realtime_loop
      : typeof callerNeeds.realtime_loop === "boolean"
        ? callerNeeds.realtime_loop
        : typeof profileInput.realtime_loop === "boolean"
          ? profileInput.realtime_loop
          : wrappedProfile.realtime_loop === true);
  const rawProfile = profileInput?.reasoning_depth ? profileInput : wrapperRealtime ? wrappedProfile : null;
  let profile = rawProfile
    ? validateProfile(rawProfile)
    : inferTaskProfile(profileInput || {}, routes);
  const isTaskWrapper = Boolean(rawProfile && profileInput !== rawProfile);
  const explicitRealtimeLoop =
    typeof options.realtime_loop === "boolean"
      ? options.realtime_loop
      : typeof callerNeeds.realtime_loop === "boolean"
        ? callerNeeds.realtime_loop
        : isTaskWrapper && typeof profileInput.realtime_loop === "boolean"
          ? profileInput.realtime_loop
          : Boolean(profile.realtime_loop);
  if (profile.realtime_loop !== explicitRealtimeLoop) {
    profile = { ...profile, realtime_loop: explicitRealtimeLoop };
  }

  const kind = profileKind(profile, policy);
  const difficulty = profileDifficulty(profile, policy);
  const critical = Boolean(options.critical ?? profile.error_cost >= 3);
  const div = profile.divergence || 1;
  const depth = profile.reasoning_depth;
  const mechanicalRunbook = Boolean(depth === 1 && profile.code_complexity === 0 && div === 1);
  const unlockDiffs = policy.effort_unlock_difficulties || ["coupled", "frontier"];
  const unlocked = Boolean(
    unlockDiffs.includes(difficulty) ||
      (critical && !mechanicalRunbook) ||
      depth >= 3 ||
      (depth >= 2 && profile.hallucination_risk >= 3 && (div >= 2 || profile.code_complexity >= 2))
  );
  const highPrecision = Boolean(
    unlocked &&
      (difficulty === "frontier" ||
        (critical && !mechanicalRunbook) ||
        (profile.hallucination_risk >= 3 &&
          (((div >= 2 || profile.code_complexity >= 2) &&
            !["complex_build_plan", "direction_reasoning"].includes(kind) &&
            profile.interaction_style !== "advisory") ||
            (depth >= 3 && profile.code_complexity >= 3))))
  );
  const minimumSufficient = Boolean(
    depth <= 2 &&
      profile.code_complexity < 3 &&
      div === 1 &&
      (profile.error_cost <= 2 || mechanicalRunbook) &&
      (!critical || mechanicalRunbook)
  );

  const routeObj = routes[kind] || {};
  const floor = abilityFloor(policy, routeObj, difficulty);
  const demand = taskDemand(profile, difficulty, critical, div, policy, highPrecision, floor);
  const requirements = profileRequirements(profile, policy);
  const sWeights = subjectiveWeights(profile, kind);

  const unhealthySet = new Set(
    (options.unhealthyModels || []).map((m) => canonicalModel(m, aliases)).filter(Boolean)
  );
  const taskOpts = !rawProfile || isTaskWrapper ? profileInput : null;
  const unavailableSet = new Set(options.unavailable || taskOpts?.unavailable || []);
  const continuity =
    options.continuity ||
    (options.previousModel
      ? {
          previousModel: options.previousModel,
          previousEffort: options.previousEffort,
          cacheWarm: Boolean(options.cacheWarm),
          why: options.why || "",
          coupling: options.coupling,
        }
      : null);

  const normalizedQuotas = options.quotas
    ? Array.isArray(options.quotas._normalized)
      ? options.quotas
      : { _normalized: normalizeQuotaSnapshot(options.quotas, nowMs, policy) }
    : null;

  // Build candidate list from user-configured pool or default catalog
  const candidateModels =
    Array.isArray(options.candidateModels) && options.candidateModels.length > 0
      ? options.candidateModels
      : Object.keys(models).filter((m) => m !== "deepseek-v4.1-flash-free" && !models[m]?.disabled_by_default);

  const candidateCanonicals = new Set();
  for (const entry of candidateModels) {
    const rawM = typeof entry === "string" ? entry.split(":")[0] : entry?.model;
    if (rawM) candidateCanonicals.add(canonicalModel(rawM, aliases));
  }
  const dotAvailable = candidateCanonicals.has("dot");
  const specialistAvailable = Boolean(
    routeObj.restrict_models &&
      (routeObj.preferred || []).some((m) => candidateCanonicals.has(canonicalModel(m, aliases)))
  );

  const taskCtx = {
    profile,
    kind,
    difficulty,
    critical,
    unlocked,
    high_precision: highPrecision,
    minimum_sufficient: minimumSufficient,
    needs_visual: profile.needs_visual,
    needs_gui: profile.needs_gui,
    realtime_loop: Boolean(profile.realtime_loop),
    local_only: Boolean(options.local_only ?? profile.local_only),
    dot_available: dotAvailable,
    specialist_available: specialistAvailable,
    demand,
    requirements,
    subjective_weights: sWeights,
    unhealthy_models: unhealthySet,
    unavailable: unavailableSet,
    launch_failures: options.launchFailures || options.launch_failures || taskOpts?.launch_failures || null,
    pinned_bundle: options.pinnedBundle || options.pinned_bundle || taskOpts?.pinned_bundle || null,
    constraint_bundle: options.constraintBundle || options.constraint_bundle || taskOpts?.constraint_bundle || null,
    constraint_model:
      options.constraintModel ||
      options.constraint_model ||
      options.pinnedModel ||
      options.pinned_model ||
      taskOpts?.constraint_model ||
      taskOpts?.constraints?.model ||
      null,
    constraint_effort:
      options.constraintEffort ||
      options.constraint_effort ||
      options.pinnedEffort ||
      options.pinned_effort ||
      taskOpts?.constraint_effort ||
      taskOpts?.constraints?.effort ||
      null,
    constraints: options.constraints || taskOpts?.constraints || null,
    models,
    aliases,
    localTelemetry: options.localTelemetry || null,
    min_context_tokens: Number(options.minContextTokens || 0),
    continuity,
    quotas: normalizedQuotas,
    hours: options.hours,
    metered_ok: options.meteredOk,
    fast_requested: Boolean(options.fast),
    urgency: options.urgency || profile.urgency || "unknown",
    now: nowMs,
  };

  const rawExpanded = [];
  for (const entry of candidateModels) {
    if (typeof entry === "string") {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx > 0) {
        const suffix = entry.slice(colonIdx + 1).toLowerCase();
        if (EFFORT_ORDER.includes(suffix)) {
          rawExpanded.push({ model: entry.slice(0, colonIdx), effort: suffix });
          continue;
        }
      }
      const { canonical, spec } = resolveModelSpec(entry, models, aliases);
      const efforts = taskCtx.realtime_loop
        ? realtimeBareCandidateEfforts(
            { model: entry },
            spec,
            canonical,
            models,
            aliases,
            catalog.dispatchEfforts || DISPATCH_EFFORTS,
            catalog.effortCurves || EFFORT_CURVES,
            catalog.effortResponsiveness || EFFORT_RESPONSIVENESS,
          )
        : Array.isArray(spec.efforts) && spec.efforts.length > 0
          ? spec.efforts
          : ["medium", "high"];
      for (const eff of efforts) {
        rawExpanded.push({ model: entry, effort: eff });
      }
    } else if (entry && typeof entry === "object" && entry.model) {
      if (!taskCtx.realtime_loop) {
        const efforts = Array.isArray(entry.efforts)
          ? entry.efforts
          : entry.effort
            ? [entry.effort]
            : ["medium", "high"];
        for (const eff of efforts) {
          rawExpanded.push({ model: entry.model, effort: eff });
        }
        continue;
      }
      const { canonical, spec } = resolveModelSpec(entry.model, models, aliases);
      const isBundleObj = Boolean(entry.id || entry.provider || entry.account || entry.harness || entry.when);
      const efforts = Array.isArray(entry.efforts)
        ? entry.efforts.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
        : entry.effort
          ? [String(entry.effort).trim().toLowerCase()]
          : isBundleObj
            ? [scoringEffort(entry, spec)]
            : realtimeBareCandidateEfforts(
                entry,
                spec,
                canonical,
                models,
                aliases,
                catalog.dispatchEfforts || DISPATCH_EFFORTS,
                catalog.effortCurves || EFFORT_CURVES,
                catalog.effortResponsiveness || EFFORT_RESPONSIVENESS,
              );
      for (const eff of efforts) {
        rawExpanded.push({ ...entry, model: entry.model, effort: eff });
      }
    }
  }

  taskCtx.bundles = options.bundles || rawExpanded;
  const expanded = taskCtx.realtime_loop ? rawExpanded.filter((c) => bundleApplies(c, taskCtx)) : rawExpanded;

  const evaluated = expanded.map((c) => evaluateCandidate(c, taskCtx, catalog));
  const eligible = evaluated.filter((c) => c.eligible);
  eligible.sort((a, b) => b.score - a.score);
  const pinnedCand = taskCtx.realtime_loop ? eligible.find((c) => isCandidatePinned(c, c.canonicalModel, taskCtx)) : null;

  return {
    task: {
      kind,
      difficulty,
      critical,
      high_precision: highPrecision,
      minimum_sufficient: minimumSufficient,
      required_ability: demand.required_ability,
      realtime_loop: Boolean(profile.realtime_loop),
      subjective_weights: sWeights,
      profile,
    },
    selected: pinnedCand || eligible[0] || null,
    ranking: eligible,
    allCandidates: evaluated,
  };
}

const PIN_OPTIONS = [
  "pinnedBundle",
  "pinned_bundle",
  "constraintBundle",
  "constraint_bundle",
  "pinnedModel",
  "pinned_model",
  "constraintModel",
  "constraint_model",
  "pinnedEffort",
  "pinned_effort",
  "constraintEffort",
  "constraint_effort",
  "constraints",
];

/**
 * The user's pins among a host's own options, for `selectBestRoute`. Pins only act on `realtime_loop` routing.
 */
export function pinOptionsOf(options = {}) {
  const pins = {};
  for (const key of PIN_OPTIONS) {
    if (options[key] !== undefined && options[key] !== null) pins[key] = options[key];
  }
  return pins;
}

/**
 * Convenience entry point: takes a raw request or task object + options and returns the winning route decision.
 */
export function selectBestRoute(taskOrProfile, options = {}) {
  const result = rankCandidates(taskOrProfile, options);
  const top = result.selected;
  const warnings = top?.components?.realtime_slow_pin_warning
    ? [top.components.realtime_slow_pin_warning]
    : [];
  return {
    ok: Boolean(top),
    targetModel: top ? top.model : null,
    canonicalModel: top ? top.canonicalModel : null,
    targetEffort: top ? top.effort : "high",
    modelWithEffort: top ? `${top.model}:${top.effort}` : null,
    selectedAccount: top?.quota?.account || null,
    quota: top?.quota || null,
    workKind: result.task.kind,
    difficulty: result.task.difficulty,
    requiredAbility: result.task.required_ability,
    realtimeLoop: result.task.realtime_loop,
    responsiveness: top?.components?.responsiveness ?? null,
    responsivenessSource: top?.components?.responsiveness_source ?? null,
    warnings,
    score: top ? top.score : null,
    components: top ? top.components : null,
    profile: result.task.profile,
    topCandidates: result.ranking.slice(0, 5).map((r) => ({
      id: r.id,
      model: r.model,
      effort: r.effort,
      score: r.score,
      quota: r.quota || null,
      components: r.components,
    })),
  };
}
