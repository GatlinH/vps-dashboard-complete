import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('GET request cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.window = { __DBG__: {} };
    globalThis.location = { port: '', origin: 'http://localhost', protocol: 'http:', hostname: 'localhost' };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.fetch;
    delete globalThis.window;
    delete globalThis.location;
  });

  it('deduplicates within the cache window and evicts after expiry', async () => {
    const { fetchJson } = await import('../../src/services/displayData.js');
    await Promise.all([fetchJson('/cached', { cacheMs: 5000 }), fetchJson('/cached', { cacheMs: 5000 })]);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await fetchJson('/cached', { cacheMs: 5000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
