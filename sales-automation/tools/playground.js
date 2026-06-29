"use strict";
(() => {
  // src/shared/scrape-util.ts
  var canonicalizeNumeric = (raw) => {
    const s = raw.replace(/\s/g, "");
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma === -1 && lastDot === -1) return s;
    const decChar = lastComma > lastDot ? "," : ".";
    const decPos = Math.max(lastComma, lastDot);
    const trailing = s.length - decPos - 1;
    const groupChar = decChar === "," ? "." : ",";
    const hasGroup = s.indexOf(groupChar) !== -1;
    const decimalSeparatorCount = (s.match(decChar === "," ? /,/g : /\./g) ?? []).length;
    const isDecimal = trailing >= 1 && trailing <= 2 && (hasGroup || decimalSeparatorCount === 1) && !(trailing === 3);
    let out;
    if (isDecimal) {
      out = s.split(groupChar).join("").replace(decChar, "#").replace(/[,.]/g, "").replace("#", ".");
    } else {
      out = s.replace(/[,.]/g, "");
    }
    return out;
  };
  var num = (s) => {
    if (s == null) return null;
    if (typeof s === "number") return Number.isFinite(s) ? s : null;
    const kept = s.replace(/[^0-9.,+-]/g, "");
    const sign = /^-/.test(s.trim()) ? "-" : "";
    const t = sign + canonicalizeNumeric(kept.replace(/[+-]/g, ""));
    if (t === "" || t === "-" || t === "+" || t === ".") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  var MAG = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  var parseMoneyToken = (raw) => {
    const t = raw.trim().toLowerCase().replace(/[$€£¥\s]/g, "").replace(/usd|eur|gbp|sek|nok|dkk/g, "");
    const mm = t.match(/(-?\d[\d.,]*)\s*([kmbt])?/);
    if (!mm) return null;
    const n = num(mm[1]);
    if (n == null) return null;
    return mm[2] ? n * MAG[mm[2]] : n;
  };
  var parseRevenue = (text) => {
    if (text == null) return null;
    const s = text.trim();
    if (s === "" || /^(unknown|n\/?a|-|–|—|none|null)$/i.test(s)) return null;
    const range = s.match(/^(.*?\d[kmbt]?)\s*(?:[-–—]|\bto\b)\s*(\d.*)$/i);
    if (range) {
      const hi = parseMoneyToken(range[2]);
      let loRaw = range[1].trim();
      if (hi != null && !/[kmbt]\s*$/i.test(loRaw)) {
        const hiSuffix = range[2].trim().match(/([kmbt])\s*$/i);
        if (hiSuffix) loRaw = loRaw + hiSuffix[1];
      }
      const lo = parseMoneyToken(loRaw);
      if (lo != null && hi != null) return (lo + hi) / 2;
    }
    return parseMoneyToken(s);
  };

  // src/shared/scoring-signals.ts
  function piecewise(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
      }
    }
    return last[1];
  }
  function fitNorm(fitScore) {
    if (fitScore == null || !Number.isFinite(fitScore)) return null;
    const lin = Math.max(0, Math.min(1, (fitScore - 1) / 9));
    return 0.6 * lin + 0.4 * lin * lin;
  }
  var DEFAULT_MRR_K = 1e3;
  function valueNorm(mrr, k = DEFAULT_MRR_K) {
    if (mrr == null || !Number.isFinite(mrr) || mrr < 0) return null;
    const kk = k > 0 ? k : DEFAULT_MRR_K;
    return mrr / (mrr + kk);
  }
  var SIZE_PTS = [[0, 0], [50, 1], [500, 1], [1e3, 0.4], [3e3, 0.1]];
  function sizeFitNorm(employees, revenue) {
    if (employees == null || !Number.isFinite(employees) || employees < 0) return null;
    let v = piecewise(employees, SIZE_PTS);
    if (revenue != null && Number.isFinite(revenue) && revenue > 0 && employees > 0) {
      const perHead = revenue / employees;
      if (perHead < 15e3) v -= 0.05;
      else if (perHead > 2e6) v -= 0.05;
    }
    return Math.max(0, Math.min(1, v));
  }
  var INDUSTRY_HIGH = /(software|saas|information technology|it services|internet|tech(nology)?|professional services|marketing|advertis|e-?commerce|media|publishing|fintech|financial technology)/i;
  function industryFitNorm(industry, industryAlt) {
    const s = industry && industry.trim() || industryAlt && industryAlt.trim() || "";
    if (!s) return null;
    return 1;
  }
  var isHighFitIndustry = (industry, alt) => {
    const s = industry && industry.trim() || alt && alt.trim() || "";
    return !!s && INDUSTRY_HIGH.test(s);
  };
  var STRONG_INTENT_RE = /(\bfunding\b|\braised\b|\braise\b|\bseries\s?[a-e]\b|\bseed\b|\bhiring\b|\bhire\b|\bexpand\b|\bexpansion\b|\bnew\s+(vp|chief|head|director)\b|\bscaling\b|\bscale[\s-]?up\b|\bmigrat|\bgrowth\b|\blaunch\b)/i;
  function whyNowNorm(newHire, reasonsText) {
    if (newHire === true) return 1;
    const t = (reasonsText ?? "").trim();
    if (t && STRONG_INTENT_RE.test(t)) return 0.5;
    return 0;
  }

  // src/shared/scoring.ts
  var WEIGHTS = {
    fitSignal: 35,
    // HubSpot's native FIT model
    valueSignal: 30,
    // HubSpot's predicted-MRR VALUE model
    sizeFit: 15,
    // 50-500 mid-market band
    industryFit: 10,
    // HubSpot-shaped vertical
    whyNow: 10
    // optional trigger (additive — never lowers)
  };
  var WEIGHT_ORDER = ["fitSignal", "valueSignal", "sizeFit", "industryFit", "whyNow"];
  var DEFAULT_SCORING_CONFIG = {
    mrrK: DEFAULT_MRR_K,
    // CALIBRATION KNOB — tune ONCE against the OBSERVE MRR distribution (~ pool median)
    allowedTerritories: ["EMEA/Mid Market/Nordics"],
    openOwnerValue: "Open Account (Salesforce)",
    enforceViewFilters: false
    // trust the HubSpot view's Nordic+open filter; don't re-cap from scraped text
  };
  function tierOf(score) {
    if (score >= 75) return "HOT";
    if (score >= 50) return "WARM";
    if (score >= 30) return "NURTURE";
    return "SKIP";
  }
  var RESEARCHED_FIT_HAIRCUT = 0.85;
  var COVERAGE_FLOOR = 0.3;
  var round = (n, dp = 1) => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  };
  var RANK = { SKIP: 0, NURTURE: 1, WARM: 2, HOT: 3 };
  var BY_RANK = ["SKIP", "NURTURE", "WARM", "HOT"];
  var normTerritory = (s) => (s ?? "").trim().toLowerCase();
  function applyTierCaps(tier, f) {
    let cap = RANK.HOT;
    const caps = [];
    const apply = (max, label) => {
      if (RANK[tier] > max) caps.push(label);
      cap = Math.min(cap, max);
    };
    if (f.territoryMismatch) apply(RANK.SKIP, "outside Nordics territory");
    if (f.ownedByRep) apply(RANK.SKIP, "already owned by a rep");
    if (f.lowConfidence) apply(RANK.WARM, "no Fit/MRR evidence \u2014 low confidence");
    if (f.lacksValueEvidence) apply(RANK.WARM, "no value (MRR) evidence \u2014 not a top call");
    if (f.thinEvidence) apply(RANK.NURTURE, "thin evidence \u2014 single weak signal");
    return { tier: BY_RANK[Math.min(RANK[tier], cap)], caps };
  }
  function computeFlags(input, cfg, hasWhyNow, valuePresent, coverage) {
    const allowed = new Set(cfg.allowedTerritories.map(normTerritory));
    const terr = normTerritory(input.territory);
    const owner = (input.owner ?? "").trim();
    return {
      hasWhyNow,
      // lowConfidence = NO Fit AND NO MRR evidence. A reported MRR of 0 IS evidence (low-value), so it
      // does NOT count as missing here — only a null/absent MRR does. (negative = invalid data => absent.)
      lowConfidence: input.fitScore == null && (input.predictedMrr == null || input.predictedMrr < 0),
      // No VALUE evidence at all => cannot be HOT (a top call needs both fit AND value). valuePresent is
      // the valueNorm result presence (a reported 0 IS present evidence; only null/absent counts as missing).
      lacksValueEvidence: !valuePresent,
      // A lone weak dimension (coverage below the floor — e.g. only industryFit/sizeFit present) is too
      // thin to justify more than NURTURE, even though re-normalization inflates its score.
      thinEvidence: coverage > 0 && coverage < COVERAGE_FLOOR,
      // Gated on enforceViewFilters (DEFAULT OFF): the view already filters Nordic+open, and re-deriving
      // these from scraped DOM text is unreliable. Off => never cap on territory/owner (trust the view).
      territoryMismatch: cfg.enforceViewFilters && terr !== "" && !allowed.has(terr),
      ownedByRep: cfg.enforceViewFilters && owner !== "" && owner.trim().toLowerCase() !== cfg.openOwnerValue.trim().toLowerCase()
    };
  }
  function buildSignals(input, norms) {
    const out = [];
    if (input.fitScore != null) out.push(`HubSpot Fit Score ${input.fitScore}/10`);
    if (input.predictedMrr != null && input.predictedMrr > 0) out.push(`Predicted MRR ${Math.round(input.predictedMrr)}`);
    if (isHighFitIndustry(input.industry, input.industryAlt)) {
      out.push(`HubSpot-shaped vertical (${input.industry || input.industryAlt})`);
    }
    if (input.employeeCount != null) out.push(`${input.employeeCount} employees`);
    if (input.newHire === true) out.push("New GTM-leadership hire (LinkedIn signal)");
    else if (norms.whyNow != null && norms.whyNow > 0) out.push("Compelling reason to reach out");
    return out;
  }
  function scoreAccount(input, cfg = DEFAULT_SCORING_CONFIG) {
    const revenue = input.annualRevenue;
    const whyNow = whyNowNorm(input.newHire, input.reasonsText);
    const fitResearched = (input.researchedFields ?? []).includes("fitScore");
    const fitRaw = fitNorm(input.fitScore);
    const fitSignal = fitRaw != null && fitResearched ? fitRaw * RESEARCHED_FIT_HAIRCUT : fitRaw;
    const rawNorms = {
      fitSignal,
      valueSignal: valueNorm(input.predictedMrr, cfg.mrrK),
      sizeFit: sizeFitNorm(input.employeeCount, revenue),
      industryFit: industryFitNorm(input.industry, input.industryAlt),
      // null when industry is unknown/blank
      whyNow
      // additive-only: 0 when absent (does not lower the score)
    };
    const evidenceKeys = ["fitSignal", "valueSignal", "sizeFit", "industryFit"];
    let presentWeight = 0;
    let weighted = 0;
    for (const k of evidenceKeys) {
      const v = rawNorms[k];
      if (v != null) {
        presentWeight += WEIGHTS[k];
        weighted += v * WEIGHTS[k];
      }
    }
    const evidenceBudget = 100 - WEIGHTS.whyNow;
    const evidenceScore = presentWeight > 0 ? weighted / presentWeight * evidenceBudget : 0;
    const whyNowScore = whyNow * WEIGHTS.whyNow;
    const clamped = Math.max(0, Math.min(100, evidenceScore + whyNowScore));
    let covWeight = presentWeight;
    if (whyNow > 0) covWeight += WEIGHTS.whyNow;
    const coverage = covWeight / 100;
    const flags = computeFlags(input, cfg, whyNow > 0, rawNorms.valueSignal != null, coverage);
    const baseTier = tierOf(clamped);
    const { tier, caps } = applyTierCaps(baseTier, flags);
    const inputs = WEIGHT_ORDER.map((k) => rawNorms[k] ?? 0);
    const evScale = presentWeight > 0 ? evidenceBudget / presentWeight : 0;
    const breakdown = {};
    const nominalBreakdown = {};
    for (const k of WEIGHT_ORDER) {
      if (k === "whyNow") {
        breakdown[k] = round(whyNowScore);
        nominalBreakdown[k] = round(whyNowScore);
      } else {
        breakdown[k] = round((rawNorms[k] ?? 0) * WEIGHTS[k] * evScale);
        nominalBreakdown[k] = round((rawNorms[k] ?? 0) * WEIGHTS[k]);
      }
    }
    const breakdownRescaled = presentWeight > 0 && presentWeight < evidenceBudget;
    return {
      score: round(clamped),
      tier,
      baseTier,
      caps,
      breakdown,
      nominalBreakdown,
      breakdownRescaled,
      coverage: round(coverage, 2),
      confidence: flags.lowConfidence ? "LOW" : coverage >= 0.6 ? "HIGH" : coverage >= 0.35 ? "MEDIUM" : "LOW",
      flags,
      signals: buildSignals(input, rawNorms),
      inputs,
      researchedFields: input.researchedFields ?? []
    };
  }

  // src/shared/install-base.ts
  var IB_WEIGHTS = {
    seatUtilization: 25,
    daysToRenewal: 25,
    userGrowth90d: 20,
    healthScore: 15,
    crossSellGap: 15
  };
  var IB_ORDER = ["seatUtilization", "daysToRenewal", "userGrowth90d", "healthScore", "crossSellGap"];
  var round2 = (n, dp = 1) => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  };
  function piecewise2(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
      }
    }
    return last[1];
  }
  var SEAT_PTS = [[0, 0], [50, 0.2], [70, 0.6], [90, 1], [100, 1]];
  var RENEWAL_PTS = [[0, 0.3], [30, 1], [120, 1], [180, 0.5], [365, 0.1]];
  var GROWTH_PTS = [[-100, 0], [0, 0.3], [20, 0.7], [50, 1], [100, 1]];
  var HEALTH_PTS = [[0, 0], [50, 0.4], [75, 0.8], [90, 1], [100, 1]];
  var GAP_PTS = [[0, 0], [1, 0.4], [2, 0.7], [3, 1], [4, 1]];
  var part = (v, pts, sig) => v == null ? { present: false, norm: 0 } : { present: true, norm: piecewise2(v, pts), signal: sig?.(v) };
  function scoreInstallBase(input) {
    const parts = {
      seatUtilization: part(input.seatUtilizationPct, SEAT_PTS, (v) => v >= 90 ? `Seats ${v}% utilized (near cap)` : void 0),
      daysToRenewal: part(input.daysToRenewal, RENEWAL_PTS, (v) => v <= 120 ? `Renewal in ${v}d` : void 0),
      userGrowth90d: part(input.userGrowth90dPct, GROWTH_PTS, (v) => v >= 20 ? `+${v}% users (90d)` : void 0),
      healthScore: part(input.healthScore, HEALTH_PTS),
      crossSellGap: part(input.crossSellGap, GAP_PTS, (v) => v >= 1 ? `${v} product gap` : void 0)
    };
    let score = 0;
    let presentWeight = 0;
    const breakdown = {};
    for (const k of IB_ORDER) {
      score += parts[k].norm * IB_WEIGHTS[k];
      breakdown[k] = round2(parts[k].norm * IB_WEIGHTS[k]);
      if (parts[k].present) presentWeight += IB_WEIGHTS[k];
    }
    const clamped = Math.max(0, Math.min(100, score));
    const coverage = presentWeight / 100;
    const confidence = coverage >= 0.7 ? "HIGH" : coverage >= 0.4 ? "MEDIUM" : "LOW";
    const signals = IB_ORDER.flatMap((k) => parts[k].signal ? [parts[k].signal] : []);
    return { score: round2(clamped), tier: tierOf(clamped), breakdown, coverage: round2(coverage, 2), confidence, signals };
  }

  // src/shared/sourcing.ts
  var BOOST_WEIGHT = { small: 1, medium: 2, large: 3 };
  var norm = (v) => String(v ?? "").trim().toLowerCase();
  var num2 = (v) => typeof v === "number" ? v : num(v) ?? NaN;
  function matchValue(actual, op, value) {
    switch (op) {
      case "known":
        return actual != null && actual !== "";
      case "unknown":
        return actual == null || actual === "";
      case "is":
        return norm(actual) === norm(value);
      case "is_not":
        return norm(actual) !== norm(value);
      case "gte":
        return Number.isFinite(num2(actual)) && num2(actual) >= num2(value);
      case "lte":
        return Number.isFinite(num2(actual)) && num2(actual) <= num2(value);
      case "within_days":
        return Number.isFinite(num2(actual)) && num2(actual) <= num2(value);
      case "between": {
        const [lo, hi] = value ?? [NaN, NaN];
        const a = num2(actual);
        return Number.isFinite(a) && a >= lo && a <= hi;
      }
      case "one_of":
        return Array.isArray(value) && value.some((v) => norm(v) === norm(actual));
      case "contains":
        return norm(actual).includes(norm(value));
      default:
        return false;
    }
  }
  function ruleHolds(rule, account) {
    if (rule.level === "company") {
      return matchValue(account.company[rule.property], rule.op, rule.value);
    }
    const q = rule.quantifier ?? "any";
    if (account.contacts.length === 0) return false;
    const per = (c) => matchValue(c[rule.property], rule.op, rule.value);
    return q === "all" ? account.contacts.every(per) : account.contacts.some(per);
  }
  function evaluateSourcing(recipe, account) {
    const companyMust = recipe.must.filter((r) => r.level === "company");
    const contactMust = recipe.must.filter((r) => r.level === "contact");
    const failedMust = companyMust.filter((r) => !ruleHolds(r, account));
    const companyOk = failedMust.length === 0;
    let contactOk = true;
    if (contactMust.length > 0) {
      const mode = recipe.contactMustMode ?? "all";
      contactOk = mode === "any" ? contactMust.some((r) => ruleHolds(r, account)) : contactMust.every((r) => ruleHolds(r, account));
      if (!contactOk) failedMust.push(...contactMust.filter((r) => !ruleHolds(r, account)));
    }
    const matchedBoosts = (recipe.boost ?? []).filter((r) => ruleHolds(r, account));
    const boostScore = matchedBoosts.reduce((s, r) => s + BOOST_WEIGHT[r.boost ?? "small"], 0);
    return { eligible: companyOk && contactOk, failedMust, boostScore, matchedBoosts };
  }

  // src/shared/gong.ts
  function assessDealHealth(call) {
    const out = [];
    if (call.talkRatioPct != null) {
      out.push(call.talkRatioPct > 65 ? { key: "talk_ratio", severity: "risk", note: `rep talked ${call.talkRatioPct}% (not listening)` } : { key: "talk_ratio", severity: "ok", note: "balanced talk time" });
    }
    if (call.hasNextStep === false) out.push({ key: "next_steps", severity: "risk", note: "no concrete next step" });
    if ((call.competitorMentions ?? 0) > 0) {
      out.push({ key: "competitor", severity: "watch", note: `${call.competitorMentions} competitor mention(s)` });
    }
    if (call.sentiment === "negative") out.push({ key: "sentiment", severity: "risk", note: "negative sentiment" });
    if (call.daysSinceCall != null && call.daysSinceCall > 14) {
      out.push({ key: "staleness", severity: "watch", note: `${call.daysSinceCall}d since last call` });
    }
    return out;
  }
  function dealHealthScore(signals) {
    const penalty = signals.reduce((s, x) => s + (x.severity === "risk" ? 30 : x.severity === "watch" ? 10 : 0), 0);
    const score = Math.max(0, 100 - penalty);
    const worst = signals.some((x) => x.severity === "risk") ? "risk" : signals.some((x) => x.severity === "watch") ? "watch" : "ok";
    return { score, worst };
  }

  // src/tools/playground.ts
  var $ = (id) => document.getElementById(id);
  var numOrNull = (id) => {
    const v = $(id)?.value.trim();
    return v == null || v === "" ? null : Number(v);
  };
  var valOf = (id) => $(id)?.value ?? "";
  var show = (id, data) => {
    const el = $(id);
    if (el) el.textContent = JSON.stringify(data, null, 2);
  };
  function runScore() {
    const input = {
      name: valOf("name") || null,
      domain: valOf("domain") || null,
      fitScore: numOrNull("fitScore"),
      predictedMrr: numOrNull("predictedMrr"),
      employeeCount: numOrNull("emp"),
      annualRevenue: parseRevenue(valOf("revenue")),
      industry: valOf("industry") || null,
      industryAlt: valOf("industryAlt") || null,
      reasonsText: valOf("reasons") || null,
      newHire: valOf("newHire") === "yes" ? true : null,
      territory: valOf("territory") || null,
      owner: valOf("owner") || null
    };
    show("scoreOut", scoreAccount(input));
  }
  function runIb() {
    const input = {
      seatUtilizationPct: numOrNull("seat"),
      daysToRenewal: numOrNull("renewal"),
      userGrowth90dPct: numOrNull("growth"),
      healthScore: numOrNull("health"),
      crossSellGap: numOrNull("gap")
    };
    show("ibOut", scoreInstallBase(input));
  }
  function runSourcing() {
    try {
      const recipe = JSON.parse(valOf("recipe"));
      const account = JSON.parse(valOf("account"));
      show("sourcingOut", evaluateSourcing(recipe, account));
    } catch (e) {
      show("sourcingOut", { error: String(e) });
    }
  }
  function runGong() {
    const call = {
      callId: "test",
      talkRatioPct: numOrNull("talk") ?? void 0,
      hasNextStep: valOf("nextstep") === "yes",
      competitorMentions: numOrNull("comp") ?? void 0,
      sentiment: valOf("sentiment") || void 0,
      daysSinceCall: numOrNull("since") ?? void 0
    };
    const signals = assessDealHealth(call);
    show("gongOut", { signals, ...dealHealthScore(signals) });
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("scoreBtn")?.addEventListener("click", runScore);
    $("ibBtn")?.addEventListener("click", runIb);
    $("sourcingBtn")?.addEventListener("click", runSourcing);
    $("gongBtn")?.addEventListener("click", runGong);
    runScore();
    runIb();
    runSourcing();
    runGong();
  });
})();
