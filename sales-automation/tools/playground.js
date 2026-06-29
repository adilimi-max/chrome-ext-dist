"use strict";
(() => {
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
  function recency(days, full, zero) {
    if (days == null || days < 0) return 0;
    if (days <= full) return 1;
    if (days >= zero) return 0;
    return 1 - (days - full) / (zero - full);
  }
  var GTM_FN = /\b(sales|revenue|revops|rev ops|marketing|growth|commercial|demand[\s-]?gen|cco|cro|cmo|cso)\b/i;
  var NORDIC_GTM = /(försäljnings|forsaljnings|salgs|myynti|markkinointi|marknads|kommersiel)/i;
  var ANTI_FN = /\b(cfo|cto|coo|chro|controller|ciso|finance|financial|engineering|product|people|\bhr\b|talent)\b/i;
  var SENIOR = /\b(chief|c[a-z]o\b|vp|vice president|svp|evp|head of|director|direkt[oö]r|chef|johtaja|lead of)\b/i;
  var MID = /\b(manager|chef|lead|principal)\b/i;
  function hireMomentum(title, daysAgo) {
    if (!title || !title.trim()) return 0;
    const t = title.toLowerCase();
    const isGtm = GTM_FN.test(t) || NORDIC_GTM.test(t);
    if (!isGtm) return ANTI_FN.test(t) ? 0 : 0.05;
    const seniority = SENIOR.test(t) ? 1 : MID.test(t) ? 0.5 : 0.25;
    const r = daysAgo == null ? 0.5 : daysAgo < 10 ? 0.8 * recency(daysAgo, 120, 150) : recency(daysAgo, 120, 150);
    return seniority * r;
  }
  var FULL_STAGES = /* @__PURE__ */ new Set(["seed", "series-a", "series_a", "series-b", "series_b", "growth", "growth-equity"]);
  var WEAK_STAGES = /* @__PURE__ */ new Set(["pre-seed", "pre_seed", "late", "series-c", "series-d", "ipo"]);
  var NON_GTM_FUNDING = /* @__PURE__ */ new Set(["debt", "grant", "bridge", "down-round"]);
  function fundingMomentum(daysAgo, stage) {
    if (daysAgo == null || daysAgo < 0) return 0;
    const s = (stage ?? "").toLowerCase().replace(/\s+/g, "-");
    if (NON_GTM_FUNDING.has(s)) return 0;
    const stageMult = FULL_STAGES.has(s) ? 1 : WEAK_STAGES.has(s) ? 0.4 : 0.7;
    return stageMult * recency(daysAgo, 180, 270);
  }
  function headcountMomentum(deltaPct) {
    if (deltaPct == null) return 0;
    return piecewise(deltaPct, [[0, 0], [10, 0.3], [20, 0.7], [40, 1], [100, 1]]);
  }
  function gtmMomentum(parts) {
    const xs = [parts.hire, parts.funding, parts.headcount].sort((a, b) => b - a);
    const corroboration = 0.15 * (xs.filter((x) => x > 0.2).length - 1 > 0 ? xs.filter((x) => x > 0.2).length - 1 : 0);
    return Math.min(1, xs[0] + corroboration);
  }
  var PT_PTS = [[0, 0], [20, 0.2], [40, 0.4], [60, 0.7], [80, 1], [100, 1]];
  var MHIT_PTS = [[0, 0], [40, 0.4], [60, 0.667], [80, 1], [100, 1]];
  var MR_PTS = [[0, 0], [30, 0.333], [50, 0.667], [70, 1], [100, 1]];
  var TM_PTS = [[0, 0], [30, 0.3], [50, 0.7], [70, 1], [100, 1]];
  var PV_PTS = [[0, 0], [5, 0.375], [20, 0.625], [50, 1]];
  function intentComposite(p) {
    const intentRecency = recency(p.productDaysAgo, 30, 90);
    const subs = [];
    if (p.pt != null) subs.push(piecewise(p.pt, PT_PTS));
    if (p.mhit != null) subs.push(piecewise(p.mhit, MHIT_PTS));
    if (p.productCount > 0) subs.push(Math.min(1, p.productCount / 3) * (0.5 + 0.5 * intentRecency));
    if (p.pageViews != null) subs.push(piecewise(p.pageViews, PV_PTS) * (0.4 + 0.6 * intentRecency));
    if (p.mr != null) {
      const level = piecewise(p.mr, MR_PTS);
      const momentum = p.threeM != null ? Math.max(0, Math.min(0.2, (p.mr - p.threeM) / 100)) : 0;
      subs.push(Math.min(1, level * 0.85 + momentum));
    } else if (p.threeM != null) {
      subs.push(piecewise(p.threeM, TM_PTS) * 0.7);
    }
    subs.sort((a, b) => b - a);
    const w = [1, 0.45, 0.25, 0.15, 0.1];
    const raw = subs.reduce((s, v, i) => s + v * (w[i] ?? 0.05), 0);
    return Math.min(1, raw);
  }
  var OVERINDEX = /(software|saas|information technology|it services|internet|professional services|e-?commerce|fintech|financial technology|health ?tech|technology)/i;
  var SIZE_PTS = [[0, 0], [30, 0.5], [50, 1], [500, 1], [600, 0.5], [1e3, 0.1]];
  function industrySizeFit(industry, employees) {
    const sizeCurve = employees == null ? 0.5 : piecewise(employees, SIZE_PTS);
    const industryMult = industry == null ? 0.6 : OVERINDEX.test(industry) ? 1 : 0.5;
    return sizeCurve * industryMult;
  }
  var DISPLACEABLE = /* @__PURE__ */ new Set(["none", "pipedrive", "zoho", "superoffice", "lime", "upsales", "hubspot-free", "hubspot-starter"]);
  var ENTRENCHED = /* @__PURE__ */ new Set(["salesforce", "dynamics", "ms-dynamics"]);
  function crmDisplaceability(crm) {
    const c = (crm ?? "unknown").toLowerCase();
    if (DISPLACEABLE.has(c)) return 1;
    if (ENTRENCHED.has(c)) return 0.1;
    return 0.4;
  }
  var isOverIndexIndustry = (s) => s != null && OVERINDEX.test(s);
  var isEntrenchedCrm = (c) => ENTRENCHED.has((c ?? "").toLowerCase());
  function engagementNorm(e) {
    if (e === "negative") return -1;
    if (e === "positive") return 0.7;
    return 0;
  }
  function contentEngagementNorm(ce) {
    if (!ce) return 0;
    const fresh = recency(ce.lastViewedDaysAgo ?? null, 7, 30);
    const dwell = ce.dwellSec == null ? 0 : piecewise(ce.dwellSec, [[0, 0], [30, 0.3], [120, 0.7], [300, 1]]);
    const base = Math.max(dwell, ce.forwarded ? 0.9 : 0);
    return base * (0.4 + 0.6 * fresh);
  }

  // src/shared/scoring.ts
  var WEIGHTS = {
    gtmMomentum: 30,
    // funding + GTM hire + headcount, collapsed (the user's headline signal)
    intentComposite: 26,
    // de-correlated native intent (was 72 of double-counting)
    industrySizeFit: 20,
    // HubSpot-shaped vertical x 50-500 sweet-spot curve
    crmDisplacement: 14,
    // confidence-weighted (never assume greenfield)
    engagement: 10
    // asymmetric suppressor
  };
  var WEIGHT_ORDER = ["gtmMomentum", "intentComposite", "industrySizeFit", "crmDisplacement", "engagement"];
  function tierOf(score2) {
    if (score2 >= 75) return "HOT";
    if (score2 >= 50) return "WARM";
    if (score2 >= 30) return "NURTURE";
    return "SKIP";
  }
  function score(inputs) {
    if (inputs.length !== WEIGHT_ORDER.length) {
      throw new RangeError(`score() expects ${WEIGHT_ORDER.length} dimension inputs, got ${inputs.length}`);
    }
    let total = 0;
    for (let i = 0; i < WEIGHT_ORDER.length; i++) total += inputs[i] * WEIGHTS[WEIGHT_ORDER[i]];
    return total;
  }
  var round = (n, dp = 1) => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  };
  var RANK = { SKIP: 0, NURTURE: 1, WARM: 2, HOT: 3 };
  var BY_RANK = ["SKIP", "NURTURE", "WARM", "HOT"];
  var NORDIC_CCTLD = /* @__PURE__ */ new Set([".se", ".no", ".dk", ".fi", ".is"]);
  function applyTierCaps(tier, f) {
    let cap = RANK.HOT;
    const caps = [];
    const apply = (max, label) => {
      if (RANK[tier] > max) caps.push(label);
      cap = Math.min(cap, max);
    };
    if (f.notWorkable) apply(RANK.SKIP, "not yours to work");
    if (f.antiFit) apply(RANK.SKIP, "agency / HubSpot partner");
    if (f.entrenchedSfdc) apply(RANK.NURTURE, "entrenched Salesforce at scale");
    if (f.foreignSubsidiary) apply(RANK.NURTURE, "no-autonomy subsidiary");
    if (!f.hasLiveTrigger) apply(RANK.NURTURE, "no live why-now (stale)");
    if (f.anonymous) apply(RANK.NURTURE, "no reachable buyer");
    if (f.dangerCell) apply(RANK.WARM, "looks like a Salesforce target \u2014 verify");
    if (f.lowConfidenceGeo) apply(RANK.WARM, "geography unconfirmed");
    if (f.enrichmentOnly) apply(RANK.WARM, "enrichment-only \u2014 needs a native signal");
    return { tier: BY_RANK[Math.min(RANK[tier], cap)], caps };
  }
  function computeFlags(input, m) {
    const lifecycle = (input.lifecycleStage ?? "").toLowerCase();
    const nativeIntent = input.ptScore != null || input.mhit != null || input.mrAccountIntent != null || input.engagement != null || input.productIntents.some((p) => p.hasIntent);
    const crm = (input.currentCrm ?? "unknown").toLowerCase();
    const ce = input.contentEngagement ?? null;
    const liveContentView = ce != null && (ce.forwarded || (ce.dwellSec ?? 0) > 0) && (ce.lastViewedDaysAgo == null || ce.lastViewedDaysAgo <= 14);
    const detectedSfdcConfident = isEntrenchedCrm(crm) && (input.currentCrmConfidence !== "low" || (input.competitorMentions ?? 0) >= 1);
    return {
      hasLiveTrigger: m.hire > 0.25 || m.funding > 0.25 || m.headcount > 0.25 || m.freshestIntent != null && m.freshestIntent <= 90 || liveContentView,
      lowConfidenceGeo: input.country == null,
      enrichmentOnly: !nativeIntent && ce == null && (input.fundingDaysAgo != null || input.currentCrm != null || input.headcountDeltaPct != null),
      antiFit: input.isPartner === true,
      notWorkable: input.ownedByOther === true || ["customer", "evangelist", "opportunity"].includes(lifecycle),
      anonymous: input.reachableBuyer === false && !liveContentView,
      // an active content viewer is reachable
      entrenchedSfdc: input.entrenchedSalesforce === true || detectedSfdcConfident,
      foreignSubsidiary: input.isForeignSubsidiary === true,
      dangerCell: (m.funding > 0.3 || m.headcount > 0.3) && (crm === "unknown" || isEntrenchedCrm(crm)) && !isOverIndexIndustry(input.industry)
    };
  }
  function buildSignals(input, m) {
    const out = [];
    if (m.hire > 0.3) out.push(`Fresh GTM-leadership hire${input.jobChangeTitle ? ` (${input.jobChangeTitle})` : ""}`);
    if (m.funding > 0.3) out.push(`Recent funding${input.fundingStage ? ` (${input.fundingStage})` : ""}`);
    if (m.headcount > 0.3) out.push(`Headcount growing +${input.headcountDeltaPct}%`);
    if (isOverIndexIndustry(input.industry)) out.push(`HubSpot-shaped vertical (${input.industry})`);
    if (input.currentCrm && crmDisplaceability(input.currentCrm) >= 0.9) out.push(`On a displaceable CRM (${input.currentCrm})`);
    if (input.engagement === "positive") out.push("Positive engagement");
    if (input.engagement === "negative") out.push("Negative engagement (suppressed)");
    return out;
  }
  function scoreAccount(input) {
    const intentful = input.productIntents.filter((p) => p.hasIntent);
    const days = intentful.map((p) => p.daysSinceSignal).filter((d) => d != null);
    const freshestIntent = days.length ? Math.min(...days) : null;
    const hire = input.jobChangeTitle != null ? hireMomentum(input.jobChangeTitle, input.jobChangeDaysAgo ?? null) : input.jobChange === "leadership" ? 0.55 : input.jobChange === "other" ? 0.15 : 0;
    const funding = fundingMomentum(input.fundingDaysAgo, input.fundingStage);
    const headcount = headcountMomentum(input.headcountDeltaPct);
    const norms = {
      gtmMomentum: gtmMomentum({ hire, funding, headcount }),
      intentComposite: intentComposite({ pt: input.ptScore, mhit: input.mhit, productCount: intentful.length, productDaysAgo: freshestIntent, mr: input.mrAccountIntent, threeM: input.threeMonthIntent, pageViews: input.pageViews }),
      industrySizeFit: industrySizeFit(input.industry, input.employeeCount),
      crmDisplacement: crmDisplaceability(input.currentCrm),
      // A genuine "unsubscribe" stays dominant; otherwise take the strongest of email-polarity and
      // Seismic content engagement (a forwarded asset is a strong, de-correlated warmth signal).
      engagement: input.engagement === "negative" ? -1 : Math.max(engagementNorm(input.engagement), contentEngagementNorm(input.contentEngagement))
    };
    const dims = WEIGHT_ORDER.map((k) => norms[k]);
    const corro = (NORDIC_CCTLD.has((input.domainCcTld ?? "").toLowerCase()) ? 2 : 0) + (input.trafficTrendUp ? 2 : 0);
    const clamped = Math.max(0, Math.min(100, score(dims) + corro));
    const flags = computeFlags(input, { hire, funding, headcount, freshestIntent });
    const baseTier = tierOf(clamped);
    const { tier, caps } = applyTierCaps(baseTier, flags);
    const present = {
      gtmMomentum: input.fundingDaysAgo != null || input.jobChange != null || input.jobChangeTitle != null || input.headcountDeltaPct != null,
      intentComposite: input.ptScore != null || input.mhit != null || input.mrAccountIntent != null || input.threeMonthIntent != null || input.pageViews != null || intentful.length > 0,
      industrySizeFit: input.industry != null || input.employeeCount != null,
      crmDisplacement: input.currentCrm != null,
      engagement: input.engagement != null || input.contentEngagement != null
    };
    const presentWeight = WEIGHT_ORDER.reduce((s, k) => s + (present[k] ? WEIGHTS[k] : 0), 0);
    const coverage = presentWeight / 100;
    const breakdown = {};
    for (const k of WEIGHT_ORDER) breakdown[k] = round(norms[k] * WEIGHTS[k]);
    return {
      score: round(clamped),
      tier,
      baseTier,
      caps,
      breakdown,
      coverage: round(coverage, 2),
      confidence: coverage >= 0.6 ? "HIGH" : coverage >= 0.35 ? "MEDIUM" : "LOW",
      flags,
      signals: buildSignals(input, { hire, funding, headcount }),
      inputs: dims
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
    let score2 = 0;
    let presentWeight = 0;
    const breakdown = {};
    for (const k of IB_ORDER) {
      score2 += parts[k].norm * IB_WEIGHTS[k];
      breakdown[k] = round2(parts[k].norm * IB_WEIGHTS[k]);
      if (parts[k].present) presentWeight += IB_WEIGHTS[k];
    }
    const clamped = Math.max(0, Math.min(100, score2));
    const coverage = presentWeight / 100;
    const confidence = coverage >= 0.7 ? "HIGH" : coverage >= 0.4 ? "MEDIUM" : "LOW";
    const signals = IB_ORDER.flatMap((k) => parts[k].signal ? [parts[k].signal] : []);
    return { score: round2(clamped), tier: tierOf(clamped), breakdown, coverage: round2(coverage, 2), confidence, signals };
  }

  // src/shared/sourcing.ts
  var BOOST_WEIGHT = { small: 1, medium: 2, large: 3 };
  var norm = (v) => String(v ?? "").trim().toLowerCase();
  var num = (v) => typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
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
        return Number.isFinite(num(actual)) && num(actual) >= num(value);
      case "lte":
        return Number.isFinite(num(actual)) && num(actual) <= num(value);
      case "within_days":
        return Number.isFinite(num(actual)) && num(actual) <= num(value);
      case "between": {
        const [lo, hi] = value ?? [NaN, NaN];
        const a = num(actual);
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
    const score2 = Math.max(0, 100 - penalty);
    const worst = signals.some((x) => x.severity === "risk") ? "risk" : signals.some((x) => x.severity === "watch") ? "watch" : "ok";
    return { score: score2, worst };
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
    const count = Number(valOf("pi_count") || "0");
    const freshest = numOrNull("pi_days");
    const products = ["sales", "service", "marketing", "crm"];
    const reachable = valOf("reachable");
    const input = {
      ptScore: numOrNull("ptScore"),
      mhit: numOrNull("mhit"),
      productIntents: Array.from({ length: count }, (_, i) => ({ product: products[i % 4], hasIntent: true, daysSinceSignal: freshest })),
      mrAccountIntent: numOrNull("mr"),
      threeMonthIntent: numOrNull("tm"),
      pageViews: numOrNull("pv"),
      fundingDaysAgo: numOrNull("fundingDays"),
      fundingStage: valOf("fundingStage") || null,
      jobChange: null,
      jobChangeTitle: valOf("hireTitle") || null,
      jobChangeDaysAgo: numOrNull("hireDays"),
      headcountDeltaPct: numOrNull("headcount"),
      employeeCount: numOrNull("emp"),
      industry: valOf("industry") || null,
      country: valOf("country") || null,
      currentCrm: valOf("crm") || null,
      engagement: valOf("engagement") || null,
      reachableBuyer: reachable === "no" ? false : reachable === "yes" ? true : null,
      ownedByOther: valOf("owned") === "yes" ? true : null,
      entrenchedSalesforce: valOf("sfdc") === "yes" ? true : null
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
