"use strict";
(() => {
  // src/shared/storage.ts
  var SCHEMA_VERSION = 3;
  var CorruptKeyError = class extends Error {
    constructor(key) {
      super(`Storage key "${key}" holds a corrupt (unparseable) value`);
      this.key = key;
      this.name = "CorruptKeyError";
    }
  };
  function serializeOrThrow(value, key) {
    if (value instanceof Map || value instanceof Set) {
      throw new TypeError(
        `Storage value for "${key}" is a ${value.constructor.name}; JSON silently drops it. Convert to a plain array/object first.`
      );
    }
    const s = JSON.stringify(value);
    if (s === void 0) {
      throw new TypeError(
        `Storage value for "${key}" is not JSON-serializable (top-level undefined, function, or symbol).`
      );
    }
    return s;
  }
  function makeStorage(backend) {
    const chains = /* @__PURE__ */ new Map();
    const phys = (key) => `v${SCHEMA_VERSION}:${key}`;
    async function rawGet(key) {
      const raw = await backend.getRaw(phys(key));
      if (raw === void 0) return void 0;
      try {
        return JSON.parse(raw);
      } catch {
        throw new CorruptKeyError(key);
      }
    }
    return {
      async get(key) {
        return rawGet(key);
      },
      async getOr(key, fallback) {
        try {
          const v = await rawGet(key);
          return v === void 0 ? fallback : v;
        } catch {
          return fallback;
        }
      },
      async set(key, value) {
        await backend.setRaw(phys(key), serializeOrThrow(value, key));
      },
      async remove(key) {
        await backend.removeRaw(phys(key));
      },
      update(key, fn) {
        const prev = chains.get(key) ?? Promise.resolve();
        const next = prev.then(async () => {
          let cur;
          try {
            cur = await rawGet(key);
          } catch {
            cur = void 0;
          }
          const updated = fn(cur);
          await backend.setRaw(phys(key), serializeOrThrow(updated, key));
          return updated;
        });
        chains.set(
          key,
          next.then(
            () => void 0,
            () => void 0
          )
        );
        return next;
      }
    };
  }
  function chromeBackend() {
    return {
      async getRaw(k) {
        const r = await chrome.storage.local.get(k);
        return r[k];
      },
      async setRaw(k, v) {
        await chrome.storage.local.set({ [k]: v });
      },
      async removeRaw(k) {
        await chrome.storage.local.remove(k);
      }
    };
  }

  // src/shared/delay.ts
  var MIN_DELAY_MS = 2e3;
  var MAX_DELAY_MS = 8e3;
  function pickDelayMs(rand = Math.random) {
    return Math.floor(MIN_DELAY_MS + rand() * (MAX_DELAY_MS - MIN_DELAY_MS));
  }
  function humanDelay(opts = {}) {
    const rand = opts.rand ?? Math.random;
    const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    return sleep(pickDelayMs(rand));
  }

  // src/shared/sentinel.ts
  var SENTINEL_RE = /§§BEGIN ([0-9a-f]{8})§§([\s\S]*?)§§END \1§§/g;
  function locateSentinelBlock(text, expectedNonce) {
    const blocks = [];
    for (const m of text.matchAll(SENTINEL_RE)) {
      blocks.push({ nonce: m[1], inner: m[2].trim() });
    }
    if (blocks.length === 0) return null;
    if (expectedNonce) {
      const matches = blocks.filter((b) => b.nonce === expectedNonce);
      if (matches.length) return matches[matches.length - 1];
    }
    return blocks[blocks.length - 1];
  }
  function verifyNonce(block, expected) {
    return block.nonce === expected;
  }
  function makeNonce() {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  // src/shared/egress.ts
  var EgressViolationError = class extends Error {
    constructor(reason) {
      super(`Egress blocked: ${reason}`);
      this.reason = reason;
      this.name = "EgressViolationError";
    }
  };
  var ZERO_WIDTH = /[​-‍﻿]/g;
  var EMAIL = /[^\s@]+@[^\s@]+/;
  var URL = /\bhttps?:\/\/|\bwww\./i;
  var DOMAIN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
  var PHONE = /(?:\d[\s().-]*){7,}/;
  var MAX_LEN = 80;
  var MAX_WORDS = 12;
  function collectStrings(value, out) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
  }
  var wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;
  function assertEgressSafe(payload, forbiddenTokens = []) {
    const strings = [];
    collectStrings(payload, strings);
    for (const raw of strings) {
      const s = raw.replace(ZERO_WIDTH, "");
      if (EMAIL.test(s)) throw new EgressViolationError("email address");
      if (PHONE.test(s)) throw new EgressViolationError("phone number");
      if (URL.test(s) || DOMAIN.test(s)) throw new EgressViolationError("URL or domain");
      if (s.length > MAX_LEN) throw new EgressViolationError("free-text body (length)");
      if (wordCount(s) > MAX_WORDS) throw new EgressViolationError("free-text body (words)");
      const low = s.toLowerCase();
      for (const t of forbiddenTokens) {
        if (t && low.includes(t.toLowerCase())) throw new EgressViolationError(`forbidden token "${t}"`);
      }
    }
  }
  var RESEARCH_DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
  var NAME_MAX_LEN = 80;
  var NAME_PHONE = /(?:\d[\s().-]*){7,}/;
  var NAME_CONTROL = /[\x00-\x1f\x7f]/;
  function assertResearchEgressSafe(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new EgressViolationError("research payload must be a {name, domain} object");
    }
    const keys = Object.keys(payload).sort();
    if (keys.length !== 2 || keys[0] !== "domain" || keys[1] !== "name") {
      throw new EgressViolationError(`research payload keys must be exactly {name, domain}, got {${keys.join(", ")}}`);
    }
    const { name, domain } = payload;
    if (typeof name !== "string") throw new EgressViolationError("research name must be a string");
    const n = name.replace(ZERO_WIDTH, "").trim();
    if (n.length === 0) throw new EgressViolationError("research name is empty");
    if (n.length > NAME_MAX_LEN) throw new EgressViolationError("research name too long (looks like a body)");
    if (NAME_CONTROL.test(n)) throw new EgressViolationError("research name contains control chars/newlines");
    if (EMAIL.test(n)) throw new EgressViolationError("research name is an email address");
    if (NAME_PHONE.test(n)) throw new EgressViolationError("research name contains a phone number");
    if (URL.test(n)) throw new EgressViolationError("research name is a URL");
    if (DOMAIN.test(n)) throw new EgressViolationError("research name contains a domain");
    if (wordCount(n) > 8) throw new EgressViolationError("research name is free text, not a company name");
    if (typeof domain !== "string") throw new EgressViolationError("research domain must be a string");
    const d = domain.replace(ZERO_WIDTH, "").trim();
    if (d.includes("@")) throw new EgressViolationError("research domain is an email address");
    if (!RESEARCH_DOMAIN.test(d)) throw new EgressViolationError("research domain is not a single bare domain token");
  }

  // src/shared/bridge.ts
  var SchemaError = class extends Error {
    constructor(msg = "schema") {
      super(msg);
      this.name = "SchemaError";
    }
  };
  var PlausibilityError = class extends Error {
    constructor(msg = "plausibility") {
      super(msg);
      this.name = "PlausibilityError";
    }
  };
  var DEFAULT_CANARY = {
    prompt: (n) => `Reply with EXACTLY this and nothing else:
\xA7\xA7BEGIN ${n}\xA7\xA7
<response><pong/></response>
\xA7\xA7END ${n}\xA7\xA7`,
    expectedInner: "<pong/>"
  };
  function makeBridge(transport, opts = {}) {
    const nonceFn = opts.nonce ?? makeNonce;
    const canaryCfg = opts.canary ?? DEFAULT_CANARY;
    const slots = /* @__PURE__ */ new Map();
    async function getSlot(chatType) {
      let st = slots.get(chatType);
      if (!st) {
        st = { id: await transport.ensureSlot(chatType), consecutiveBad: 0 };
        slots.set(chatType, st);
      }
      return st;
    }
    async function attempt(c, nonce, slotId) {
      if (c.egressPayload !== void 0) {
        try {
          if (c.egressMode === "research") assertResearchEgressSafe(c.egressPayload);
          else assertEgressSafe(c.egressPayload, c.egressTokens);
        } catch {
          return { ok: false, failure: "egress", nonce };
        }
      }
      await transport.send(slotId, c.render(nonce));
      let raw;
      try {
        raw = await transport.read(slotId, nonce);
      } catch {
        return { ok: false, failure: "timeout", nonce };
      }
      const block = locateSentinelBlock(raw, nonce);
      if (!block) return { ok: false, failure: "no_sentinel", nonce };
      if (!verifyNonce(block, nonce)) return { ok: false, failure: "nonce_mismatch", nonce };
      try {
        return { ok: true, value: c.parse(block.inner), nonce };
      } catch (e) {
        return { ok: false, failure: e instanceof PlausibilityError ? "plausibility" : "schema", nonce };
      }
    }
    async function call(c) {
      const nonce = nonceFn();
      const slot = await getSlot(c.chatType);
      const result = await attempt(c, nonce, slot.id);
      if (c.chatType === "reranking") {
        slot.id = await transport.retire("reranking");
        slot.consecutiveBad = 0;
      } else if (result.failure === "no_sentinel" || result.failure === "nonce_mismatch") {
        slot.consecutiveBad += 1;
        if (slot.consecutiveBad >= 2) {
          slot.id = await transport.retire(c.chatType);
          slot.consecutiveBad = 0;
        }
      } else {
        slot.consecutiveBad = 0;
      }
      return result;
    }
    async function canary() {
      try {
        const nonce = nonceFn();
        const slot = await getSlot("canary");
        await transport.send(slot.id, canaryCfg.prompt(nonce));
        const raw = await transport.read(slot.id, nonce);
        const block = locateSentinelBlock(raw, nonce);
        return !!block && verifyNonce(block, nonce) && block.inner.includes(canaryCfg.expectedInner);
      } catch {
        return false;
      }
    }
    async function peek(chatType, nonce) {
      const slot = await getSlot(chatType);
      let raw;
      try {
        raw = await transport.peek(slot.id);
      } catch {
        return null;
      }
      const block = locateSentinelBlock(raw, nonce);
      return block && verifyNonce(block, nonce) ? block : null;
    }
    return { call, canary, peek };
  }

  // src/background/bridge-dom.ts
  var CLAUDE_URL = "https://claude.ai/new";
  var SEL = {
    input: 'div[contenteditable="true"]',
    send: 'button[aria-label="Send message"]',
    lastAssistant: '[data-testid="assistant-turn"]:last-of-type, .font-claude-message:last-of-type'
  };
  async function findOrCreateTab() {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    if (tabs[0]?.id != null) return tabs[0].id;
    const created = await chrome.tabs.create({ url: CLAUDE_URL, active: false });
    return created.id;
  }
  async function probeClaudeTab() {
    const tabId = await findOrCreateTab();
    await new Promise((r) => setTimeout(r, 3e3));
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const input = document.querySelector('div[contenteditable="true"]');
        if (!input) return { inputFound: false, note: "no contenteditable input" };
        const TOKEN = "PONG7Q";
        input.focus();
        try {
          document.execCommand("selectAll", false);
        } catch {
        }
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, `Reply with exactly this token and nothing else: ${TOKEN}`);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          input.textContent = `Reply with exactly: ${TOKEN}`;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        }
        await sleep(600);
        const allBtns = [...document.querySelectorAll("button")];
        const buttons = allBtns.slice(0, 40).map((b) => ({
          label: b.getAttribute("aria-label"),
          testid: b.getAttribute("data-testid"),
          type: b.getAttribute("type"),
          disabled: b.disabled,
          svg: !!b.querySelector("svg"),
          text: (b.textContent ?? "").trim().slice(0, 24)
        }));
        const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
        Object.defineProperty(enter, "keyCode", { value: 13 });
        Object.defineProperty(enter, "which", { value: 13 });
        input.dispatchEvent(enter);
        let clickedLabel = "Enter key";
        await sleep(400);
        if ((input.textContent ?? "").trim().length > 0) {
          const composer = input.closest("form") ?? input.parentElement?.parentElement ?? document.body;
          const btn = composer.querySelector('button[aria-label*="end" i]') ?? composer.querySelector('button[type="submit"]') ?? [...composer.querySelectorAll("button")].reverse().find((b) => !b.disabled && !!b.querySelector("svg")) ?? null;
          clickedLabel = btn ? btn.getAttribute("aria-label") ?? btn.getAttribute("data-testid") ?? "composer-icon-button" : "none-found";
          btn?.click();
        }
        let responded = false;
        for (let i = 0; i < 16; i++) {
          await sleep(1e3);
          const body = document.body.innerText ?? "";
          if ((body.match(new RegExp(TOKEN, "g")) ?? []).length >= 2) {
            responded = true;
            break;
          }
        }
        let responseCandidates = [];
        if (responded) {
          responseCandidates = [...document.querySelectorAll("*")].filter((el) => el.children.length <= 2 && (el.textContent ?? "").includes(TOKEN) && !el.querySelector("[contenteditable]")).slice(-6).map((el) => ({ tag: el.tagName.toLowerCase(), testid: el.getAttribute("data-testid"), cls: (el.getAttribute("class") ?? "").slice(0, 100) }));
        }
        const testids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid") ?? ""))].filter(Boolean).slice(0, 40);
        return {
          inputFound: true,
          insertMethod: inserted ? "execCommand" : "fallback",
          inputTextNow: (input.textContent ?? "").slice(0, 60),
          buttons,
          clickedLabel,
          responded,
          responseCandidates,
          testids
        };
      }
    });
    return res?.result ?? { inputFound: false, note: "no result from page" };
  }
  function makeBridgeDomTransport() {
    const tabForSlot = /* @__PURE__ */ new Map();
    async function ensureSlot(chatType) {
      const tabId = await findOrCreateTab();
      tabForSlot.set(chatType, tabId);
      return `${chatType}@${tabId}`;
    }
    async function send(slotId, prompt) {
      const tabId = Number(slotId.split("@")[1]);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async (sel, text) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const input = document.querySelector(sel.input);
          if (!input) throw new Error("claude.ai input not found");
          input.focus();
          try {
            document.execCommand("selectAll", false);
          } catch {
          }
          let ok = false;
          try {
            ok = document.execCommand("insertText", false, text);
          } catch {
            ok = false;
          }
          if (!ok) {
            input.textContent = text;
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          }
          await sleep(300);
          const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
          Object.defineProperty(enter, "keyCode", { value: 13 });
          Object.defineProperty(enter, "which", { value: 13 });
          input.dispatchEvent(enter);
          await sleep(400);
          if ((input.textContent ?? "").trim().length > 0) {
            const composer = input.closest("form") ?? input.parentElement?.parentElement ?? document.body;
            const btn = composer.querySelector('button[aria-label*="end" i]') ?? composer.querySelector('button[type="submit"]') ?? [...composer.querySelectorAll("button")].reverse().find((b) => !b.disabled && !!b.querySelector("svg")) ?? null;
            btn?.click();
          }
        },
        args: [SEL, prompt]
      });
    }
    async function read(slotId, nonce) {
      const tabId = Number(slotId.split("@")[1]);
      const end = `\xA7\xA7END ${nonce}\xA7\xA7`;
      const deadline = Date.now() + 9e4;
      while (Date.now() < deadline) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.body.innerText ?? ""
        });
        const text = res?.result ?? "";
        if (text.split(end).length - 1 >= 2) return text;
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error("bridge read timeout");
    }
    async function peek(slotId) {
      const tabId = Number(slotId.split("@")[1]);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => document.querySelector(sel.lastAssistant)?.innerText ?? "",
        args: [SEL]
      });
      return res?.result ?? "";
    }
    async function retire(chatType) {
      const old = tabForSlot.get(chatType);
      if (old != null) await chrome.tabs.remove(old).catch(() => void 0);
      tabForSlot.delete(chatType);
      return ensureSlot(chatType);
    }
    return { ensureSlot, send, read, peek, retire };
  }

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

  // src/shared/scrapers/hubspot-map.ts
  var DEFAULT_PROPERTY_MAP = {
    name: "Company name",
    domain: "Company Domain Name",
    industry: "Industry (Source of Truth)",
    industryAlt: "Industry (Breeze Intelligence)",
    annualRevenue: "Annual Revenue (Source of Truth)",
    description: "Company Description (Source of Truth)",
    employees: "Number of Employees",
    predictedMrr: "Prospect Value Score Predicted MRR 6 months",
    fitScore: "HubSpot Fit Score",
    reasonsDetails: "Compelling Reasons to Reach Out - Details",
    reasonsSummary: "Compelling Reasons to Reach Out - Summary",
    territory: "Company Info Territory",
    owner: "Company owner"
  };
  var joinReasons = (details, summary) => {
    const parts = [summary, details].map((s) => (s ?? "").trim()).filter(Boolean);
    return parts.length ? parts.join(" \u2014 ") : null;
  };
  function mapAccount(company, objectId = "", signals = {}, pm = DEFAULT_PROPERTY_MAP) {
    const input = {
      name: company[pm.name]?.trim() || null,
      domain: company[pm.domain]?.trim() || null,
      description: company[pm.description]?.trim() || null,
      fitScore: num(company[pm.fitScore]),
      predictedMrr: num(company[pm.predictedMrr]),
      employeeCount: num(company[pm.employees]),
      annualRevenue: parseRevenue(company[pm.annualRevenue]),
      industry: company[pm.industry]?.trim() || null,
      industryAlt: company[pm.industryAlt]?.trim() || null,
      reasonsText: joinReasons(company[pm.reasonsDetails], company[pm.reasonsSummary]),
      newHire: signals.newHire ?? null,
      territory: company[pm.territory]?.trim() || null,
      owner: company[pm.owner]?.trim() || null
    };
    return { objectId, input, sourcing: { company, contacts: [] } };
  }

  // src/background/hubspot-diag.ts
  function expectedPairs(pm) {
    return [
      { field: "name", expected: pm.name },
      { field: "domain", expected: pm.domain },
      { field: "industry", expected: pm.industry },
      { field: "industryAlt", expected: pm.industryAlt },
      { field: "annualRevenue", expected: pm.annualRevenue },
      { field: "description", expected: pm.description },
      { field: "employees", expected: pm.employees },
      { field: "predictedMrr", expected: pm.predictedMrr },
      { field: "fitScore", expected: pm.fitScore },
      { field: "reasonsDetails", expected: pm.reasonsDetails },
      { field: "reasonsSummary", expected: pm.reasonsSummary },
      { field: "territory", expected: pm.territory },
      { field: "owner", expected: pm.owner }
    ];
  }
  async function findHubspotTab() {
    const tabs = await chrome.tabs.query({ url: ["*://*.hubspot.com/*"] });
    if (tabs.length === 0) return null;
    return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  }
  async function scrapeHubspotDiag() {
    const tab = await findHubspotTab();
    if (!tab?.id) {
      return {
        tabUrl: "",
        onHubspot: false,
        looksLikeIndex: false,
        tableStrategy: null,
        headerStrategy: null,
        rowSampled: 0,
        headerCount: 0,
        rawCellCounts: [],
        columns: [],
        mapMatches: [],
        samples: [],
        note: "No HubSpot tab found. Open your open-pool LIST VIEW (the index table of companies) in a tab, then click again."
      };
    }
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (expected) => {
        const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
        const classify = (raw) => {
          const s = raw.trim();
          if (!s || s === "--" || s === "\u2014" || s === "-") return "empty";
          if (/@[\w.-]+\.\w+/.test(s)) return "email";
          if (/^[-+]?[\d.,\s%$€£]+$/.test(s)) return "num";
          if (/\d{4}-\d{2}-\d{2}/.test(s) || /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/.test(s) || /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(s)) return "date";
          return "text";
        };
        const tableSels = ['[data-test-id="table"]', '[role="grid"]', '[role="table"]', "table"];
        let table = null;
        let tableStrategy = null;
        for (const s of tableSels) {
          const el = document.querySelector(s);
          if (el) {
            table = el;
            tableStrategy = s;
            break;
          }
        }
        const root = table ?? document;
        const headerSels = ['[data-test-id*="column-header"]', '[role="columnheader"]', "thead th", "th"];
        let headerEls = [];
        let headerStrategy = null;
        for (const s of headerSels) {
          const els = [...root.querySelectorAll(s)];
          if (els.length > 0) {
            headerEls = els;
            headerStrategy = s;
            break;
          }
        }
        const headers = headerEls.map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim());
        const rowSels = ["tbody tr", '[role="row"]', "tr"];
        let rows = [];
        for (const s of rowSels) {
          const els = [...root.querySelectorAll(s)].filter((r2) => r2.querySelector('td,[role="cell"],[role="gridcell"]'));
          if (els.length > 0) {
            rows = els;
            break;
          }
        }
        const sample = rows.slice(0, 12);
        const headerCount = headers.length;
        const alignedCells = (r2) => {
          let cells = [...r2.querySelectorAll('td,[role="cell"],[role="gridcell"]')];
          while (cells.length > 0) {
            const c0 = cells[0];
            if (c0.querySelector('input[type="checkbox"]') || /^select row$/i.test((c0.textContent ?? "").trim())) {
              cells = cells.slice(1);
              continue;
            }
            break;
          }
          if (cells.length > headerCount) cells = cells.slice(0, headerCount);
          return cells;
        };
        const rawCellCounts = sample.slice(0, 3).map((r2) => r2.querySelectorAll('td,[role="cell"],[role="gridcell"]').length);
        const aligned = sample.map(alignedCells);
        const columns = [];
        for (let c = 0; c < headerCount; c++) {
          const header = headers[c] ?? "";
          if (!header) continue;
          const counts = {};
          let nonEmpty2 = 0;
          for (const cells of aligned) {
            const cls = classify(cells[c]?.textContent ?? "");
            counts[cls] = (counts[cls] ?? 0) + 1;
            if (cls !== "empty") nonEmpty2++;
          }
          const dominant = Object.entries(counts).filter(([k]) => k !== "empty").sort((a, b) => b[1] - a[1])[0]?.[0] ?? "empty";
          columns.push({ header, fill: aligned.length ? +(nonEmpty2 / aligned.length).toFixed(2) : 0, type: dominant });
        }
        const REDACT = /* @__PURE__ */ new Set([
          "Company Description (Source of Truth)",
          "Compelling Reasons to Reach Out - Details",
          "Compelling Reasons to Reach Out - Summary",
          "Company Domain Name"
        ]);
        const maskVal = (header, raw) => {
          const v = (raw ?? "").replace(/\s+/g, " ").trim();
          if (REDACT.has(header)) return v ? `[redacted ${v.length}ch]` : "";
          if (/@[\w.-]+\.\w+/.test(v)) return "[email]";
          if (/\+?\d[\d ()-]{7,}\d/.test(v)) return "[phone]";
          return v.length > 48 ? `${v.slice(0, 48)}\u2026` : v;
        };
        const samples = aligned.slice(0, 3).map((cells) => {
          const o = {};
          headers.forEach((h, i) => {
            if (h) o[h] = maskVal(h, cells[i]?.textContent ?? "");
          });
          return o;
        });
        const normHeaders = headers.map(norm).filter(Boolean);
        const mapMatches = expected.map(({ field, expected: exp }) => {
          const n = norm(exp);
          const found = normHeaders.some((h) => h === n || h.includes(n) || n.includes(h));
          return { field, expected: exp, found };
        });
        const looksLikeIndex = /\/(objects|contacts|companies|prospecting|index)\b/i.test(location.pathname) || rows.length >= 2;
        return {
          tabUrl: location.href.split("?")[0],
          onHubspot: true,
          looksLikeIndex,
          tableStrategy,
          headerStrategy,
          rowSampled: sample.length,
          headerCount,
          rawCellCounts,
          columns,
          mapMatches,
          samples,
          note: ""
        };
      },
      args: [expectedPairs(DEFAULT_PROPERTY_MAP)]
    });
    const r = res?.result;
    if (!r) return { tabUrl: tab.url ?? "", onHubspot: true, looksLikeIndex: false, tableStrategy: null, headerStrategy: null, rowSampled: 0, headerCount: 0, rawCellCounts: [], columns: [], mapMatches: [], samples: [], note: "No result from the HubSpot page (script blocked or page still loading). Make sure the list view is fully loaded, then retry." };
    const matched = r.mapMatches.filter((m) => m.found).length;
    r.note = !r.tableStrategy ? "Found a HubSpot tab but no table \u2014 open the open-pool LIST VIEW (the company index table), let it load, then retry." : r.columns.length === 0 ? `Table found (${r.tableStrategy}) but no labeled columns resolved \u2014 share this report so I can adjust the header selector.` : `OK \u2014 ${r.columns.length} labeled columns, ${matched}/${r.mapMatches.length} expected properties matched. Share this report + tell me any column names I should map.`;
    return r;
  }

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

  // src/prompts/types.ts
  function tagAll(inner, name) {
    const out = [];
    for (const m of inner.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))) out.push(m[1].trim());
    return out;
  }
  function tagLast(inner, name) {
    const all = tagAll(inner, name);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  // src/prompts/research-company.ts
  var NOTE_MAX = 160;
  var NAME_TRUNC = 80;
  var INDUSTRY_LABEL = /^[a-z0-9 ,&/-]{1,40}$/i;
  var truthy = (s) => s != null && /^true$/i.test(s.trim());
  function egressClears(s) {
    try {
      assertEgressSafe(s);
      return true;
    } catch (e) {
      if (e instanceof EgressViolationError) return false;
      throw e;
    }
  }
  function parseFit(raw) {
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 100) throw new PlausibilityError(`fit ${n} grossly out of range`);
    const r = Math.round(n);
    if (r < 1 || r > 10) {
      if (r === 0) return 1;
      if (r <= 12) return 10;
      throw new PlausibilityError(`fit ${r} out of 1-10`);
    }
    return r;
  }
  function parseEmployees(raw) {
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw.replace(/[, ]/g, "").trim());
    if (!Number.isFinite(n)) return null;
    if (n < 0) throw new PlausibilityError(`employees ${n} negative`);
    if (n > 5e6) throw new PlausibilityError(`employees ${n} implausibly large`);
    return Math.round(n);
  }
  var PLACEHOLDER = /^[.…\s]*$/;
  var isPlaceholder = (s) => s == null || PLACEHOLDER.test(s);
  function parseResearch(inner) {
    if (!/<response[\s>]/.test(inner) && !/<industry>|<sourced>|<fit>/.test(inner)) {
      throw new SchemaError("missing research envelope");
    }
    const industryRaw = tagLast(inner, "industry");
    const industry = industryRaw && !isPlaceholder(industryRaw) ? industryRaw.slice(0, NAME_TRUNC) : null;
    const employees = parseEmployees(tagLast(inner, "employees"));
    const fit = parseFit(tagLast(inner, "fit"));
    const noteRaw = tagLast(inner, "note") ?? "";
    const note = noteRaw.length > NOTE_MAX ? noteRaw.slice(0, NOTE_MAX) : noteRaw;
    return {
      industry,
      employees,
      fit,
      funding: truthy(tagLast(inner, "funding")),
      hiring: truthy(tagLast(inner, "hiring")),
      expansion: truthy(tagLast(inner, "expansion")),
      note,
      sourced: truthy(tagLast(inner, "sourced"))
    };
  }
  function makeResearchCall(payload) {
    const { name, domain, hints } = payload;
    const hintLines = [];
    if (hints?.employees != null && Number.isFinite(hints.employees)) {
      hintLines.push(`Known employee count (verify, do not blindly trust): ${Math.round(hints.employees)}`);
    }
    if (hints?.industry != null && hints.industry.trim() !== "") {
      const label = hints.industry.trim();
      if (INDUSTRY_LABEL.test(label) && egressClears(label)) {
        hintLines.push(`Suspected industry label (verify): ${label}`);
      }
    }
    return {
      chatType: "analysis",
      retryClass: "read",
      promptName: "research-company",
      egressMode: "research",
      egressPayload: { name, domain },
      // NOTHING else leaves the box — gated by assertResearchEgressSafe
      render: (nonce) => [
        "You are a B2B company researcher. Use WEB SEARCH to research the company below, then reply.",
        `Company name: ${name}`,
        `Company domain: ${domain}`,
        ...hintLines,
        "",
        "Assess fit for a mid-market CRM / marketing / sales platform (HubSpot-style ideal customer).",
        "Rules:",
        "- USE WEB SEARCH. Do not guess from the name alone.",
        "- If you cannot find reliable information, set <sourced>false</sourced> and leave unknown",
        "  fields BLANK (empty tag) rather than guessing. An honest blank beats a fabricated number.",
        "- <fit> is an integer 1-10 (10 = ideal mid-market CRM/marketing/sales customer).",
        "- <employees> is your best INTEGER headcount estimate.",
        "- <industry> is a short industry label.",
        "- <funding>, <hiring>, <expansion> are true/false (recent funding round / actively hiring /",
        '  geographic or product expansion) \u2014 useful "why now" signals.',
        `- <note> is a SHORT why-now note, \u2264${NOTE_MAX} characters, no names of individuals.`,
        "",
        "Reply with EXACTLY this envelope and nothing else:",
        `\xA7\xA7BEGIN ${nonce}\xA7\xA7`,
        "<response><industry>\u2026</industry><employees>\u2026</employees><fit>\u2026</fit><funding>true|false</funding><hiring>true|false</hiring><expansion>true|false</expansion><note>\u2026</note><sourced>true|false</sourced></response>",
        `\xA7\xA7END ${nonce}\xA7\xA7`
      ].join("\n"),
      parse: parseResearch
    };
  }

  // src/shared/enrich.ts
  function needsResearch(input) {
    const industryMissing = (input.industry == null || input.industry.trim() === "") && (input.industryAlt == null || input.industryAlt.trim() === "");
    return input.fitScore == null || industryMissing || input.employeeCount == null;
  }
  var NOTE_MAX2 = 160;
  function whyNowText(r) {
    const flags = [];
    if (r.funding) flags.push("recent funding");
    if (r.hiring) flags.push("actively hiring");
    if (r.expansion) flags.push("expanding");
    const note = (r.note ?? "").trim();
    const parts = [flags.join(", "), note].filter((s) => s.length > 0);
    if (parts.length === 0) return null;
    const joined = parts.join(" \u2014 ");
    return joined.length > NOTE_MAX2 ? joined.slice(0, NOTE_MAX2) : joined;
  }
  function mergeResearch(input, r) {
    const out = { ...input };
    const researched = [];
    if (out.fitScore == null && r.fit != null && r.sourced) {
      out.fitScore = r.fit;
      researched.push("fitScore");
    }
    const industryMissing = (out.industry == null || out.industry.trim() === "") && (out.industryAlt == null || out.industryAlt.trim() === "");
    if (industryMissing && r.industry != null && r.industry.trim() !== "") {
      out.industry = r.industry.trim();
      researched.push("industry");
    }
    if (out.employeeCount == null && r.employees != null && r.employees >= 0) {
      out.employeeCount = r.employees;
      researched.push("employeeCount");
    }
    if (r.sourced && r.hiring && out.newHire !== true) {
      out.newHire = true;
      researched.push("newHire");
    }
    const why = whyNowText(r);
    if (r.sourced && (out.reasonsText == null || out.reasonsText.trim() === "") && why) {
      out.reasonsText = why;
      researched.push("reasonsText");
    }
    if (why && (out.reasonsText == null || out.reasonsText.trim() === "")) {
      out.researchNote = why;
    }
    out.researchedFields = researched.length > 0 ? [...researched] : void 0;
    return { input: out, researched };
  }
  var DAY_MS = 24 * 60 * 60 * 1e3;
  function isFresh(entry, now, maxAgeDays = 45) {
    if (!entry || typeof entry.researchedAt !== "number" || !Number.isFinite(entry.researchedAt)) return false;
    const age = now - entry.researchedAt;
    return age >= 0 && age < maxAgeDays * DAY_MS;
  }

  // src/background/hubspot-scrape.ts
  async function findHubspotTab2() {
    const tabs = await chrome.tabs.query({ url: ["*://*.hubspot.com/*"] });
    if (tabs.length === 0) return null;
    return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  }
  async function scrapeRows(tabId) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const tableSels = ['[data-test-id="table"]', '[role="grid"]', '[role="table"]', "table"];
        let table = document;
        for (const s of tableSels) {
          const el = document.querySelector(s);
          if (el) {
            table = el;
            break;
          }
        }
        const headerSels = ['[data-test-id*="column-header"]', '[role="columnheader"]', "thead th", "th"];
        let headerEls = [];
        for (const s of headerSels) {
          const els = [...table.querySelectorAll(s)];
          if (els.length) {
            headerEls = els;
            break;
          }
        }
        const headers = headerEls.map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim());
        const headerCount = headers.length;
        const CELL = 'td, [role="cell"], [role="gridcell"]';
        const currentRows = () => {
          for (const s of ["tbody tr", '[role="row"]', "tr"]) {
            const els = [...table.querySelectorAll(s)].filter((r) => r.querySelector(CELL));
            if (els.length) return els;
          }
          return [];
        };
        const idFrom = (r) => {
          for (const a of r.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href") ?? "";
            const m = href.match(/record\/0-2\/(\d+)/) ?? href.match(/company\/(\d+)/) ?? href.match(/0-2\/(\d+)/);
            if (m) return m[1];
          }
          return "";
        };
        const alignedCells = (r) => {
          let cells = [...r.querySelectorAll(CELL)];
          while (cells.length > 0) {
            const c0 = cells[0];
            if (c0.querySelector('input[type="checkbox"]') || /^select row$/i.test((c0.textContent ?? "").trim())) {
              cells = cells.slice(1);
              continue;
            }
            break;
          }
          if (cells.length > headerCount) cells = cells.slice(0, headerCount);
          return cells;
        };
        const clean = (s) => {
          const v = (s ?? "").replace(/\s+/g, " ").trim();
          return v === "--" || v === "\u2014" || v === "-" ? "" : v;
        };
        const buildRow = (r) => {
          const cells = alignedCells(r);
          const row = {};
          headers.forEach((h, i) => {
            if (h) row[h] = clean(cells[i]?.textContent ?? "");
          });
          return row;
        };
        const findScroller = (start) => {
          let n = start;
          while (n && n !== document.body && n !== document.documentElement) {
            const st = getComputedStyle(n);
            if ((st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 40) return n;
            n = n.parentElement;
          }
          return document.scrollingElement ?? document.documentElement;
        };
        const scroller = findScroller(table instanceof Element ? table : document.body);
        const byKey = /* @__PURE__ */ new Map();
        const harvest = () => {
          for (const r of currentRows()) {
            const objectId = idFrom(r);
            const row = buildRow(r);
            const key = objectId || JSON.stringify(row);
            if (!byKey.has(key)) byKey.set(key, { objectId, row });
          }
        };
        harvest();
        let stable = 0;
        for (let i = 0; i < 80 && stable < 3; i++) {
          const before = byKey.size;
          const prevTop = scroller.scrollTop;
          scroller.scrollBy(0, Math.max(240, scroller.clientHeight * 0.85));
          await sleep(420);
          harvest();
          const atBottom = scroller.scrollTop <= prevTop + 2;
          if (byKey.size === before && atBottom) stable += 1;
          else stable = 0;
        }
        return [...byKey.values()];
      }
    });
    return res?.result ?? [];
  }
  var domainKey = (d) => (d ?? "").trim().toLowerCase();
  async function previewSourcing(storage2, topN = 15) {
    const tab = await findHubspotTab2();
    if (!tab?.id) {
      return {
        onHubspot: false,
        scanned: 0,
        tierCounts: {},
        thinUnresearched: 0,
        enrichedFromCache: 0,
        top: [],
        note: "No HubSpot tab found. Open your open-pool list view in a tab, then click again."
      };
    }
    const rows = await scrapeRows(tab.id);
    const dossier = await storage2.getOr("dossier", {});
    const now = Date.now();
    const tierCounts = { HOT: 0, WARM: 0, NURTURE: 0, SKIP: 0 };
    let thinUnresearched = 0;
    let enrichedFromCache = 0;
    const scored = rows.map(({ objectId, row }) => {
      let { input } = mapAccount(row, objectId);
      let researched;
      const thin = needsResearch(input);
      if (thin) {
        const entry = dossier[domainKey(input.domain)];
        if (isFresh(entry, now)) {
          const merged = mergeResearch(input, entry.result);
          input = merged.input;
          researched = merged.researched.length ? merged.researched : void 0;
          enrichedFromCache += 1;
        } else {
          thinUnresearched += 1;
        }
      }
      const r = scoreAccount(input);
      tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
      const signals = [...r.signals];
      if (input.researchNote) signals.push(`why-now: ${input.researchNote}`);
      return {
        objectId,
        name: input.name ?? "(no name)",
        tier: r.tier,
        score: r.score,
        confidence: r.confidence,
        why: signals.join(" \xB7 ") || "no scored signals on this row",
        caps: r.caps,
        researched,
        thin: thin && !researched
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topN).map((s, i) => ({ rank: i + 1, ...s }));
    return {
      onHubspot: true,
      scanned: rows.length,
      tierCounts,
      thinUnresearched,
      enrichedFromCache,
      top,
      note: rows.length === 0 ? "On HubSpot but scraped 0 rows \u2014 open the open-pool LIST VIEW and let it load, then retry." : `${rows.length} rows scored (${enrichedFromCache} enriched from cached research). ${thinUnresearched} thin account(s) still missing fit data \u2014 click "Research thin accounts" to fill them, then re-run this. OBSERVE: nothing claimed or staged. (Scroll the list to load more rows.)`
    };
  }
  async function researchThinAccounts(bridge2, storage2, cap = 8) {
    const tab = await findHubspotTab2();
    if (!tab?.id) {
      return {
        onHubspot: false,
        scanned: 0,
        thin: 0,
        researched: 0,
        reused: 0,
        failed: 0,
        remaining: 0,
        note: "No HubSpot tab found. Open your open-pool list view in a tab, then click again."
      };
    }
    const rows = await scrapeRows(tab.id);
    const dossier = await storage2.getOr("dossier", {});
    const now = Date.now();
    const queue2 = [];
    let thin = 0;
    let reused = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const { objectId, row } of rows) {
      const { input } = mapAccount(row, objectId);
      if (!needsResearch(input)) continue;
      thin += 1;
      const domain = domainKey(input.domain);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      if (isFresh(dossier[domain], now)) {
        reused += 1;
        continue;
      }
      if (!input.name) continue;
      queue2.push({
        name: input.name,
        domain,
        hints: { industry: input.industry ?? input.industryAlt, employees: input.employeeCount },
        score: scoreAccount(input).score
      });
    }
    queue2.sort((a, b) => b.score - a.score);
    const batch = queue2.slice(0, cap);
    let researched = 0;
    let failed = 0;
    for (const t of batch) {
      const res = await bridge2.call(makeResearchCall({ name: t.name, domain: t.domain, hints: t.hints }));
      if (res.ok && res.value) {
        const entry = { domain: t.domain, researchedAt: Date.now(), result: res.value };
        await storage2.update("dossier", (cur) => ({ ...cur ?? {}, [t.domain]: entry }));
        researched += 1;
      } else {
        failed += 1;
      }
    }
    const remaining = queue2.length - batch.length;
    return {
      onHubspot: true,
      scanned: rows.length,
      thin,
      researched,
      reused,
      failed,
      remaining,
      note: `Researched ${researched} thin account(s)${failed ? `, ${failed} failed (bridge timeout / no web result)` : ""}. ${reused} already cached. ${remaining} still queued \u2014 run again to continue. Then click "Preview sourcing" to see the re-ranked list.`
    };
  }

  // src/shared/queue.ts
  function decideOnFailure(retryClass, attemptsMade) {
    if (retryClass === "mutating") return "quarantine";
    return attemptsMade < 2 ? "requeue" : "fail";
  }
  var KEY = "promptQueue";
  var empty = () => ({ jobs: {}, results: {}, byHash: {} });
  function makeQueue(storage2, deps) {
    const nonce = deps.newNonce ?? makeNonce;
    const now = () => Date.now();
    const read = async () => await storage2.get(KEY) ?? empty();
    const get = async (id) => (await read()).jobs[id];
    const result = async (id) => (await read()).results[id];
    const all = async () => Object.values((await read()).jobs);
    async function mutate(fn) {
      await storage2.update(KEY, (cur) => {
        const q = cur ?? empty();
        fn(q);
        return q;
      });
    }
    const setJob = (id, fn) => mutate((q) => {
      const j = q.jobs[id];
      if (j) {
        fn(j);
        j.updatedAt = now();
      }
    });
    async function enqueue(spec) {
      let id = "";
      await mutate((q) => {
        const existingId = q.byHash[spec.contentHash];
        const existing = existingId ? q.jobs[existingId] : void 0;
        if (existing && existing.state !== "FAILED" && existing.state !== "QUARANTINED") {
          id = existingId;
          return;
        }
        id = `job_${nonce()}${nonce()}`;
        q.jobs[id] = {
          id,
          type: spec.type,
          chatType: spec.chatType,
          retryClass: spec.retryClass,
          contentHash: spec.contentHash,
          nonce: spec.nonce ?? nonce(),
          state: "QUEUED",
          attempts: 0,
          payloadRef: spec.payloadRef,
          dependsOn: spec.dependsOn,
          createdAt: now(),
          updatedAt: now()
        };
        q.byHash[spec.contentHash] = id;
      });
      return id;
    }
    const depState = (q, j) => !j.dependsOn ? "none" : q.jobs[j.dependsOn]?.state ?? "FAILED";
    const finishOk = (id, value) => mutate((q) => {
      q.results[id] = value;
      const j = q.jobs[id];
      if (j) {
        j.state = "DONE";
        j.resultRef = id;
        j.updatedAt = now();
      }
    });
    async function onFailure(id) {
      const j = await get(id);
      if (!j) return;
      const decision = decideOnFailure(j.retryClass, j.attempts);
      if (decision === "quarantine") await setJob(id, (x) => {
        x.state = "QUARANTINED";
      });
      else if (decision === "fail") await setJob(id, (x) => {
        x.state = "FAILED";
      });
      else await setJob(id, (x) => {
        x.state = "QUEUED";
        x.nonce = nonce();
      });
    }
    async function tick() {
      let claimedId = null;
      let failedId = null;
      await mutate((q) => {
        const jobs = Object.values(q.jobs);
        const blocked = jobs.find(
          (j) => j.state === "QUEUED" && j.dependsOn && (depState(q, j) === "FAILED" || depState(q, j) === "QUARANTINED")
        );
        if (blocked) {
          blocked.state = "FAILED";
          blocked.updatedAt = now();
          failedId = blocked.id;
          return;
        }
        const busy = new Set(
          jobs.filter((j) => j.state === "DISPATCHED" || j.state === "AWAITING").map((j) => j.chatType)
        );
        const cand = jobs.find(
          (j) => j.state === "QUEUED" && (!j.dependsOn || depState(q, j) === "DONE") && !busy.has(j.chatType)
        );
        if (cand) {
          cand.state = "DISPATCHED";
          cand.attempts += 1;
          cand.nonce = nonce();
          cand.updatedAt = now();
          claimedId = cand.id;
        }
      });
      if (failedId !== null) return true;
      if (claimedId === null) return false;
      const id = claimedId;
      await setJob(id, (j) => {
        j.state = "AWAITING";
      });
      const job = await get(id);
      if (!job) return true;
      const outcome = await deps.dispatch(job);
      if (outcome.ok) await finishOk(id, outcome.value);
      else await onFailure(id);
      return true;
    }
    async function drain(maxSteps = 1e3) {
      for (let i = 0; i < maxSteps; i++) if (!await tick()) return;
    }
    async function reconcile() {
      const inflight = (await all()).filter((j) => j.state === "DISPATCHED" || j.state === "AWAITING");
      for (const job of inflight) {
        const probe = await deps.probe(job);
        if (probe && probe.ok) await finishOk(job.id, probe.value);
        else if (probe && !probe.ok) await onFailure(job.id);
        else if (job.retryClass === "mutating") await setJob(job.id, (x) => {
          x.state = "QUARANTINED";
        });
        else await setJob(job.id, (x) => {
          x.state = "QUEUED";
          x.nonce = nonce();
        });
      }
    }
    return { enqueue, tick, drain, reconcile, get, result, all };
  }

  // src/shared/ledger.ts
  var KEY2 = "ledger";
  var TIER_NUM = { SKIP: 0, NURTURE: 1, WARM: 2, HOT: 3 };
  function makeLedger(storage2, deps = {}) {
    const read = async () => await storage2.get(KEY2) ?? [];
    async function append(e) {
      let seq = 0;
      await storage2.update(KEY2, (cur) => {
        const arr = cur ?? [];
        seq = arr.length === 0 ? 0 : arr[arr.length - 1].seq + 1;
        arr.push({ ...e, seq });
        return arr;
      });
      return seq;
    }
    async function restamp(objectId, patch) {
      await storage2.update(KEY2, (cur) => {
        const arr = cur ?? [];
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].objectId === objectId) {
            if (patch.repliedAt !== void 0) arr[i].repliedAt = patch.repliedAt;
            if (patch.stageAdvancedAt !== void 0) arr[i].stageAdvancedAt = patch.stageAdvancedAt;
            if (patch.closedWonAt !== void 0) arr[i].closedWonAt = patch.closedWonAt;
            if (patch.closedLostAt !== void 0) arr[i].closedLostAt = patch.closedLostAt;
            break;
          }
        }
        return arr;
      });
    }
    async function exportDeidentified() {
      const on = deps.exportEnabled ? await deps.exportEnabled() : false;
      if (!on) return [];
      const arr = await read();
      return arr.map((e) => {
        const outcome = e.closedWonAt != null ? 4 : e.closedLostAt != null ? 1 : e.stageAdvancedAt != null ? 3 : e.repliedAt != null ? 2 : 0;
        const repliedDelta = e.repliedAt != null ? e.repliedAt - e.ts : -1;
        const closedDelta = e.closedWonAt != null ? e.closedWonAt - e.ts : e.closedLostAt != null ? e.closedLostAt - e.ts : -1;
        const inputs = e.inputsSnapshot.map((n) => typeof n === "number" && Number.isFinite(n) ? n : 0);
        return [...inputs, TIER_NUM[e.tier] ?? 0, outcome, e.ts, repliedDelta, closedDelta];
      });
    }
    return { append, restamp, exportDeidentified, all: read };
  }

  // src/shared/audit-scrub.ts
  var ZERO_WIDTH2 = /[​-‍﻿]/g;
  var EMAIL2 = /[^\s@]+@[^\s@]+/;
  var PHONE2 = /(?:\d[\s().-]*){7,}/;
  var ID_SHAPE = /^[A-Za-z0-9:_-]{1,64}$/;
  var MAX_LEN2 = 120;
  var MAX_WORDS2 = 12;
  var MAX_SELECTOR = 200;
  var AuditScrubError = class extends Error {
    constructor(reason) {
      super(`Audit row rejected: ${reason}`);
      this.name = "AuditScrubError";
    }
  };
  var wordCount2 = (s) => s.trim().split(/\s+/).filter(Boolean).length;
  function checkPii(s, piiTokens) {
    const low = s.toLowerCase();
    for (const t of piiTokens) {
      if (t && low.includes(t.toLowerCase())) throw new AuditScrubError(`pii token "${t}"`);
    }
  }
  function scrubAudit(row, piiTokens = []) {
    if (row.objectId !== void 0 && !ID_SHAPE.test(row.objectId)) {
      throw new AuditScrubError("objectId is not a stable id");
    }
    const freeTexts = [];
    if (row.reason) freeTexts.push(row.reason);
    if (row.refs) for (const [k, v] of Object.entries(row.refs)) {
      freeTexts.push(k);
      freeTexts.push(v);
    }
    for (const raw of freeTexts) {
      const s = raw.replace(ZERO_WIDTH2, "");
      if (EMAIL2.test(s)) throw new AuditScrubError("email address");
      if (PHONE2.test(s)) throw new AuditScrubError("phone number");
      if (s.length > MAX_LEN2) throw new AuditScrubError("free-text body (length)");
      if (wordCount2(s) > MAX_WORDS2) throw new AuditScrubError("free-text body (words)");
      checkPii(s, piiTokens);
    }
    if (row.selectorPath) {
      const s = row.selectorPath.replace(ZERO_WIDTH2, "");
      if (EMAIL2.test(s)) throw new AuditScrubError("email in selector");
      if (s.length > MAX_SELECTOR) throw new AuditScrubError("oversized selector");
      checkPii(s, piiTokens);
    }
  }

  // src/shared/audit.ts
  var KEY3 = "auditLog";
  var DAY = 864e5;
  var CUSTOMER_KINDS = /* @__PURE__ */ new Set(["stage", "private_commit"]);
  function makeAuditLog(storage2, opts = {}) {
    const read = async () => await storage2.get(KEY3) ?? [];
    async function append(row) {
      scrubAudit(row, opts.piiTokens);
      await storage2.update(KEY3, (cur) => {
        const arr = cur ?? [];
        arr.push({ ...row, ts: Date.now() });
        return arr;
      });
    }
    async function query(sinceTs, kind) {
      return (await read()).filter((r) => r.ts >= sinceTs && (kind === void 0 || r.kind === kind));
    }
    async function prune(now = Date.now()) {
      await storage2.update(KEY3, (cur) => {
        const arr = cur ?? [];
        let removed = 0;
        const kept = arr.filter((r) => {
          const limit = CUSTOMER_KINDS.has(r.kind) ? 7 * DAY : 30 * DAY;
          const keep = now - r.ts <= limit;
          if (!keep) removed += 1;
          return keep;
        });
        if (removed > 0) kept.push({ kind: "prune", reason: `pruned ${removed} rows`, ts: now });
        return kept;
      });
    }
    return { append, query, prune };
  }

  // src/shared/cadence.ts
  function makeCadence(cfg = {}) {
    const windowMs = cfg.windowMs ?? 36e5;
    const ceilings = cfg.ceilings ?? {};
    const loaded = new Set(cfg.commitRows ?? []);
    const now = cfg.now ?? (() => Date.now());
    const events = /* @__PURE__ */ new Map();
    const fresh = (type) => {
      const t = now();
      const arr = (events.get(type) ?? []).filter((ts) => t - ts < windowMs);
      events.set(type, arr);
      return arr;
    };
    return {
      allow(type) {
        const ceiling = ceilings[type];
        if (ceiling === void 0) return true;
        return fresh(type).length < ceiling;
      },
      record(type) {
        const arr = fresh(type);
        arr.push(now());
        events.set(type, arr);
      },
      commitRowLoaded(type) {
        return loaded.has(type);
      }
    };
  }

  // src/shared/autonomy.ts
  var AUTONOMY_CLASS = {
    CREATE_GMAIL_DRAFT: "AUTO_SAFE",
    CREATE_HUBSPOT_TASK: "AUTO_SAFE",
    ADD_INTERNAL_NOTE: "AUTO_SAFE",
    WRITE_LEDGER: "AUTO_SAFE",
    STAGE_RECOMMENDATION: "AUTO_SAFE",
    CLAIM_ACCOUNT: "COMMIT",
    ENROLL_SEQUENCE: "COMMIT",
    SEND_EMAIL: "COMMIT",
    SEND_INMAIL: "COMMIT",
    SEND_CONNECTION_REQUEST: "COMMIT"
  };
  var PRIVATE_ACTIONS = /* @__PURE__ */ new Set([
    "ADD_INTERNAL_NOTE",
    "WRITE_LEDGER",
    "STAGE_RECOMMENDATION"
  ]);
  var DEFAULT_CONFIG = {
    allowAutoSend: false,
    deploymentMode: "DRAFT",
    workingHours: { startHour: 7, endHour: 19, tz: "Europe/Stockholm" },
    exportLedger: false,
    bridgeHeartbeat: false
  };
  var DEFAULT_AUTONOMY_POLICY = {
    CREATE_GMAIL_DRAFT: "stage",
    CREATE_HUBSPOT_TASK: "stage",
    ADD_INTERNAL_NOTE: "stage",
    WRITE_LEDGER: "stage",
    STAGE_RECOMMENDATION: "stage",
    CLAIM_ACCOUNT: "observe",
    ENROLL_SEQUENCE: "observe",
    SEND_EMAIL: "observe",
    SEND_INMAIL: "observe",
    SEND_CONNECTION_REQUEST: "observe"
  };
  var CommitNotImplementedError = class extends Error {
    constructor(actionType) {
      super(`AUTO-SEND not implemented for ${actionType} \u2014 gated by allowAutoSend`);
      this.actionType = actionType;
      this.name = "CommitNotImplementedError";
    }
  };
  async function commitStub(action) {
    throw new CommitNotImplementedError(action.type);
  }
  function executorImplementsCommit(ex) {
    return ex.commitImplemented === true && typeof ex.commit === "function";
  }

  // src/shared/ledger-map.ts
  function toLedgerEntry(action, ctx) {
    return {
      ts: Date.now(),
      objectId: action.objectId,
      objectKind: action.objectKind,
      actionType: action.type,
      tier: ctx.tier,
      scoreSnapshot: ctx.scoreSnapshot,
      inputsSnapshot: ctx.inputsSnapshot,
      activeSetHash: ctx.activeSetHash,
      stagedItemId: ctx.stagedItemId
    };
  }

  // src/shared/gate.ts
  function withinWorkingHours(wh, date) {
    const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: wh.tz }).format(date)) % 24;
    return h >= wh.startHour && h < wh.endHour;
  }
  function makeGate(deps) {
    const inWH = deps.inWorkingHours ?? ((wh) => withinWorkingHours(wh, /* @__PURE__ */ new Date()));
    const highStakes = deps.isHighStakes ?? ((a) => AUTONOMY_CLASS[a.type] === "COMMIT");
    const observeOnly = async (action, ctx, reason) => {
      await deps.ledger.append(toLedgerEntry(action, ctx));
      await deps.audit.append({ kind: "observe", action: action.type, surface: action.surface, objectId: action.objectId, reason });
      return { mode: "observe", reason };
    };
    async function commitPrivate(action, ctx) {
      const ex = deps.executorFor(action.type);
      if (action.type === "WRITE_LEDGER") {
        const r = await ex.commit(action);
        await deps.audit.append({ kind: "private_commit", action: "WRITE_LEDGER", objectId: action.objectId, reason: "private write-ledger" });
        return { mode: "auto", committed: r.ok, reason: "private write-ledger" };
      }
      const out = await ex.commit(action);
      await deps.ledger.append(toLedgerEntry(action, ctx));
      await deps.audit.append({ kind: "private_commit", action: action.type, objectId: action.objectId, reason: `private ${action.type}` });
      return { mode: "auto", committed: out.ok, reason: `private ${action.type}` };
    }
    async function commitAutoSafe(action, ctx) {
      const ex = deps.executorFor(action.type);
      const out = await ex.commit(action);
      await deps.ledger.append(toLedgerEntry(action, ctx));
      await deps.audit.append({ kind: "auto_safe", action: action.type, objectId: action.objectId, reason: `auto-safe ${action.type}` });
      return { mode: "auto", committed: out.ok, reason: `auto-safe ${action.type}` };
    }
    async function stagePath(action, ctx, ex) {
      const item = await ex.stage(action);
      await deps.ledger.append(toLedgerEntry(action, { ...ctx, stagedItemId: item.id }));
      await deps.audit.append({ kind: "stage", action: action.type, surface: action.surface, objectId: action.objectId, reason: `staged ${action.type}` });
      if (highStakes(action)) {
        await deps.queue.enqueue({
          type: "demote-only-critique",
          chatType: "analysis",
          retryClass: "read",
          contentHash: `critique:${item.id}`,
          payloadRef: item.id
        });
      }
      return { mode: "stage", stagedItemId: item.id, reason: `staged ${action.type}` };
    }
    async function enqueueAction(action) {
      const cfg = await deps.storage.getOr("config", DEFAULT_CONFIG);
      const policy = await deps.storage.getOr("autonomyPolicy", DEFAULT_AUTONOMY_POLICY);
      const klass = AUTONOMY_CLASS[action.type];
      const isPrivate = PRIVATE_ACTIONS.has(action.type);
      const ctx = await deps.buildCtx(action);
      await deps.audit.append({ kind: "gate_enter", action: action.type, surface: action.surface, objectId: action.objectId, scoreBreakdown: ctx.inputsSnapshot, refs: ctx.refs });
      if (cfg.deploymentMode === "OBSERVE") return observeOnly(action, ctx, "deploymentMode=OBSERVE");
      if (!klass) return observeOnly(action, ctx, "unknown ActionType");
      if (isPrivate) {
        await deps.humanDelay();
        return commitPrivate(action, ctx);
      }
      if (!inWH(cfg.workingHours)) return observeOnly(action, ctx, "outside working hours");
      const legit = await deps.legitimacy(action.objectId);
      if (legit === "RED") return observeOnly(action, ctx, "legitimacy=RED");
      if (action.surface !== "local") {
        if (!deps.breakerClosed(action.surface)) return observeOnly(action, ctx, `breaker open: ${action.surface}`);
        if (!await deps.smokeOk(action.surface)) return observeOnly(action, ctx, `smoke failed: ${action.surface}`);
      }
      if (!deps.cadence.allow(action.type)) return observeOnly(action, ctx, `cadence ceiling: ${action.type}`);
      const desired = policy[action.type];
      if (klass === "AUTO_SAFE") {
        if (desired === "observe") return observeOnly(action, ctx, "policy=observe");
        await deps.humanDelay();
        deps.cadence.record(action.type);
        return commitAutoSafe(action, ctx);
      }
      const ex = deps.executorFor(action.type);
      const canAuto = cfg.allowAutoSend === true && desired === "auto" && executorImplementsCommit(ex) && // reads commitImplemented; false for an un-built COMMIT
      deps.cadence.commitRowLoaded(action.type) && // the flip-time cadence guarantee
      legit === "GREEN";
      if (!canAuto) {
        await deps.humanDelay();
        return stagePath(action, ctx, ex);
      }
      await deps.humanDelay();
      deps.cadence.record(action.type);
      let res;
      try {
        res = await ex.commit(action);
      } catch {
        return stagePath(action, ctx, ex);
      }
      await deps.ledger.append(toLedgerEntry(action, ctx));
      await deps.audit.append({ kind: "auto_commit", action: action.type, objectId: action.objectId, reason: "auto-commit" });
      return { mode: "auto", committed: res.ok, reason: "auto-commit" };
    }
    return { enqueueAction };
  }

  // src/shared/health.ts
  function makeHealth(deps) {
    async function goldenPathSmokeTest(surface, opts) {
      if (surface === "local") return { ok: true, failedSelectors: [], canaryOk: true };
      const failedSelectors = await deps.resolveSelectors(surface);
      const canaryOk = opts.needsBridge ? await deps.canary() : true;
      const result = { ok: failedSelectors.length === 0 && canaryOk, failedSelectors, canaryOk };
      if (!result.ok && deps.onDemote) await deps.onDemote(surface, result);
      return result;
    }
    async function smokeOk(surface) {
      return (await goldenPathSmokeTest(surface, { needsBridge: true })).ok;
    }
    return { goldenPathSmokeTest, smokeOk };
  }
  function makeCircuitBreaker(cfg = {}) {
    const window = cfg.window ?? 20;
    const floor = cfg.floor ?? 0.5;
    const minSamples = cfg.minSamples ?? 5;
    const samples = [];
    return {
      recordValidity(valid) {
        samples.push(valid);
        if (samples.length > window) samples.shift();
      },
      closed() {
        if (samples.length < minSamples) return true;
        const validRate = samples.filter(Boolean).length / samples.length;
        return validRate >= floor;
      }
    };
  }

  // src/shared/freeze.ts
  function makeFreeze(deps) {
    const threshold = deps.thresholdMs ?? 3e5;
    const now = deps.now ?? (() => Date.now());
    async function freeze2(reason) {
      await deps.storage.update("config", (cur) => ({
        ...cur ?? DEFAULT_CONFIG,
        deploymentMode: "OBSERVE"
        // the gate's step 1 then forces every action to log-only
      }));
      if (deps.onFreeze) await deps.onFreeze(reason);
    }
    async function isFrozen() {
      return (await deps.storage.getOr("config", DEFAULT_CONFIG)).deploymentMode === "OBSERVE";
    }
    async function heartbeat() {
      await deps.storage.update("healthState", (cur) => ({ ...cur ?? {}, lastBeat: now() }));
    }
    async function checkDeadMan() {
      const last = (await deps.storage.get("healthState"))?.lastBeat ?? 0;
      if (now() - last > threshold) await freeze2("dead-man: stale heartbeat");
    }
    return { freeze: freeze2, isFrozen, heartbeat, checkDeadMan };
  }

  // src/shared/executors.ts
  var previewOf = (a) => `${a.type} \u2192 ${a.objectKind} ${a.objectId}`;
  async function pushStaged(storage2, surface, action) {
    const item = { id: `stg_${makeNonce()}`, surface, preview: previewOf(action), createdAt: Date.now() };
    await storage2.update("stagedItems", (cur) => [...cur ?? [], item]);
    return item;
  }
  function makeStagingExecutor(storage2, surface) {
    return {
      commitImplemented: false,
      stage: (action) => pushStaged(storage2, surface, action),
      commit: commitStub
    };
  }
  function makeAutoSafeExecutor(storage2, surface) {
    return {
      commitImplemented: true,
      stage: (action) => pushStaged(storage2, surface, action),
      async commit(action) {
        await pushStaged(storage2, surface, action);
        return { ok: true };
      }
    };
  }
  function makeWriteLedgerExecutor(ledger2) {
    return {
      commitImplemented: true,
      async stage() {
        return { id: `wl_${makeNonce()}`, surface: "local", preview: "write-ledger", createdAt: Date.now() };
      },
      async commit(action) {
        await ledger2.append(action.payload);
        return { ok: true };
      }
    };
  }
  function buildExecutorRegistry(opts) {
    const { storage: storage2, ledger: ledger2, domCommits = {} } = opts;
    const autoSafe = (s) => makeAutoSafeExecutor(storage2, s);
    const staging = (s) => makeStagingExecutor(storage2, s);
    const defaults = {
      CREATE_GMAIL_DRAFT: autoSafe("gmail"),
      CREATE_HUBSPOT_TASK: autoSafe("hubspot"),
      ADD_INTERNAL_NOTE: autoSafe("local"),
      STAGE_RECOMMENDATION: autoSafe("local"),
      WRITE_LEDGER: makeWriteLedgerExecutor(ledger2),
      CLAIM_ACCOUNT: staging("hubspot"),
      ENROLL_SEQUENCE: staging("hubspot"),
      SEND_EMAIL: staging("gmail"),
      SEND_INMAIL: staging("salesnav"),
      SEND_CONNECTION_REQUEST: staging("salesnav")
    };
    return { for: (type) => domCommits[type] ?? defaults[type] };
  }

  // src/background/worker.ts
  var storage = makeStorage(chromeBackend());
  var ledger = makeLedger(storage, { exportEnabled: async () => (await storage.getOr("config", DEFAULT_CONFIG)).exportLedger });
  var audit = makeAuditLog(storage);
  var bridge = makeBridge(makeBridgeDomTransport());
  var SURFACES = ["hubspot", "gmail", "slack", "gong", "successapp", "salesnav", "claudeai"];
  var breakers = new Map(SURFACES.map((s) => [s, makeCircuitBreaker()]));
  var health = makeHealth({
    resolveSelectors: async () => [],
    // INTEGRATION POINT: read-only resolve the real per-surface selectors
    canary: () => bridge.canary(),
    onDemote: async (surface, result) => {
      await audit.append({ kind: "smoke_fail", surface, reason: `failed selectors: ${result.failedSelectors.length}` });
    }
  });
  var cadence = makeCadence();
  var registry = buildExecutorRegistry({ storage, ledger });
  var queueDeps = {
    dispatch: async (job) => {
      const r = await bridge.call({
        chatType: job.chatType,
        retryClass: job.retryClass,
        promptName: job.type,
        render: (n) => `\xA7\xA7BEGIN ${n}\xA7\xA7 ${job.payloadRef} \xA7\xA7END ${n}\xA7\xA7`,
        // INTEGRATION POINT: real prompt render per job.type
        parse: (x) => x,
        egressPayload: { ref: job.payloadRef }
        // INTEGRATION POINT: the real numeric payload (IDs+scores) loaded from payloadRef; the Bridge asserts it egress-safe before sending
      });
      breakers.get("claudeai")?.recordValidity(r.ok);
      return r.ok ? { ok: true, value: r.value } : { ok: false, failure: r.failure };
    },
    probe: async (job) => {
      const block = await bridge.peek(job.chatType, job.nonce);
      return block ? { ok: true, value: block.inner } : null;
    }
  };
  var queue = makeQueue(storage, queueDeps);
  var gate = makeGate({
    storage,
    ledger,
    audit,
    queue,
    cadence,
    legitimacy: async () => "GREEN",
    // INTEGRATION POINT: object/surface legitimacy
    breakerClosed: (s) => breakers.get(s)?.closed() ?? true,
    smokeOk: (s) => health.smokeOk(s),
    executorFor: (t) => registry.for(t),
    // INTEGRATION POINT: scrape the object + run scoreAccount() to populate the decision ctx.
    buildCtx: async () => ({ tier: "SKIP", scoreSnapshot: 0, inputsSnapshot: new Array(10).fill(0), activeSetHash: "frame" }),
    humanDelay
  });
  var freeze = makeFreeze({
    storage,
    onFreeze: async (reason) => {
      await audit.append({ kind: "freeze", reason });
    }
  });
  async function startup() {
    await freeze.heartbeat();
    await queue.reconcile();
    chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
    chrome.alarms.create("deadman", { periodInMinutes: 5 });
    await audit.append({ kind: "startup", reason: "worker started; reconcile complete" });
  }
  chrome.runtime.onInstalled.addListener(() => void startup());
  chrome.runtime.onStartup.addListener(() => void startup());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "deadman") {
      void freeze.checkDeadMan();
    } else if (alarm.name === "heartbeat") {
      void (async () => {
        const cfg = await storage.getOr("config", DEFAULT_CONFIG);
        if (cfg.bridgeHeartbeat) {
          if (await bridge.canary()) await freeze.heartbeat();
        } else {
          await freeze.heartbeat();
        }
      })();
    }
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TEST_BRIDGE") {
      void (async () => {
        const ok = await bridge.canary();
        return ok ? { ok: true } : { ok: false, diag: await probeClaudeTab() };
      })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === "TEST_HUBSPOT") {
      void scrapeHubspotDiag().then(sendResponse).catch((e) => sendResponse({ onHubspot: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === "SOURCE_PREVIEW") {
      void previewSourcing(storage).then(sendResponse).catch((e) => sendResponse({ onHubspot: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === "RESEARCH_THIN") {
      void researchThinAccounts(bridge, storage).then(sendResponse).catch((e) => sendResponse({ onHubspot: false, error: String(e?.message ?? e) }));
      return true;
    }
    if (msg?.type === "AUDIT_TAIL") {
      void audit.query(0).then((rows) => sendResponse({ rows: rows.slice(-25) }));
      return true;
    }
    return false;
  });
})();
