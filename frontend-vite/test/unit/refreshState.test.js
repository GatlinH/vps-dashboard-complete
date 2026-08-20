import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('detail refresh visibility timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.window = { __DBG__: {} };
    globalThis.document = {
      hidden: false,
      addEventListener: vi.fn((_, handler) => { document.visibilityHandler = handler; }),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(async () => {
    const { stopDetailRefreshTimer } = await import('../../src/detail/refreshState.js');
    stopDetailRefreshTimer();
    vi.useRealTimers();
    delete globalThis.document;
    delete globalThis.window;
  });

  it('skips hidden ticks and refreshes immediately when visible again', async () => {
    const { startDetailRefreshTimer } = await import('../../src/detail/refreshState.js');
    const callback = vi.fn();
    startDetailRefreshTimer(callback, 5000);

    document.hidden = true;
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();

    document.hidden = false;
    document.visibilityHandler();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
