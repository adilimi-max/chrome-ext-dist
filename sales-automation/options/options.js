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

  // src/shared/autonomy.ts
  var DEFAULT_CONFIG = {
    allowAutoSend: false,
    deploymentMode: "DRAFT",
    workingHours: { startHour: 7, endHour: 19, tz: "Europe/Stockholm" },
    exportLedger: false,
    bridgeHeartbeat: false
  };

  // src/options/options.ts
  var sel = (id) => document.getElementById(id);
  var diag = (data) => {
    const el = sel("diag");
    if (el) el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  };
  var sendToWorker = (type) => new Promise((resolve) => chrome.runtime.sendMessage({ type }, (r) => resolve(r)));
  async function load() {
    const storage = makeStorage(chromeBackend());
    const cfg = await storage.getOr("config", DEFAULT_CONFIG);
    const mode = sel("mode");
    if (mode) mode.value = cfg.deploymentMode;
    const autosend = sel("autosend");
    if (autosend) autosend.textContent = cfg.allowAutoSend ? "ON" : "OFF (draft-only)";
    const ver = sel("ver");
    const m = chrome.runtime.getManifest();
    if (ver) ver.textContent = m.version_name ?? `v${m.version}`;
  }
  function renderSweep(s) {
    if (!s || s.error) {
      diag(s?.error ? `error: ${s.error}` : "no response");
      return;
    }
    if (s.active === void 0 && s.results === void 0) {
      diag(s);
      return;
    }
    const phase = s.done ? "DONE" : s.active ? "RUNNING" : "STOPPED";
    const results = (s.results ?? []).slice().sort((a, b) => b.score - a.score);
    const head = `Sweep ${phase} \u2014 page ${(s.page ?? 0) + 1} \xB7 considered ${s.consideredCount ?? 0} \xB7 researched ${s.researchedCount ?? 0} \xB7 good-fit (WARM+) ${results.length}`;
    const lines = results.slice(0, 50).map((r, i) => `${String(i + 1).padStart(2)}. [${r.tier}] ${r.score}  ${r.name}${r.researched ? " *" : ""}
      ${r.domain} \u2014 ${r.why}`);
    diag(`${head}
${"-".repeat(48)}
${lines.join("\n") || "(no WARM+ fits yet \u2014 keep it running)"}

* = enriched by web research`);
  }
  async function save() {
    const storage = makeStorage(chromeBackend());
    const mode = sel("mode")?.value;
    const token = sel("tg")?.value.trim() ?? "";
    await storage.update("config", (cur) => ({
      ...cur ?? DEFAULT_CONFIG,
      deploymentMode: mode ?? (cur ?? DEFAULT_CONFIG).deploymentMode
    }));
    if (token) await storage.set("telegram", { botToken: token, chatId: "", enabled: true });
    const status = sel("status");
    if (status) status.textContent = "Saved.";
  }
  async function seedDemoQueue() {
    const storage = makeStorage(chromeBackend());
    const now = Date.now();
    const items = [
      { id: "demo1", surface: "hubspot", preview: "Claim: Acme (HOT \xB7 82) \u2014 3 products w/ intent, new VP Sales", createdAt: now - 4 * 6e4 },
      { id: "demo2", surface: "gmail", preview: 'Draft reply: "Quick idea on your Q3 rollout"', createdAt: now - 12 * 6e4 },
      { id: "demo3", surface: "local", preview: "Install-base expansion: Globex (WARM \xB7 64) \u2014 95% seats, renewal 60d", createdAt: now - 1 * 6e4 }
    ];
    await storage.set("stagedItems", items);
    diag(`Seeded ${items.length} demo staged items. Open the popup to see them.`);
  }
  async function clearAll() {
    await chrome.storage.local.clear();
    diag("All extension storage cleared.");
  }
  document.addEventListener("DOMContentLoaded", () => {
    void load();
    sel("save")?.addEventListener("click", () => void save());
    sel("seed")?.addEventListener("click", () => void seedDemoQueue());
    sel("clear")?.addEventListener("click", () => void clearAll());
    sel("bridge")?.addEventListener("click", () => {
      diag("Testing claude.ai bridge\u2026 (opens a background tab; give it ~5s)");
      void sendToWorker("TEST_BRIDGE").then((r) => diag(r ?? { error: "no response from worker" }));
    });
    sel("hubspot")?.addEventListener("click", () => {
      diag("Reading your HubSpot list view\u2026 (open your open-pool index table in a tab first)");
      void sendToWorker("TEST_HUBSPOT").then((r) => diag(r ?? { error: "no response from worker" }));
    });
    sel("sourcepreview")?.addEventListener("click", () => {
      diag("Scoring your live open pool\u2026 (open your open-pool list view in a tab first; OBSERVE \u2014 nothing is claimed)");
      void sendToWorker("SOURCE_PREVIEW").then((r) => diag(r ?? { error: "no response from worker" }));
    });
    sel("sweepstart")?.addEventListener("click", () => {
      diag('Sweep starting\u2026 open your HubSpot open-pool list + a logged-in claude.ai tab (web search ON), then walk away. It checkpoints as it goes \u2014 click "Sweep status / results" anytime to watch progress + see good-fit accounts.');
      void sendToWorker("START_SWEEP").then(() => sendToWorker("SWEEP_STATUS")).then(renderSweep);
    });
    sel("sweepstatus")?.addEventListener("click", () => {
      void sendToWorker("SWEEP_STATUS").then(renderSweep);
    });
    sel("sweepstop")?.addEventListener("click", () => {
      void sendToWorker("STOP_SWEEP").then(renderSweep);
    });
    sel("research")?.addEventListener("click", () => {
      diag("Researching thin accounts via Claude.ai (web search)\u2026 this can take a couple of minutes \u2014 each is a live lookup. Results cache as they finish, so re-running continues where it left off.");
      void sendToWorker("RESEARCH_THIN").then((r) => diag(r ?? { error: "no response (research may still be running \u2014 re-run Preview to see cached results)" }));
    });
    sel("audit")?.addEventListener("click", () => {
      void sendToWorker("AUDIT_TAIL").then((r) => diag(r?.rows ?? []));
    });
  });
})();
