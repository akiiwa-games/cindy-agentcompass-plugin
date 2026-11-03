// Vendored from akiiwa-games/magpie-agentcompass-router src/allocator.js at 3c732bbf2924c09b5500aa2e90607f8c57ed2e25 (MIT), itself ported from AgentCompass.
// Only the import paths differ from the source; regenerate rather than edit.
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
  EFFORT_CURVES,
  EFFORT_ORDER,
  KIND_TRAITS,
  MODEL_ALIASES,
  SUBJECTIVE_DIMENSIONS,
  canonicalModel,
  resolveModelSpec,
} from "./catalog.mjs";
import { inferTaskProfile, isReadonlyReviewTask, validateProfile } from "./profiler.mjs";

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
  if (named === "general_implementation" && profile.code_complexity === 0) return null;
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

export function effortValue(policy, curves, name, effort, fallback) {
  const own = curves?.[name] || {};
  if (effort in own) return own[effort];
  const policyTable = policy?.[`effort_${name}`] || {};
  return effort in policyTable ? policyTable[effort] : fallback;
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
 * Route preference score (`allocator.py:fit_score`).
 */
export function fitScore(kind, model, catalog = {}) {
  const routes = catalog.routes || CANONICAL_ROUTES;
  const policy = catalog.policy || DEFAULT_SCORING_POLICY;
  const route = routes[kind] || {};
  const canonical = canonicalModel(model, catalog.aliases);
  const preferred = (route.preferred || []).map((m) => canonicalModel(m, catalog.aliases));

  if (preferred.length === 0 && !route.capability_fit) {
    return 0.6;
  }
  const place = preferred.indexOf(canonical);
  if (place === -1 && route.capability_fit) {
    return round4(0.2 + 0.5 * capabilityScore(route.capability_fit, canonical, catalog));
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
 * Continuous task ability demand (`allocator.py:task_demand`).
 */
export function taskDemand(profile, difficulty, critical, divergence, policy = DEFAULT_SCORING_POLICY, highPrecision = false) {
  const cfg = policy.demand || DEFAULT_SCORING_POLICY.demand;
  const floor = Number(policy.ability_floor?.[difficulty] ?? 3.3);
  const headroom = critical ? Number(policy.critical_headroom ?? 0.3) : 0.0;
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

/**
 * Evaluate one `(model, effort)` candidate against a profiled task (`allocator.py:evaluate_bundle`).
 */
export function evaluateCandidate(candidate, taskCtx, catalog = {}) {
  const models = catalog.models || DEFAULT_MODELS;
  const aliases = catalog.aliases || MODEL_ALIASES;
  const policy = catalog.policy || DEFAULT_SCORING_POLICY;
  const curvesTable = catalog.effortCurves || EFFORT_CURVES;

  const rawModel = candidate.model;
  const { canonical, spec: info } = resolveModelSpec(rawModel, models, aliases);
  const effort = candidate.effort || "high";
  const curves = curvesTable[canonical] || {};
  const excluded = [];

  if (taskCtx.needs_visual && !info.visual) {
    excluded.push("task needs visual input");
  }
  const ability = effortAbility(policy, curves, info, effort);
  const highAbility = effortAbility(policy, curves, info, "high");
  const demand = taskCtx.demand;
  const target = demand.required_ability;
  const floor = policy.ability_floor[taskCtx.difficulty] ?? 3.0;
  const gate = floor + (taskCtx.critical ? policy.critical_headroom : 0.0);

  if (ability < gate) {
    excluded.push(`ability ${ability.toFixed(2)} below the ${taskCtx.difficulty} floor ${gate.toFixed(2)}`);
  }

  // Routine & Hard work does not unlock xhigh/max unless required_ability exceeds High
  if ((effort === "xhigh" || effort === "max" || effort === "ultra") && taskCtx.difficulty === "routine") {
    excluded.push(`effort ${effort} is over-provisioned for routine work`);
  }

  let fit = fitScore(taskCtx.kind, canonical, catalog);
  const visual = info.visual;
  if (
    taskCtx.needs_visual &&
    taskCtx.kind !== "visual_analysis" &&
    typeof visual === "number"
  ) {
    fit = (fit + visual) / 2.0;
  }

  const routes = catalog.routes || CANONICAL_ROUTES;
  const route = routes[taskCtx.kind] || {};
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

  const effortScale = burnScale(policy, curves, effort);
  const effortPenalty = round4((policy.extra_effort_penalty ?? 0.025) * Math.max(0.0, effortScale - 1.0));
  const effortGain = Math.max(0.0, ability - highAbility);
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

  let abilityScore = clamp((credited - (taskCtx.high_precision ? gate : floor)) / span, 0, 1);
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
    overqualification = round4(Number(pCfg.overqualification_weight ?? 0.08) * excess * price);
  }

  if (taskCtx.difficulty !== "routine" && ability < highAbility) {
    abilityScore = clamp(
      abilityScore - (0.2 * (highAbility - ability)) / Number(policy.ability_span ?? 0.6),
      0,
      1,
    );
  }

  const weights = policy.weights || { fit: 0.3, ability: 0.1 };
  const totalScore = round4(
    weights.fit * fit +
      weights.ability * abilityScore +
      qualityBonus -
      effortPenalty -
      overqualification -
      shortfallPenalty,
  );

  return {
    id: `${rawModel}:${effort}`,
    model: rawModel,
    canonicalModel: canonical,
    effort,
    excluded,
    eligible: excluded.length === 0,
    score: excluded.length === 0 ? totalScore : null,
    components: {
      fit: round3(fit),
      route_fit: round3(routeFitRaw),
      vector_fit: round3(vfit),
      subjective_fit: round3(sfit),
      ability: round3(abilityScore),
      ability_value: round3(ability),
      required_ability: round3(target),
      quality_bonus: qualityBonus,
      effort_penalty: effortPenalty,
      overqualification,
      shortfall: shortfallPenalty,
    },
  };
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

  const profile = profileInput?.reasoning_depth
    ? validateProfile(profileInput)
    : inferTaskProfile(profileInput || {}, routes);

  const kind = profileKind(profile, policy);
  const difficulty = profileDifficulty(profile, policy);
  const critical = profile.error_cost >= 3;
  const readonlyReview = isReadonlyReviewTask(options.objective || "", profile);
  const highPrecision =
    !critical &&
    !profile.needs_gui &&
    kind !== "computer_use" &&
    (readonlyReview ||
      (profile.hallucination_risk >= 3 &&
        (profile.reasoning_depth >= 3 ||
          (profile.reasoning_depth >= 2 && ["debug_review", "research_packet"].includes(kind)))));
  const minimumSufficient = !critical && !highPrecision && profile.reasoning_depth <= 3;

  const demand = taskDemand(profile, difficulty, critical, profile.divergence, policy, highPrecision);
  const requirements = profileRequirements(profile, policy);
  const sWeights = subjectiveWeights(profile, kind);

  const taskCtx = {
    profile,
    kind,
    difficulty,
    critical,
    high_precision: highPrecision,
    minimum_sufficient: minimumSufficient,
    needs_visual: profile.needs_visual,
    demand,
    requirements,
    subjective_weights: sWeights,
  };

  // Build candidate list from user-configured pool or default catalog
  const candidateModels =
    Array.isArray(options.candidateModels) && options.candidateModels.length > 0
      ? options.candidateModels
      : Object.keys(models).filter((m) => m !== "deepseek-v4.1-flash-free" && !models[m]?.disabled_by_default);

  const expanded = [];
  for (const entry of candidateModels) {
    if (typeof entry === "string") {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx > 0) {
        const suffix = entry.slice(colonIdx + 1).toLowerCase();
        if (EFFORT_ORDER.includes(suffix)) {
          expanded.push({ model: entry.slice(0, colonIdx), effort: suffix });
          continue;
        }
      }
      const { spec } = resolveModelSpec(entry, models, aliases);
      const efforts = Array.isArray(spec.efforts) && spec.efforts.length > 0 ? spec.efforts : ["medium", "high"];
      for (const eff of efforts) {
        expanded.push({ model: entry, effort: eff });
      }
    } else if (entry && typeof entry === "object" && entry.model) {
      const efforts = Array.isArray(entry.efforts)
        ? entry.efforts
        : entry.effort
          ? [entry.effort]
          : ["medium", "high"];
      for (const eff of efforts) {
        expanded.push({ model: entry.model, effort: eff });
      }
    }
  }

  const evaluated = expanded.map((c) => evaluateCandidate(c, taskCtx, catalog));
  const eligible = evaluated.filter((c) => c.eligible);
  eligible.sort((a, b) => b.score - a.score);

  return {
    task: {
      kind,
      difficulty,
      critical,
      high_precision: highPrecision,
      minimum_sufficient: minimumSufficient,
      required_ability: demand.required_ability,
      subjective_weights: sWeights,
      profile,
    },
    selected: eligible[0] || null,
    ranking: eligible,
    allCandidates: evaluated,
  };
}

/**
 * Convenience entry point: takes a raw request or task object + options and returns the winning route decision.
 */
export function selectBestRoute(taskOrProfile, options = {}) {
  const result = rankCandidates(taskOrProfile, options);
  const top = result.selected;
  return {
    ok: Boolean(top),
    targetModel: top ? top.model : null,
    canonicalModel: top ? top.canonicalModel : null,
    targetEffort: top ? top.effort : "high",
    modelWithEffort: top ? `${top.model}:${top.effort}` : null,
    workKind: result.task.kind,
    difficulty: result.task.difficulty,
    requiredAbility: result.task.required_ability,
    score: top ? top.score : null,
    components: top ? top.components : null,
    profile: result.task.profile,
    topCandidates: result.ranking.slice(0, 5).map((r) => ({
      id: r.id,
      model: r.model,
      effort: r.effort,
      score: r.score,
      components: r.components,
    })),
  };
}
