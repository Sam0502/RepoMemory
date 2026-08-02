import { describe, it, expect } from 'vitest';
import { MetricsRegistry, metrics, registerDefaultMetrics, DEFAULT_BUCKETS } from '@repo-memory/shared';

describe('MetricsRegistry', () => {
  it('increments counters and renders Prometheus text format', () => {
    const registry = new MetricsRegistry();
    registry.counter('foo_total', 'Foo counter help');
    registry.inc('foo_total');
    registry.inc('foo_total', { label: 'a' }, 2);

    const out = registry.render();
    expect(out).toContain('# HELP foo_total Foo counter help');
    expect(out).toContain('# TYPE foo_total counter');
    expect(out).toContain('foo_total 1');
    expect(out).toContain('foo_total{label="a"} 2');
  });

  it('sets and overwrites gauges', () => {
    const registry = new MetricsRegistry();
    registry.gauge('gauge', 'Gauge help');
    registry.set('gauge', 42);
    registry.set('gauge', 7, { repo: 'x' });

    const out = registry.render();
    expect(out).toContain('# TYPE gauge gauge');
    expect(out).toContain('gauge 42');
    expect(out).toContain('gauge{repo="x"} 7');
  });

  it('observes histograms into cumulative buckets and renders _sum/_count', () => {
    const registry = new MetricsRegistry();
    registry.histogram('latency_seconds', 'Latency', [0.1, 0.5, 1]);
    registry.observe('latency_seconds', 0.05);
    registry.observe('latency_seconds', 0.7);

    const out = registry.render();
    expect(out).toContain('# TYPE latency_seconds histogram');
    expect(out).toContain('latency_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('latency_seconds_bucket{le="0.5"} 1');
    expect(out).toContain('latency_seconds_bucket{le="1"} 2');
    expect(out).toContain('latency_seconds_bucket{le="+Inf"} 2');
    expect(out).toContain('latency_seconds_sum 0.75');
    expect(out).toContain('latency_seconds_count 2');
  });

  it('supports labeled histogram series', () => {
    const registry = new MetricsRegistry();
    registry.histogram('h', 'Help', [1]);
    registry.observe('h', 0.5, { route: '/health' });

    const out = registry.render();
    expect(out).toContain('h_bucket{route="/health",le="1"} 1');
    expect(out).toContain('h_bucket{route="/health",le="+Inf"} 1');
    expect(out).toContain('h_count{route="/health"} 1');
  });

  it('escapes label values', () => {
    const registry = new MetricsRegistry();
    registry.counter('c', 'Help');
    registry.inc('c', { q: 'a"b\nc' });
    expect(registry.render()).toContain('c{q="a\\"b\\nc"} 1');
  });

  it('sorts labels deterministically', () => {
    const registry = new MetricsRegistry();
    registry.counter('c', 'Help');
    registry.inc('c', { z: '1', a: '2' });
    expect(registry.render()).toContain('c{a="2",z="1"} 1');
  });

  it('throws when operating on an unregistered metric', () => {
    const registry = new MetricsRegistry();
    expect(() => registry.inc('nope')).toThrow(/not registered/);
    expect(() => registry.set('nope', 1)).toThrow(/not registered/);
    expect(() => registry.observe('nope', 1)).toThrow(/not registered/);
  });

  it('exposes DEFAULT_BUCKETS as an ascending array', () => {
    expect(DEFAULT_BUCKETS[0]).toBe(0.005);
    expect(DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1]).toBe(10);
  });
});

describe('registerDefaultMetrics', () => {
  it('registers the standard metric set on the global registry', () => {
    registerDefaultMetrics();
    metrics.set('repo_memory_queue_depth', 3);
    const out = metrics.render();

    expect(out).toContain('# TYPE repo_memory_entities_scanned_total counter');
    expect(out).toContain('# TYPE repo_memory_relationships_stored_total counter');
    expect(out).toContain('# TYPE repo_memory_embedding_calls_total counter');
    expect(out).toContain('# TYPE repo_memory_api_requests_total counter');
    expect(out).toContain('# TYPE repo_memory_scan_duration_seconds histogram');
    expect(out).toContain('# TYPE repo_memory_api_request_duration_seconds histogram');
    expect(out).toContain('# TYPE repo_memory_queue_depth gauge');
    expect(out).toContain('# TYPE repo_memory_last_scan_timestamp_seconds gauge');
    expect(out).toContain('repo_memory_queue_depth 3');
  });
});
