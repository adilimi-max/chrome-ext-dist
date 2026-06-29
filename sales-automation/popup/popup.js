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

  // src/shared/popup-view.ts
  function buildPopupView(items, now) {
    const bySurface = {};
    for (const it of items) {
      const card = {
        id: it.id,
        surface: it.surface,
        preview: it.preview,
        ageMinutes: Math.max(0, Math.round((now - it.createdAt) / 6e4))
      };
      (bySurface[it.surface] ??= []).push(card);
    }
    return { count: items.length, bySurface };
  }

  // src/popup/popup.ts
  async function render() {
    const storage = makeStorage(chromeBackend());
    const items = await storage.get("stagedItems") ?? [];
    const view = buildPopupView(items, Date.now());
    const count = document.getElementById("count");
    if (count) count.textContent = String(view.count);
    const root = document.getElementById("queue");
    if (!root) return;
    root.textContent = "";
    if (view.count === 0) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Nothing staged. You\u2019re clear.";
      root.appendChild(e);
      return;
    }
    for (const cards of Object.values(view.bySurface)) {
      for (const c of cards) {
        const card = document.createElement("div");
        card.className = "card";
        const bar = document.createElement("div");
        bar.className = "bar";
        const body = document.createElement("div");
        body.className = "body";
        const sfc = document.createElement("div");
        sfc.className = "sfc";
        sfc.textContent = c.surface;
        const pv = document.createElement("div");
        pv.className = "pv";
        pv.textContent = c.preview;
        const age = document.createElement("div");
        age.className = "age";
        age.textContent = `${c.ageMinutes}m ago`;
        body.append(sfc, pv, age);
        card.append(bar, body);
        root.appendChild(card);
      }
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    void render();
  });
})();
