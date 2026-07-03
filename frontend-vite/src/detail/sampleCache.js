export function createDetailPingSampleCache({ pingStepValue, windowMs = 12 * 60 * 60 * 1000 } = {}) {
  const toStep = typeof pingStepValue === 'function' ? pingStepValue : (value) => value;
  const cache = {
    windowMs,
    store: {},
    setUnavailable(serverId) {
      this.clear();
      if (serverId) {
        try { localStorage.removeItem(detailPingStoreKey(serverId)); } catch (_) {}
      }
    },
    clear() {
      Object.keys(this.store).forEach((key) => { delete this.store[key]; });
      window.__DBG__.DETAIL_PING_SAMPLE_CACHE = this.store;
    },
    ensure(key) {
      if (!this.store[key]) this.store[key] = [];
      return this.store[key];
    },
    prune(key, cutoff) {
      this.store[key] = (this.store[key] || []).filter((point) => point.x >= cutoff);
    },
    expose() {
      window.__DBG__.DETAIL_PING_SAMPLE_CACHE = this.store;
    },
    mergeStored(next = {}) {
      for (const [key, rows] of Object.entries(next || {})) this.store[key] = rows;
      this.expose();
    },
    loadStored(serverId) {
      if (typeof localStorage === 'undefined' || !serverId) return;
      try {
        const raw = localStorage.getItem(detailPingStoreKey(serverId));
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const cutoff = Date.now() - this.windowMs;
        const next = {};
        for (const [key, arr] of Object.entries(parsed || {})) {
          const rows = Array.isArray(arr)
            ? arr.filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.rawMs)) && Number(point.x) >= cutoff)
            : [];
          if (rows.length) next[key] = rows.map((point) => ({ ...point, x: Number(point.x), rawMs: Number(point.rawMs), y: toStep(point.rawMs) }));
        }
        this.mergeStored(next);
      } catch (_) {}
    },
    saveStored(serverId) {
      if (typeof localStorage === 'undefined' || !serverId) return;
      try {
        const cutoff = Date.now() - this.windowMs;
        const compact = {};
        for (const [key, arr] of Object.entries(this.store || {})) {
          const rows = (Array.isArray(arr) ? arr : [])
            .filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.rawMs)) && Number(point.x) >= cutoff)
            .slice(-1600);
          if (rows.length) compact[key] = rows;
        }
        localStorage.setItem(detailPingStoreKey(serverId), JSON.stringify(compact));
      } catch (_) {}
    },
  };
  cache.expose();
  return cache;
}

function detailPingStoreKey(serverId) {
  return `vps-detail-ping-samples:${serverId || 'unknown'}`;
}


export function createDetailTelemetrySampleCache({ windowMs = 12 * 60 * 60 * 1000, maxRows = 21600 } = {}) {
  const cache = {
    windowMs,
    maxRows,
    rows: [],
    expose() {
      window.__DBG__.DETAIL_TELEMETRY_SAMPLE_CACHE = this.rows;
    },
    loadStored(serverId) {
      if (typeof localStorage === 'undefined' || !serverId) return;
      try {
        const raw = localStorage.getItem(detailTelemetryStoreKey(serverId));
        if (!raw) return;
        const cutoff = Date.now() - this.windowMs;
        this.rows = (JSON.parse(raw) || [])
          .filter((row) => Number.isFinite(Number(row.__timeMs)) && Number(row.__timeMs) >= cutoff)
          .slice(-this.maxRows);
        this.expose();
      } catch (_) {}
    },
    saveStored(serverId) {
      if (typeof localStorage === 'undefined' || !serverId) return;
      try {
        const cutoff = Date.now() - this.windowMs;
        const compact = (this.rows || [])
          .filter((row) => Number.isFinite(Number(row.__timeMs)) && Number(row.__timeMs) >= cutoff)
          .slice(-this.maxRows);
        localStorage.setItem(detailTelemetryStoreKey(serverId), JSON.stringify(compact));
      } catch (_) {}
    },
    record(server = null, fetchedAt = Date.now()) {
      if (!server?.id) return;
      const last = this.rows[this.rows.length - 1];
      // Frontend refresh is 500ms; keep one real chart sample per agent interval bucket.
      if (last && fetchedAt - Number(last.__timeMs) < 180) return;
      const row = {
        __timeMs: fetchedAt,
        created_at: new Date(fetchedAt).toISOString(),
        __frontendCache: true,
        status: server.status || 'online',
        cpu_use: Number(server.cpu_use ?? server.cpu ?? 0),
        ram_use: Number(server.ram_use ?? server.memory_percent ?? server.mem_use ?? 0),
        net_up: Math.max(0, Number(server.net_up ?? server.netUp ?? 0)),
        net_down: Math.max(0, Number(server.net_down ?? server.netDown ?? 0)),
      };
      this.rows.push(row);
      const cutoff = fetchedAt - this.windowMs;
      this.rows = this.rows.filter((item) => Number(item.__timeMs) >= cutoff).slice(-this.maxRows);
      this.expose();
      this.saveStored(server.id);
    },
  };
  cache.expose();
  return cache;
}

function detailTelemetryStoreKey(serverId) {
  return `vps-detail-telemetry-samples:${serverId || 'unknown'}`;
}
