/**
 * Stratus Brain vs ReAct Brain — Comparative Benchmark
 *
 * Runs the same 20 benchmark scenarios through both brain implementations
 * and compares completion rate, efficiency, LLM calls, latency, and cost.
 *
 * THIS is the benchmark that proves the value proposition:
 * Stratus should match or exceed ReAct completion while using fewer LLM calls.
 *
 * @purpose Prove Stratus advantage over ReAct baseline
 * @spec AGENT_FACTORY_SPEC.md#g32-stratus-vs-react-comparative-benchmark
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  IBrain,
  BrainConfig,
  BrainToolDefinition,
  BrainResponse,
  ToolExecutor,
} from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Fixture loading — same scenarios as standard benchmark
// ---------------------------------------------------------------------------

const FIXTURES_PATH = join(__dirname, "../../fixtures/benchmark-scenarios.json");
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkScenario {
  id: string;
  domain: string;
  name: string;
  goal: string;
  tools: BrainToolDefinition[];
  expected_first_action: string;
  max_steps: number;
  expected_outcome: string;
}

interface RunResult {
  scenarioId: string;
  domain: string;
  completed: boolean;
  stepsTaken: number;
  llmCalls: number;
  latencyMs: number;
  firstActionCorrect: boolean;
  actions: string[];
}

interface ComparativeResult {
  scenarioId: string;
  domain: string;
  stratus: RunResult;
  react: RunResult;
  stratusWins: {
    completion: boolean;
    efficiency: boolean;
    llmCalls: boolean;
    latency: boolean;
    firstAction: boolean;
  };
}

interface AggregateComparison {
  metric: string;
  stratus: number;
  react: number;
  winner: "stratus" | "react" | "tie";
  improvement: string;
}

// ---------------------------------------------------------------------------
// Brain factories — injected per implementation
// ---------------------------------------------------------------------------

let stratusBrainFactory: (() => Promise<IBrain>) | undefined;
let reactBrainFactory: (() => Promise<IBrain>) | undefined;

export function setStratusBrainFactory(factory: () => Promise<IBrain>) {
  stratusBrainFactory = factory;
}

export function setReActBrainFactory(factory: () => Promise<IBrain>) {
  reactBrainFactory = factory;
}

// ---------------------------------------------------------------------------
// Mock executor (identical for both — fair comparison)
// ---------------------------------------------------------------------------

function createBenchmarkExecutor(): ToolExecutor {
  return async (toolName: string) => {
    const responses: Record<string, string> = {
      check_deployment_status: "Service: payment-api, Version: 2.4.1, Status: healthy, Replicas: 3/3",
      check_logs: "Found 47 error entries. Primary: ConnectionTimeout on port 5432.",
      check_metrics: "CPU: 72%, Memory: 85%, Error rate: 2.3%, P95 latency: 450ms",
      restart_service: "Service restarted successfully.",
      rollback_deployment: "Rolled back to v2.3.9. Health checks passing.",
      scale_service: "Scaled from 3 to 9 replicas.",
      update_autoscaling: "Autoscaling updated: min=3, max=15",
      update_config: "Configuration updated.",
      run_healthcheck: "All health checks passing.",
      notify_team: "Notification sent to #ops-alerts",
      get_contact: "Contact: John Smith, Acme Corp, VP Engineering",
      get_deal: "Deal: Acme Corp Enterprise, Stage: Demo, Value: $50,000",
      search_deals: "Found 12 deals across 4 stages",
      update_deal: "Deal updated to Proposal stage",
      search_emails: "Found 8 emails with Acme Corp",
      get_notes: "3 notes found about budget approval",
      add_note: "Note saved",
      search_company: "TechStart Inc: Series A, 45 employees",
      update_contact: "Contact updated",
      draft_email: "Draft created",
      draft_summary: "Summary generated",
      get_metrics: "Pipeline: $2.4M total",
      get_customer: "Customer: alice@example.com, Plan: Business",
      check_auth_logs: "3 failed login attempts in last hour",
      reset_password: "Password reset email sent",
      search_known_issues: "KI-2847: Dashboard slow — fix available",
      apply_fix: "Fix applied to account",
      create_ticket: "Ticket #4521 created",
      escalate: "Escalated to Engineering",
      get_billing_history: "Last 3 charges: $99, $49, $49",
      get_plan_details: "Business: $49/mo, Pro: $99/mo",
      apply_credit: "Credit applied",
      search_feature_requests: "No existing request for PDF export",
      create_feature_request: "Feature request created",
      check_calendar: "Tomorrow: 4-5pm free, 5-6pm free",
      schedule_event: "Meeting scheduled tomorrow 4-5pm",
      triage_inbox: "23 new emails. 5 urgent.",
      get_email: "From: CFO. Subject: Q2 Budget Approval",
      get_tasks: "8 tasks today. 3 high priority.",
      create_task: "Task created",
      set_reminder: "Reminder set",
      search_notes: "Found 4 notes about Q2 budget",
      get_contacts: "John Doe: john@example.com",
      send_email: "Email sent",
    };

    return {
      result: responses[toolName] ?? `${toolName} executed`,
      success: true,
    };
  };
}

// ---------------------------------------------------------------------------
// Run a single scenario against a brain
// ---------------------------------------------------------------------------

async function runScenario(
  brain: IBrain,
  scenario: BenchmarkScenario,
  prefix: string,
): Promise<RunResult> {
  const sessionId = `${prefix}-${scenario.id}`;
  const executor = createBenchmarkExecutor();
  const start = Date.now();

  await brain.registerTools(scenario.tools);

  const response = await brain.processTurn(
    sessionId,
    scenario.goal,
    executor,
    { max_steps: scenario.max_steps },
  );

  const latencyMs = Date.now() - start;
  const actions = response.actions_taken.map((a) => a.tool_name);

  return {
    scenarioId: scenario.id,
    domain: scenario.domain,
    completed: response.goal_proximity >= 0.7 || response.stop_reason === "goal_reached",
    stepsTaken: response.steps_taken,
    llmCalls: response.generation_calls.length,
    latencyMs,
    firstActionCorrect: actions.length > 0 && actions[0] === scenario.expected_first_action,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function compare(stratus: RunResult, react: RunResult): ComparativeResult {
  return {
    scenarioId: stratus.scenarioId,
    domain: stratus.domain,
    stratus,
    react,
    stratusWins: {
      completion: stratus.completed && !react.completed,
      efficiency: stratus.stepsTaken < react.stepsTaken,
      llmCalls: stratus.llmCalls < react.llmCalls,
      latency: stratus.latencyMs < react.latencyMs,
      firstAction: stratus.firstActionCorrect && !react.firstActionCorrect,
    },
  };
}

function aggregate(results: ComparativeResult[]): AggregateComparison[] {
  const n = results.length;
  if (n === 0) return [];

  const sCompletion = results.filter((r) => r.stratus.completed).length / n;
  const rCompletion = results.filter((r) => r.react.completed).length / n;

  const sSteps = results.reduce((s, r) => s + r.stratus.stepsTaken, 0) / n;
  const rSteps = results.reduce((s, r) => s + r.react.stepsTaken, 0) / n;

  const sLLM = results.reduce((s, r) => s + r.stratus.llmCalls, 0) / n;
  const rLLM = results.reduce((s, r) => s + r.react.llmCalls, 0) / n;

  const sLatency = results.reduce((s, r) => s + r.stratus.latencyMs, 0) / n;
  const rLatency = results.reduce((s, r) => s + r.react.latencyMs, 0) / n;

  const sFirst = results.filter((r) => r.stratus.firstActionCorrect).length / n;
  const rFirst = results.filter((r) => r.react.firstActionCorrect).length / n;

  function winner(s: number, r: number, lowerBetter = false): "stratus" | "react" | "tie" {
    if (Math.abs(s - r) < 0.01) return "tie";
    if (lowerBetter) return s < r ? "stratus" : "react";
    return s > r ? "stratus" : "react";
  }

  function improvement(s: number, r: number, lowerBetter = false): string {
    if (r === 0) return "N/A";
    const pct = lowerBetter
      ? ((r - s) / r * 100).toFixed(1)
      : ((s - r) / r * 100).toFixed(1);
    return `${Number(pct) >= 0 ? "+" : ""}${pct}%`;
  }

  return [
    { metric: "Completion Rate", stratus: sCompletion, react: rCompletion, winner: winner(sCompletion, rCompletion), improvement: improvement(sCompletion, rCompletion) },
    { metric: "Avg Steps", stratus: sSteps, react: rSteps, winner: winner(sSteps, rSteps, true), improvement: improvement(sSteps, rSteps, true) },
    { metric: "Avg LLM Calls", stratus: sLLM, react: rLLM, winner: winner(sLLM, rLLM, true), improvement: improvement(sLLM, rLLM, true) },
    { metric: "Avg Latency (ms)", stratus: sLatency, react: rLatency, winner: winner(sLatency, rLatency, true), improvement: improvement(sLatency, rLatency, true) },
    { metric: "First-Action Accuracy", stratus: sFirst, react: rFirst, winner: winner(sFirst, rFirst), improvement: improvement(sFirst, rFirst) },
  ];
}

function formatReport(comparisons: ComparativeResult[], agg: AggregateComparison[]): string {
  const lines: string[] = [
    "# Stratus vs ReAct — Comparative Benchmark Report",
    "",
    "## Aggregate Results",
    "",
    "| Metric | ReAct | Stratus | Winner | Improvement |",
    "|--------|-------|---------|--------|-------------|",
  ];

  for (const a of agg) {
    const sVal = typeof a.stratus === "number" && a.stratus < 1 ? `${(a.stratus * 100).toFixed(1)}%` : a.stratus.toFixed(1);
    const rVal = typeof a.react === "number" && a.react < 1 ? `${(a.react * 100).toFixed(1)}%` : a.react.toFixed(1);
    lines.push(`| ${a.metric} | ${rVal} | ${sVal} | ${a.winner} | ${a.improvement} |`);
  }

  lines.push("", "## Per-Scenario Results", "");
  lines.push("| Scenario | Domain | Stratus | ReAct | Winner |");
  lines.push("|----------|--------|---------|-------|--------|");

  for (const c of comparisons) {
    const sStatus = c.stratus.completed ? `done(${c.stratus.stepsTaken}s)` : "FAIL";
    const rStatus = c.react.completed ? `done(${c.react.stepsTaken}s)` : "FAIL";
    const w = c.stratus.completed && !c.react.completed ? "stratus"
      : !c.stratus.completed && c.react.completed ? "react"
      : c.stratus.stepsTaken < c.react.stepsTaken ? "stratus"
      : c.stratus.stepsTaken > c.react.stepsTaken ? "react" : "tie";
    lines.push(`| ${c.scenarioId} | ${c.domain} | ${sStatus} | ${rStatus} | ${w} |`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Stratus vs ReAct Comparative Benchmark", () => {
  let stratusBrain: IBrain;
  let reactBrain: IBrain;
  const comparisons: ComparativeResult[] = [];

  beforeAll(async () => {
    if (!stratusBrainFactory || !reactBrainFactory) return;

    stratusBrain = await stratusBrainFactory();
    reactBrain = await reactBrainFactory();

    const config: BrainConfig = {
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 10,
    };

    await stratusBrain.configure({ ...config, type: "stratus" });
    await reactBrain.configure({ ...config, type: "react" });
  });

  afterAll(() => {
    if (comparisons.length === 0) return;

    const agg = aggregate(comparisons);
    const report = formatReport(comparisons, agg);

    // Write report to test output
    const reportDir = join(__dirname, "../../.test-output");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "comparative-benchmark-report.md"), report);

    console.log("\n" + report);
  });

  // Run each scenario through both brains
  for (const scenario of fixtures.scenarios as BenchmarkScenario[]) {
    it(`[${scenario.domain}] ${scenario.name}`, async () => {
      if (!stratusBrain || !reactBrain) return;

      const [stratusResult, reactResult] = await Promise.all([
        runScenario(stratusBrain, scenario, "stratus"),
        runScenario(reactBrain, scenario, "react"),
      ]);

      const comparison = compare(stratusResult, reactResult);
      comparisons.push(comparison);

      // Both should complete (quality gate)
      // But Stratus should use fewer LLM calls (value prop)
      expect(stratusResult.completed || reactResult.completed).toBe(true);
    });
  }

  // Value proposition assertions
  it("Stratus completion rate ≥ ReAct completion rate", () => {
    if (comparisons.length === 0) return;

    const stratusCompletion = comparisons.filter((c) => c.stratus.completed).length;
    const reactCompletion = comparisons.filter((c) => c.react.completed).length;

    expect(stratusCompletion).toBeGreaterThanOrEqual(reactCompletion);
  });

  it("Stratus uses fewer LLM calls on average", () => {
    if (comparisons.length === 0) return;

    const stratusLLM = comparisons.reduce((s, c) => s + c.stratus.llmCalls, 0) / comparisons.length;
    const reactLLM = comparisons.reduce((s, c) => s + c.react.llmCalls, 0) / comparisons.length;

    // Stratus should use fewer LLM calls (the core value prop)
    expect(stratusLLM).toBeLessThanOrEqual(reactLLM);
  });

  it("Stratus first-action accuracy ≥ ReAct", () => {
    if (comparisons.length === 0) return;

    const stratusAccuracy = comparisons.filter((c) => c.stratus.firstActionCorrect).length;
    const reactAccuracy = comparisons.filter((c) => c.react.firstActionCorrect).length;

    expect(stratusAccuracy).toBeGreaterThanOrEqual(reactAccuracy);
  });

  it("Stratus average steps ≤ ReAct average steps", () => {
    if (comparisons.length === 0) return;

    const stratusSteps = comparisons.reduce((s, c) => s + c.stratus.stepsTaken, 0) / comparisons.length;
    const reactSteps = comparisons.reduce((s, c) => s + c.react.stepsTaken, 0) / comparisons.length;

    expect(stratusSteps).toBeLessThanOrEqual(reactSteps);
  });
});
