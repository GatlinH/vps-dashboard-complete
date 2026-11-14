// Bounded, integrity-checked offline scientific assets. No network service or
// extrapolation is used; every URL refers to a checked-in body/time block.
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';

const MAX_FILE_BYTES = 128 * 1024;
const CACHE_BYTES = 2 * 1024 * 1024;

export function createPrecisionAssetStore(
  fetchImpl,
  { cryptoImpl = globalThis.crypto, secureContext = globalThis.isSecureContext === true, signal } = {},
) {
  const controller = new AbortController();
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let residentBytes = 0;
  let downloadedBytes = 0;
  let requests = 0;
  let activeRequests = 0;
  let peakConcurrentRequests = 0;
  let disposed = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  function assertActive() {
    if (disposed || controller.signal.aborted) throw new Error('precision asset store disposed');
  }

  async function acquire() {
    assertActive();
    if (activeRequests < 4) {
      activeRequests += 1;
      return;
    }
    await new Promise((resolve, reject) => queue.push({ resolve, reject }));
  }

  async function request(url, kind) {
    await acquire();
    peakConcurrentRequests = Math.max(peakConcurrentRequests, activeRequests);
    requests += 1;
    const requestController = new AbortController();
    const stop = () => requestController.abort();
    controller.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(stop, 20000);
    try {
      assertActive();
      const response = await fetchImpl(url, {
        signal: requestController.signal,
        cache: kind === 'manifest' ? 'no-cache' : 'default',
      });
      if (!response.ok) throw new Error(`precision asset HTTP ${response.status}: ${url}`);
      if (kind === 'manifest') {
        const text = typeof response.text === 'function' ? await response.text() : null;
        const manifest = text === null ? await response.json() : JSON.parse(text);
        const size = new TextEncoder().encode(
          text ?? `${JSON.stringify(manifest, null, 2)}\n`,
        ).byteLength;
        if (size > MAX_FILE_BYTES) throw new Error('precision manifest exceeds byte budget');
        downloadedBytes += size;
        return manifest;
      }
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > MAX_FILE_BYTES)
        throw new Error('precision block exceeds byte budget');
      downloadedBytes += buffer.byteLength;
      return buffer;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', stop);
      const next = queue.shift();
      if (next) next.resolve();
      else activeRequests -= 1;
    }
  }

  function get(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    cache.set(key, entry);
    return entry.data;
  }

  async function load(key, url, sha256, expectedBytes, decode) {
    assertActive();
    if (cache.has(key)) return get(key);
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const buffer = await request(url, 'block');
      if (buffer.byteLength !== expectedBytes)
        throw new Error(`precision block length mismatch: ${key}`);
      const digest = secureContext && cryptoImpl?.subtle
        ? await cryptoImpl.subtle.digest('SHA-256', buffer)
        : nobleSha256(new Uint8Array(buffer));
      const actual = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (actual !== sha256) throw new Error(`EPHEMERIS_INTEGRITY_MISMATCH: ${key}`);
      const data = decode(buffer);
      assertActive();
      while (residentBytes + buffer.byteLength > CACHE_BYTES && cache.size) {
        const oldest = cache.keys().next().value;
        residentBytes -= cache.get(oldest).bytes;
        cache.delete(oldest);
      }
      cache.set(key, { data, bytes: buffer.byteLength });
      residentBytes += buffer.byteLength;
      return data;
    })();
    pending.set(key, job);
    try {
      return await job;
    } finally {
      pending.delete(key);
    }
  }

  return {
    get,
    has: (key) => cache.has(key),
    load,
    loadManifest: (url) => request(url, 'manifest'),
    assertActive,
    getDiagnostics: () => ({
      residentBytes,
      downloadedBytes,
      requests,
      activeRequests,
      peakConcurrentRequests,
      cachedBlocks: cache.size,
      pendingBlocks: pending.size,
      disposed,
    }),
    dispose() {
      disposed = true;
      controller.abort();
      signal?.removeEventListener('abort', abort);
      for (const entry of queue.splice(0))
        entry.reject(new Error('precision asset store disposed'));
      cache.clear();
      residentBytes = 0;
    },
  };
}
