import { describe, expect, it } from 'vitest';
import { acceptHealthSnapshot, buildAggregateHealthSnapshot, evaluateHealthSnapshot } from '../../src/detail/healthSnapshot.js';

const iso = (ms) => new Date(ms).toISOString();

describe('detail health snapshot contract', () => {
  const now = Date.parse('2026-09-15T00:00:00Z');

  it('uses fresh raw telemetry instead of an old long-range bucket', () => {
    const snapshot = buildAggregateHealthSnapshot({
      serverId: 'b', generation: 1, receiveSeq: 1,
      payload: {
        live: { server_id: 'b', updated_at: iso(now - 5_000), status: 'online', cpu_use: 10, ram_use: 20 },
        resource_timeline: [
          { server_id: 'b', created_at: iso(now - 25_000), cpu_use: 9 },
          { server_id: 'b', created_at: iso(now - 5_000), cpu_use: 10 },
        ],
      },
    });
    expect(evaluateHealthSnapshot(snapshot, now).state).toBe('ok');
  });

  it('is unknown without raw telemetry and when live falsely leads frozen raw', () => {
    const missing = buildAggregateHealthSnapshot({ serverId: 'b', generation: 1, receiveSeq: 1, payload: { live: { server_id: 'b', updated_at: iso(now), cpu_use: 4 } } });
    expect(evaluateHealthSnapshot(missing, now).state).toBe('unknown');
    const frozen = buildAggregateHealthSnapshot({
      serverId: 'b', generation: 1, receiveSeq: 2,
      payload: {
        live: { server_id: 'b', updated_at: iso(now), cpu_use: 4 },
        resource_timeline: [
          { server_id: 'b', created_at: iso(now - 100_000), cpu_use: 4 },
          { server_id: 'b', created_at: iso(now - 80_000), cpu_use: 4 },
        ],
      },
    });
    expect(evaluateHealthSnapshot(frozen, now).state).toBe('unknown');
  });

  it('keeps missing status unknown until true stale danger', () => {
    const snapshot = buildAggregateHealthSnapshot({ serverId: 'b', generation: 1, receiveSeq: 1, payload: { resource_timeline: [{ server_id: 'b', created_at: iso(now), cpu_use: 10 }] } });
    expect(evaluateHealthSnapshot(snapshot, now + 31_000).state).toBe('unknown');
    expect(evaluateHealthSnapshot(snapshot, now + 181_000).state).toBe('danger');
  });

  it('keeps danger above unknown and does not inherit missing metrics', () => {
    const snapshot = buildAggregateHealthSnapshot({
      serverId: 'b', generation: 1, receiveSeq: 1,
      payload: { live: { server_id: 'b', updated_at: iso(now), cpu_use: 96, ram_use: null }, resource_timeline: [{ server_id: 'b', created_at: iso(now - 90_000), cpu_use: 96 }] },
    });
    const health = evaluateHealthSnapshot(snapshot, now);
    expect(health.state).toBe('danger');
    expect(health.metrics.ramPct).toBeNull();
  });

  it('accepts same-timestamp realtime offline and rejects stale or cross-server writes', () => {
    const online = buildAggregateHealthSnapshot({ serverId: 'b', generation: 2, receiveSeq: 2, payload: { live: { server_id: 'b', updated_at: iso(now), status: 'online' }, resource_timeline: [{ server_id: 'b', created_at: iso(now), cpu_use: 1 }] } });
    const offline = buildAggregateHealthSnapshot({ serverId: 'b', generation: 2, receiveSeq: 3, source: 'live', payload: { live: { server_id: 'b', updated_at: iso(now), status: 'offline' }, resource_timeline: [{ server_id: 'b', created_at: iso(now), cpu_use: 1 }] } });
    expect(acceptHealthSnapshot(online, offline)).toBe(offline);
    expect(evaluateHealthSnapshot(offline, now).state).toBe('danger');
    const older = buildAggregateHealthSnapshot({ serverId: 'b', generation: 2, receiveSeq: 1, payload: { live: { server_id: 'b', updated_at: iso(now - 1_000), status: 'online' } } });
    const other = buildAggregateHealthSnapshot({ serverId: 'a', generation: 2, receiveSeq: 4, payload: { live: { server_id: 'a', updated_at: iso(now + 1_000) } } });
    expect(acceptHealthSnapshot(offline, older)).toBe(offline);
    expect(acceptHealthSnapshot(offline, other)).toBe(offline);
  });

  it('bounds normal sample interval so a large gap cannot inflate it', () => {
    const snapshot = buildAggregateHealthSnapshot({ serverId: 'b', generation: 1, receiveSeq: 1, payload: { resource_timeline: [0, 20, 40, 400].map((seconds) => ({ server_id: 'b', created_at: iso(now + seconds * 1000), cpu_use: 1 })) } });
    expect(snapshot.raw.sampleSec).toBe(20);
  });

  it('parses UTC-naive server timestamps as UTC and preserves warn thresholds', () => {
    const snapshot = buildAggregateHealthSnapshot({
      serverId: 'b', generation: 1, receiveSeq: 1,
      payload: {
        live: { server_id: 'b', updated_at: '2026-09-15T00:00:00', status: 'online', cpu_use: 86, packet_loss: 6 },
        resource_timeline: [{ server_id: 'b', created_at: '2026-09-15T00:00:00', cpu_use: 86 }],
      },
    });
    const health = evaluateHealthSnapshot(snapshot, now + 5_000);
    expect(health.rawAgeMs).toBe(5_000);
    expect(health.state).toBe('warn');
  });
});
