export type MetricLabels = Record<string, string>;

interface CounterState {
  help: string;
  values: Map<string, number>;
}

interface GaugeState {
  help: string;
  values: Map<string, number>;
}

interface HistogramState {
  help: string;
  buckets: number[];
  values: Map<string, { counts: number[]; sum: number; count: number }>;
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsKey(labels: MetricLabels | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(labels[k])}"`)
    .join(',');
}

function formatSeries(name: string, key: string, value: number | string): string {
  return key ? `${name}{${key}} ${value}` : `${name} ${value}`;
}

function formatSeriesWithLabel(name: string, key: string, extraLabel: string, value: number | string): string {
  const label = key ? `${key},${extraLabel}` : extraLabel;
  return `${name}{${label}} ${value}`;
}

/**
 * In-process Prometheus-style metrics registry. Counters increment, gauges are
 * set, and histograms observe samples into fixed buckets. Rendering emits the
 * Prometheus text exposition format so a /metrics endpoint can serve it.
 */
export class MetricsRegistry {
  private counters = new Map<string, CounterState>();
  private gauges = new Map<string, GaugeState>();
  private histograms = new Map<string, HistogramState>();

  counter(name: string, help: string): this {
    if (!this.counters.has(name)) {
      this.counters.set(name, { help, values: new Map() });
    }
    return this;
  }

  gauge(name: string, help: string): this {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, { help, values: new Map() });
    }
    return this;
  }

  histogram(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS): this {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, { help, buckets, values: new Map() });
    }
    return this;
  }

  inc(name: string, labels?: MetricLabels, value: number = 1): void {
    const state = this.counters.get(name);
    if (!state) {
      throw new Error(`Counter "${name}" is not registered`);
    }
    const key = labelsKey(labels);
    state.values.set(key, (state.values.get(key) || 0) + value);
  }

  set(name: string, value: number, labels?: MetricLabels): void {
    const state = this.gauges.get(name);
    if (!state) {
      throw new Error(`Gauge "${name}" is not registered`);
    }
    state.values.set(labelsKey(labels), value);
  }

  observe(name: string, value: number, labels?: MetricLabels): void {
    const state = this.histograms.get(name);
    if (!state) {
      throw new Error(`Histogram "${name}" is not registered`);
    }
    const key = labelsKey(labels);
    let entry = state.values.get(key);
    if (!entry) {
      entry = { counts: new Array(state.buckets.length).fill(0), sum: 0, count: 0 };
      state.values.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (let i = 0; i < state.buckets.length; i++) {
      if (value <= state.buckets[i]) entry.counts[i] += 1;
    }
  }

  render(): string {
    const lines: string[] = [];

    for (const [name, state] of this.counters) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} counter`);
      for (const [key, value] of state.values) {
        lines.push(formatSeries(name, key, value));
      }
    }

    for (const [name, state] of this.gauges) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} gauge`);
      for (const [key, value] of state.values) {
        lines.push(formatSeries(name, key, value));
      }
    }

    for (const [name, state] of this.histograms) {
      lines.push(`# HELP ${name} ${state.help}`, `# TYPE ${name} histogram`);
      for (const [key, entry] of state.values) {
        for (let i = 0; i < state.buckets.length; i++) {
          lines.push(formatSeriesWithLabel(`${name}_bucket`, key, `le="${state.buckets[i]}"`, entry.counts[i]));
        }
        lines.push(formatSeriesWithLabel(`${name}_bucket`, key, `le="+Inf"`, entry.count));
        lines.push(formatSeries(`${name}_sum`, key, entry.sum));
        lines.push(formatSeries(`${name}_count`, key, entry.count));
      }
    }

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();

/**
 * Register the standard set of process / scan / API metrics. Idempotent, so it
 * is safe to call from any entrypoint (orchestrator init, server start).
 */
export function registerDefaultMetrics(): void {
  metrics.counter('repo_memory_entities_scanned_total', 'Total number of entities scanned from source files');
  metrics.counter('repo_memory_relationships_stored_total', 'Total number of relationships stored in the graph');
  metrics.counter('repo_memory_embedding_calls_total', 'Total number of embedding calls');
  metrics.counter('repo_memory_api_requests_total', 'Total number of HTTP API requests');
  metrics.histogram('repo_memory_scan_duration_seconds', 'Duration of repository scans in seconds');
  metrics.histogram('repo_memory_api_request_duration_seconds', 'HTTP API request duration in seconds');
  metrics.gauge('repo_memory_queue_depth', 'Number of pending jobs in the ingestion queue');
  metrics.gauge('repo_memory_last_scan_timestamp_seconds', 'Unix timestamp of the last completed scan');
  metrics.set('repo_memory_queue_depth', 0);
}
