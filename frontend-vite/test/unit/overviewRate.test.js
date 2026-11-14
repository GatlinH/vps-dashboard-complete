import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let renderOverviewNodeCard;
let normalizeServer;

beforeAll(async () => {
  const localStorage = { getItem: () => null, setItem: vi.fn() };
  vi.stubGlobal('window', {
    localStorage,
    location: { origin: 'http://local.test' },
    __DBG__: { API_ROOT: '' },
  });
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'dark', setAttribute: vi.fn() },
  });
  ({ renderOverviewNodeCard } = await import('../../src/pages/overviewPage.js'));
  ({ normalizeServer } = await import('../../src/services/displayData.js'));
});

afterAll(() => vi.unstubAllGlobals());

describe('overview agent KB/s statistics', () => {
  it('groups live rates and real cycle traffic without inventing missing values', () => {
    const html = renderOverviewNodeCard(
      normalizeServer({ id: 1, net_up: 0, net_down: 1024, traffic_up_gb: 0, traffic_down_gb: 2 }),
    );
    expect(html).toContain('即时网速');
    expect(html).toContain('本月 / 本周期流量');
    expect(html).toContain('↑ 0 KB/s');
    expect(html).toContain('↓ 1.00 MB/s');
    expect(html).toContain('↑ 0 B');
    expect(html).toContain('↓ 2.00 GB');
    const missing = renderOverviewNodeCard(normalizeServer({ id: 2 }));
    expect(missing).toContain('↑ —');
    expect(missing).toContain('↓ —');
    expect(missing).not.toContain('0 KB/s');
  });
});
