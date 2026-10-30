/** One run of the user's workflow. `ms` is the latency the eval thresholds against; `label` is what the user typed or uploaded. */
export interface Trace { id: number; ms: number; label: string }
export interface Verdict { passed: Trace[]; failed: Trace[]; rate: number }

/** Scoring lives behind this interface so the in-browser simulation can be swapped for the MARS API without touching the page. */
export interface Scorer {
  score(traces: Trace[], thresholdMs: number): Promise<Verdict> | Verdict;
  /** Pass rate of the candidate after `hours` of training on `verdict.passed`. */
  train(verdict: Verdict, hours: number): Promise<number> | number;
}

const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** Deterministic latency for a keystroke / uploaded item: log-normal-ish around 620 ms, so ~70 % pass at 800 ms. */
export function latencyFor(seed: number) {
  const u = Math.max(1e-4, hash(seed)), v = hash(seed * 1.7 + 9.2);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v);
  return Math.round(Math.min(2400, Math.max(120, Math.exp(6.33 + z * .42))));
}

export class Simulation implements Scorer {
  /** Day-one pass rate of the incumbent (the open-weights model before it has seen your work). */
  readonly incumbent = .58;
  score(traces: Trace[], thresholdMs: number): Verdict {
    const passed = traces.filter(t => t.ms < thresholdMs), failed = traces.filter(t => t.ms >= thresholdMs);
    return { passed, failed, rate: traces.length ? passed.length / traces.length : 0 };
  }
  train(verdict: Verdict, hours: number) {
    const data = Math.min(1, verdict.passed.length / 60);
    return Math.min(.97, .3 + data * .32 + Math.min(hours, 8) * .045 + verdict.rate * .1);
  }
}

/** Placeholder for the real service: same contract, POSTs the traces. Not used until an endpoint exists. */
export class RemoteScorer implements Scorer {
  constructor(private readonly endpoint: string) {}
  async score(traces: Trace[], thresholdMs: number) {
    const response = await fetch(`${this.endpoint}/score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ traces, thresholdMs }) });
    return (await response.json()) as Verdict;
  }
  async train(verdict: Verdict, hours: number) {
    const response = await fetch(`${this.endpoint}/train`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passed: verdict.passed, hours }) });
    return (await response.json() as { rate: number }).rate;
  }
}

/** Accepts an array of numbers, or objects with ms / latency / duration (+ optional name / id / task) — enough for most trace exports. */
export function tracesFromJson(text: string): Trace[] {
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw && Array.isArray((raw as { traces?: unknown }).traces) ? (raw as { traces: unknown[] }).traces : [];
  return list.slice(0, 1000).map((item, i) => {
    if (typeof item === 'number') return { id: i, ms: item, label: `trace ${i}` };
    const o = item as Record<string, unknown>;
    const ms = Number(o.ms ?? o.latency ?? o.latency_ms ?? o.duration ?? o.duration_ms ?? latencyFor(i + 500));
    const label = String(o.name ?? o.task ?? o.id ?? `trace ${i}`);
    return { id: i, ms: Number.isFinite(ms) ? ms : latencyFor(i + 500), label };
  });
}
