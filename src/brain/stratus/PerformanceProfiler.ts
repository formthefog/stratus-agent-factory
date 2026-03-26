/**
 * Performance Profiler — Per-component latency tracking and budget alerts
 *
 * Tracks latency for each pipeline component and alerts when budgets
 * are exceeded. Accumulates stats across a turn for summary reporting.
 *
 * Latency budgets (from spec):
 * - State encoding: <10ms
 * - Probe ranking: <5ms
 * - Tree search: <500ms
 * - LLM generation: variable (tracked, not budgeted)
 * - Tool execution: variable (tracked, not budgeted)
 * - Observation encoding: <50ms (v1), <10ms (v2)
 *
 * @purpose Per-component latency tracking with budget alerting
 * @spec AGENT_FACTORY_SPEC.md#b53-build-performance-profiler
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentName =
  | "state_encoding"
  | "probe_ranking"
  | "tree_search"
  | "generation"
  | "execution"
  | "observation"
  | "goal_check"
  | "total_step";

export interface LatencyBudget {
  component: ComponentName;
  budgetMs: number;
  /** Whether exceeding budget is a hard error vs soft warning */
  hard: boolean;
}

export interface ComponentStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  budgetExceeded: number;
}

export interface ProfilerSummary {
  turnDurationMs: number;
  totalSteps: number;
  components: Record<string, ComponentStats>;
  alerts: ProfilerAlert[];
}

export interface ProfilerAlert {
  component: ComponentName;
  step: number;
  actualMs: number;
  budgetMs: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Default Budgets
// ---------------------------------------------------------------------------

const DEFAULT_BUDGETS: LatencyBudget[] = [
  { component: "state_encoding", budgetMs: 10, hard: false },
  { component: "probe_ranking", budgetMs: 5, hard: false },
  { component: "tree_search", budgetMs: 500, hard: false },
  { component: "observation", budgetMs: 50, hard: false },
  { component: "goal_check", budgetMs: 10, hard: false },
];

// ---------------------------------------------------------------------------
// Profiler
// ---------------------------------------------------------------------------

export class PerformanceProfiler {
  private budgets: Map<ComponentName, LatencyBudget>;
  private measurements: Map<string, number[]> = new Map();
  private alerts: ProfilerAlert[] = [];
  private turnStart = 0;
  private stepCount = 0;

  constructor(budgets?: LatencyBudget[]) {
    this.budgets = new Map();
    for (const b of budgets ?? DEFAULT_BUDGETS) {
      this.budgets.set(b.component, b);
    }
  }

  /** Start profiling a turn. */
  startTurn(): void {
    this.turnStart = Date.now();
    this.measurements.clear();
    this.alerts = [];
    this.stepCount = 0;
  }

  /** Record a component's latency for the current step. */
  record(component: ComponentName, durationMs: number, step?: number): void {
    const key = component;
    if (!this.measurements.has(key)) {
      this.measurements.set(key, []);
    }
    this.measurements.get(key)!.push(durationMs);

    // Check budget
    const budget = this.budgets.get(component);
    if (budget && durationMs > budget.budgetMs) {
      this.alerts.push({
        component,
        step: step ?? this.stepCount,
        actualMs: durationMs,
        budgetMs: budget.budgetMs,
        message: `${component} took ${durationMs}ms (budget: ${budget.budgetMs}ms)`,
      });
    }
  }

  /** Mark a step as completed. */
  stepCompleted(): void {
    this.stepCount++;
  }

  /**
   * Time a function and record its latency.
   */
  async time<T>(
    component: ComponentName,
    fn: () => Promise<T>,
    step?: number,
  ): Promise<T> {
    const start = Date.now();
    const result = await fn();
    this.record(component, Date.now() - start, step);
    return result;
  }

  /** Get the profiling summary for this turn. */
  getSummary(): ProfilerSummary {
    const components: Record<string, ComponentStats> = {};

    for (const [name, values] of this.measurements) {
      const budget = this.budgets.get(name as ComponentName);
      components[name] = {
        count: values.length,
        totalMs: values.reduce((a, b) => a + b, 0),
        minMs: Math.min(...values),
        maxMs: Math.max(...values),
        avgMs: values.reduce((a, b) => a + b, 0) / values.length,
        budgetExceeded: budget
          ? values.filter((v) => v > budget.budgetMs).length
          : 0,
      };
    }

    return {
      turnDurationMs: Date.now() - this.turnStart,
      totalSteps: this.stepCount,
      components,
      alerts: [...this.alerts],
    };
  }

  /** Get alerts from this turn. */
  getAlerts(): ProfilerAlert[] {
    return [...this.alerts];
  }

  /** Check if any hard budget was exceeded. */
  hasHardViolation(): boolean {
    return this.alerts.some((a) => {
      const budget = this.budgets.get(a.component);
      return budget?.hard === true;
    });
  }
}
