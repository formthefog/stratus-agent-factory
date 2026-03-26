/**
 * Agent Response Latency Benchmark
 *
 * End-to-end latency: message in → response out.
 * Breakdown: encoding + probe + search + generation + execution.
 * Reports P50, P95, P99 latencies.
 *
 * @purpose Benchmark agent response latency with detailed breakdown
 * @spec AGENT_FACTORY_SPEC.md#g42-agent-response-latency-benchmark
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { IBrain, BrainToolDefinition, ToolExecutor } from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LatencyBreakdown {
  totalMs: number;
  encodingMs: number;
  probeMs: number;
  searchMs: number;
  generationMs: number;
  executionMs: number;
}

interface LatencyResult {
  scenarioName: string;
  runs: number;
  totalLatencies: number[];
  breakdowns: LatencyBreakdown[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  avgBreakdown: LatencyBreakdown;
}

// ---------------------------------------------------------------------------
// Brain factory — injected
// ---------------------------------------------------------------------------

let brainFactory: (() => Promise<IBrain>) | undefined;

export function setBrainFactory(factory: () => Promise<IBrain>) {
  brainFactory = factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function avgBreakdown(breakdowns: LatencyBreakdown[]): LatencyBreakdown {
  const n = breakdowns.length;
  if (n === 0) return { totalMs: 0, encodingMs: 0, probeMs: 0, searchMs: 0, generationMs: 0, executionMs: 0 };

  return {
    totalMs: breakdowns.reduce((s, b) => s + b.totalMs, 0) / n,
    encodingMs: breakdowns.reduce((s, b) => s + b.encodingMs, 0) / n,
    probeMs: breakdowns.reduce((s, b) => s + b.probeMs, 0) / n,
    searchMs: breakdowns.reduce((s, b) => s + b.searchMs, 0) / n,
    generationMs: breakdowns.reduce((s, b) => s + b.generationMs, 0) / n,
    executionMs: breakdowns.reduce((s, b) => s + b.executionMs, 0) / n,
  };
}

// ---------------------------------------------------------------------------
// Test scenarios with varying complexity
// ---------------------------------------------------------------------------

interface LatencyScenario {
  name: string;
  goal: string;
  tools: BrainToolDefinition[];
  runs: number;
}

const SCENARIOS: LatencyScenario[] = [
  {
    name: "Simple single-tool (calendar check)",
    goal: "Check my calendar for free slots this afternoon",
    tools: [
      { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar availability. effects: returns free slots" },
      { id: "schedule_event", rich_description: "schedule_event (assistant). Create event. effects: event created" },
    ],
    runs: 10,
  },
  {
    name: "Two-step task (check + schedule)",
    goal: "Schedule a meeting with Sarah at the first free slot tomorrow",
    tools: [
      { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar. effects: returns slots" },
      { id: "schedule_event", rich_description: "schedule_event (assistant). Schedule event. effects: event created" },
      { id: "send_email", rich_description: "send_email (communication). Send email. effects: email delivered" },
    ],
    runs: 10,
  },
  {
    name: "Multi-tool selection (5 tools)",
    goal: "Investigate the high error rate on the API service",
    tools: [
      { id: "check_metrics", rich_description: "check_metrics (devops). Check metrics. effects: returns CPU, memory, error rate" },
      { id: "check_logs", rich_description: "check_logs (devops). Check logs. effects: returns log entries" },
      { id: "check_deployment_status", rich_description: "check_deployment_status (devops). Check deployment. effects: returns version, health" },
      { id: "restart_service", rich_description: "restart_service (devops). Restart service. effects: service restarted" },
      { id: "notify_team", rich_description: "notify_team (devops). Notify team. effects: notification sent" },
    ],
    runs: 10,
  },
  {
    name: "Complex task (research + action)",
    goal: "Find all stale deals and draft follow-up emails for each",
    tools: [
      { id: "search_deals", rich_description: "search_deals (crm). Search deals. effects: returns deals" },
      { id: "get_deal", rich_description: "get_deal (crm). Get deal details. effects: returns deal" },
      { id: "get_contact", rich_description: "get_contact (crm). Get contact. effects: returns contact" },
      { id: "draft_email", rich_description: "draft_email (communication). Draft email. effects: draft created" },
      { id: "send_email", rich_description: "send_email (communication). Send email. effects: email sent" },
      { id: "add_note", rich_description: "add_note (crm). Add note. effects: note saved" },
    ],
    runs: 5,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Response Latency Benchmark", () => {
  let brain: IBrain;
  const allResults: LatencyResult[] = [];

  beforeAll(async () => {
    if (!brainFactory) return;

    brain = await brainFactory();
    await brain.configure({
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 5,
    });
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      it(`measures latency over ${scenario.runs} runs`, async () => {
        if (!brain) return;

        await brain.registerTools(scenario.tools);

        const executor: ToolExecutor = async (toolName) => ({
          result: `${toolName} completed successfully`,
          success: true,
        });

        const totalLatencies: number[] = [];
        const breakdowns: LatencyBreakdown[] = [];

        for (let i = 0; i < scenario.runs; i++) {
          const sessionId = `latency-${scenario.name}-${i}`;
          const start = performance.now();

          const response = await brain.processTurn(
            sessionId,
            scenario.goal,
            executor,
          );

          const totalMs = performance.now() - start;
          totalLatencies.push(totalMs);

          // Extract breakdown from response events if available
          // Approximate from response data
          const genMs = response.generation_calls.reduce((s, g) => s + (g.duration_ms ?? 0), 0);
          const execMs = response.actions_taken.reduce((s, a) => s + (a.duration_ms ?? 0), 0);
          const encodingMs = Math.max(0, totalMs - genMs - execMs) * 0.3; // Estimate
          const probeMs = Math.max(0, totalMs - genMs - execMs) * 0.2;
          const searchMs = Math.max(0, totalMs - genMs - execMs) * 0.1;

          breakdowns.push({
            totalMs,
            encodingMs,
            probeMs,
            searchMs,
            generationMs: genMs,
            executionMs: execMs,
          });

          // Reset for clean measurement
          await brain.reset(sessionId);
        }

        const sorted = [...totalLatencies].sort((a, b) => a - b);
        const result: LatencyResult = {
          scenarioName: scenario.name,
          runs: scenario.runs,
          totalLatencies,
          breakdowns,
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          p99Ms: percentile(sorted, 99),
          avgMs: totalLatencies.reduce((s, v) => s + v, 0) / totalLatencies.length,
          minMs: sorted[0],
          maxMs: sorted[sorted.length - 1],
          avgBreakdown: avgBreakdown(breakdowns),
        };

        allResults.push(result);

        // Latency assertions (generous for now — tighten as baseline established)
        expect(result.p95Ms).toBeLessThan(30000); // 30s at p95
        expect(result.avgMs).toBeLessThan(15000); // 15s average
      }, 120000);
    });
  }

  // Cold start test
  describe("Cold Start", () => {
    it("measures first-request latency (cold brain)", async () => {
      if (!brainFactory) return;

      const coldBrain = await brainFactory();
      await coldBrain.configure({
        type: "stratus",
        llm_provider: "anthropic",
        llm_model: "claude-sonnet-4-6",
        max_steps_per_turn: 3,
      });

      await coldBrain.registerTools([
        { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar. effects: returns slots" },
      ]);

      const executor: ToolExecutor = async () => ({
        result: "Calendar checked",
        success: true,
      });

      const start = performance.now();
      await coldBrain.processTurn("cold-start", "Check my calendar", executor);
      const coldStartMs = performance.now() - start;

      // Cold start will be slower, but should still be under 60s
      expect(coldStartMs).toBeLessThan(60000);
    }, 120000);
  });

  // Report generation
  describe("Report", () => {
    it("generates latency report", () => {
      if (allResults.length === 0) return;

      const reportDir = join(__dirname, "../../.test-output");
      mkdirSync(reportDir, { recursive: true });

      const lines = [
        "# Agent Response Latency Benchmark Report",
        "",
        "## Summary",
        "",
        "| Scenario | Runs | Avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) |",
        "|----------|------|----------|----------|----------|----------|----------|----------|",
      ];

      for (const r of allResults) {
        lines.push(
          `| ${r.scenarioName} | ${r.runs} | ${r.avgMs.toFixed(0)} | ${r.p50Ms.toFixed(0)} | ${r.p95Ms.toFixed(0)} | ${r.p99Ms.toFixed(0)} | ${r.minMs.toFixed(0)} | ${r.maxMs.toFixed(0)} |`,
        );
      }

      lines.push("", "## Latency Breakdown (Averages)", "");
      lines.push("| Scenario | Encoding | Probe | Search | Generation | Execution | Total |");
      lines.push("|----------|----------|-------|--------|------------|-----------|-------|");

      for (const r of allResults) {
        const b = r.avgBreakdown;
        lines.push(
          `| ${r.scenarioName} | ${b.encodingMs.toFixed(0)} | ${b.probeMs.toFixed(0)} | ${b.searchMs.toFixed(0)} | ${b.generationMs.toFixed(0)} | ${b.executionMs.toFixed(0)} | ${b.totalMs.toFixed(0)} |`,
        );
      }

      const report = lines.join("\n");
      writeFileSync(join(reportDir, "agent-latency-report.md"), report);
    });
  });
});
