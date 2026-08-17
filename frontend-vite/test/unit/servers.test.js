import { describe, expect, it } from 'vitest';
import { buildServerPayload } from '../../src/api/serverPayload.js';

describe('server payload normalization', () => {
  it('builds the exact create payload, including create-only fields', () => {
    expect(
      buildServerPayload(
        {
          name: 'edge-01',
          ip: '192.0.2.10',
          group_id: 0,
          flag: '',
          location: '',
          bw: '',
          cpu: '',
          ram: null,
          disk: '',
          price: '',
          period: '',
          expiry: '',
          probe: '',
          note: '',
          provider: '',
          tags: ' production, , edge ,  ',
          traffic_limit_gb: '',
          traffic_reset_day: '',
          agent_config: { interval: 30 },
          provisionAgent: false,
        },
        { forCreate: true },
      ),
    ).toEqual({
      name: 'edge-01',
      ip: '192.0.2.10',
      group_id: 0,
      flag: '🌐',
      location: '',
      bandwidth: '待 Agent 回填',
      cpu_cores: 0,
      ram_gb: 0,
      disk_gb: 0,
      price: 0,
      period: 'monthly',
      expiry: null,
      probe_url: '',
      note: '',
      provider: '',
      tags: ['production', 'edge'],
      traffic_limit_gb: 0,
      traffic_reset_day: 1,
      agent_config: { interval: 30 },
      provision_agent: false,
    });
  });

  it('builds the exact update payload and omits every create-only field', () => {
    expect(
      buildServerPayload({
        name: 'edge-02',
        ip: '198.51.100.20',
        group_id: 0,
        group: 'ignored',
        flag: 'US',
        location: 'New York',
        bw: '1 Gbps',
        cpu: '8',
        ram: '16.5',
        disk: '250',
        price: '12.75',
        period: 'yearly',
        expiry: '2027-01-01',
        probe: 'https://example.test/health',
        note: 'primary',
        provider: 'Example Cloud',
        tags: ' public, , production ',
        traffic_limit_gb: '',
        traffic_reset_day: null,
        agent_config: { interval: 10 },
        provisionAgent: true,
      }),
    ).toEqual({
      name: 'edge-02',
      ip: '198.51.100.20',
      group_id: 0,
      flag: 'US',
      location: 'New York',
      bandwidth: '1 Gbps',
      price: 12.75,
      period: 'yearly',
      expiry: '2027-01-01',
      probe_url: 'https://example.test/health',
      note: 'primary',
      provider: 'Example Cloud',
      tags: ['public', 'production'],
      traffic_limit_gb: 0,
      traffic_reset_day: 1,
    });
  });
});
