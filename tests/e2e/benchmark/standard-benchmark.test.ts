/**
 * Standard Benchmark Suite
 *
 * 20 scenarios across 4 domains (DevOps, Sales, Support, Personal Assistant).
 * Graded on completion, efficiency, first-action accuracy, cost, and latency.
 *
 * @purpose Standard benchmark for agent quality measurement
 * @spec AGENT_FACTORY_SPEC.md#g31-standard-benchmark-suite
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IBrain, BrainToolDefinition, ToolExecutor } from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Fixture loading
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

interface BenchmarkResult {
  scenarioId: string;
  domain: string;
  completed: boolean;
  stepsTaken: number;
  maxSteps: number;
  efficiency: number;
  firstActionCorrect: boolean;
  llmCalls: number;
  latencyMs: number;
  actions: string[];
}

// ---------------------------------------------------------------------------
// Brain factory — injected per implementation
// ---------------------------------------------------------------------------

let brainFactory: (() => Promise<IBrain>) | undefined;

export function setBrainFactory(factory: () => Promise<IBrain>) {
  brainFactory = factory;
}

// ---------------------------------------------------------------------------
// Mock executor that simulates tool responses
// ---------------------------------------------------------------------------

function createBenchmarkExecutor(): ToolExecutor {
  return async (toolName: string, params: Record<string, unknown>) => {
    // Simulate realistic tool responses per domain
    const responses: Record<string, string> = {
      // DevOps
      check_deployment_status: "Service: payment-api, Version: 2.4.1, Status: healthy, Replicas: 3/3",
      check_logs: "Found 47 error entries. Primary: ConnectionTimeout on port 5432. Secondary: slow query > 5s on /api/orders",
      check_metrics: "CPU: 72%, Memory: 85%, Error rate: 2.3%, P95 latency: 450ms, Connections: 48/50",
      restart_service: "Service restarted successfully. New PID: 4521. Health check: passing.",
      rollback_deployment: "Rolled back to v2.3.9. Health check: passing. All replicas healthy.",
      scale_service: "Scaled from 3 to 9 replicas. All healthy.",
      update_autoscaling: "Autoscaling updated: min=3, max=15, target_cpu=60%",
      update_config: "Configuration updated. max_connections: 100 → 200. Restart required.",
      run_healthcheck: "All health checks passing. DB: ok, Cache: ok, API: ok",
      notify_team: "Notification sent to #ops-alerts",

      // Sales
      get_contact: "Contact: John Smith, Company: Acme Corp, Title: VP Engineering, Last contact: 3 days ago, Deal: $50k",
      get_deal: "Deal: Acme Corp Enterprise, Stage: Demo, Value: $50,000, Close date: 2026-04-15, Champion: John Smith",
      search_deals: "Found 12 deals. 3 in Prospecting, 4 in Demo, 3 in Proposal, 2 in Negotiation",
      update_deal: "Deal updated: Stage → Proposal, Last activity: now",
      search_emails: "Found 8 emails with Acme Corp in last 30 days. Latest: RE: Demo follow-up (2 days ago)",
      get_notes: "3 notes found. Latest: 'John mentioned budget approval needed from CFO. Timeline: end of Q1.'",
      add_note: "Note saved to contact record",
      search_company: "TechStart Inc: Series A ($12M), 45 employees, SaaS platform, Founded 2024",
      update_contact: "Contact updated: Status → Qualified",
      draft_email: "Draft created: Subject: 'Following up on our conversation'",
      draft_summary: "Summary generated with key points and action items",
      get_metrics: "Pipeline: $2.4M total. Prospecting: $400k, Demo: $800k, Proposal: $600k, Negotiation: $600k",

      // Support
      get_customer: "Customer: alice@example.com, Plan: Business ($49/mo), Status: Active, Since: 2025-06-15",
      check_auth_logs: "3 failed login attempts in last hour. IP: 192.168.1.1. Last success: 2 days ago.",
      reset_password: "Password reset email sent to alice@example.com",
      search_known_issues: "KI-2847: Dashboard slow loading — fix: rebuild dashboard cache. Status: verified fix available.",
      apply_fix: "Fix KI-2847 applied to account. Dashboard cache rebuilt.",
      create_ticket: "Ticket #4521 created. Priority: Medium. Assigned to: Support Team.",
      escalate: "Escalated to Engineering team with full context. Ticket #4521 updated.",
      get_billing_history: "Last 3 charges: $99 (Mar), $49 (Feb), $49 (Jan). Plan change: Feb 28 upgraded to Pro.",
      get_plan_details: "Business: $49/mo, Pro: $99/mo. Upgrade on Feb 28 prorated.",
      apply_credit: "Credit of $50 applied to account",
      search_feature_requests: "No existing request for 'PDF export'. Related: 'CSV export' (42 votes, planned Q2).",
      create_feature_request: "Feature request created: 'PDF export' — 1 vote. Tagged: reporting.",

      // Personal Assistant
      check_calendar: "Tomorrow 2-3pm: Team standup. 4-5pm: Free. 5-6pm: Free. Rest of afternoon: open.",
      schedule_event: "Meeting scheduled: 'Meeting with Sarah' tomorrow 4-5pm. Calendar updated.",
      triage_inbox: "23 new emails. 5 urgent: [Budget approval, Client escalation, Deploy failure, Board meeting, Hiring update]",
      get_email: "From: CFO. Subject: Q2 Budget Approval. 'Please review and approve the Q2 budget by Friday.'",
      get_tasks: "8 tasks today: [Review PR #234 (high), Update docs (medium), Team 1:1 (high), ...]",
      create_task: "Task created: 'Follow up with John about deadline'",
      set_reminder: "Reminder set for tomorrow 9am",
      search_notes: "Found 4 notes about 'Q2 budget': [Meeting notes 3/15, Budget draft v2, CFO feedback, Final numbers]",
      get_contacts: "John Doe: john@example.com, +1-555-0123, VP Product",
      send_email: "Email sent successfully",
    };

    return {
      result: responses[toolName] ?? `${toolName} executed successfully`,
      success: true,
    };
  };
}

// ---------------------------------------------------------------------------
// Benchmark Runner
// ---------------------------------------------------------------------------

async function runScenario(
  brain: IBrain,
  scenario: BenchmarkScenario,
): Promise<BenchmarkResult> {
  const sessionId = `benchmark-${scenario.id}`;
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
  const firstActionCorrect = actions.length > 0 && actions[0] === scenario.expected_first_action;
  const completed = response.goal_proximity >= 0.7 || response.stop_reason === "goal_reached";
  const stepsTaken = response.steps_taken;

  return {
    scenarioId: scenario.id,
    domain: scenario.domain,
    completed,
    stepsTaken,
    maxSteps: scenario.max_steps,
    efficiency: stepsTaken / scenario.max_steps,
    firstActionCorrect,
    llmCalls: response.generation_calls.length,
    latencyMs,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Standard Benchmark Suite", () => {
  let brain: IBrain;
  const results: BenchmarkResult[] = [];

  beforeAll(async () => {
    if (!brainFactory) return;
    brain = await brainFactory();
    await brain.configure({
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 10,
    });
  });

  // Generate a test for each scenario
  for (const scenario of fixtures.scenarios as BenchmarkScenario[]) {
    it(`[${scenario.domain}] ${scenario.name}`, async () => {
      if (!brain) return;

      const result = await runScenario(brain, scenario);
      results.push(result);

      // Assertions
      expect(result.completed).toBe(true);
      expect(result.firstActionCorrect).toBe(true);
      expect(result.stepsTaken).toBeLessThanOrEqual(scenario.max_steps);
      expect(result.latencyMs).toBeLessThan(30000); // 30s timeout
    });
  }

  // Domain-level aggregation tests
  for (const domain of ["devops", "sales", "support", "personal_assistant"]) {
    it(`[${domain}] ≥80% completion rate`, async () => {
      if (!brain) return;

      const domainResults = results.filter((r) => r.domain === domain);
      if (domainResults.length === 0) return;

      const completionRate = domainResults.filter((r) => r.completed).length / domainResults.length;
      expect(completionRate).toBeGreaterThanOrEqual(0.8);
    });

    it(`[${domain}] ≥60% first-action accuracy`, async () => {
      if (!brain) return;

      const domainResults = results.filter((r) => r.domain === domain);
      if (domainResults.length === 0) return;

      const accuracy = domainResults.filter((r) => r.firstActionCorrect).length / domainResults.length;
      expect(accuracy).toBeGreaterThanOrEqual(0.6);
    });
  }

  // Overall aggregation
  it("overall ≥85% completion rate", async () => {
    if (!brain) return;
    if (results.length === 0) return;

    const completionRate = results.filter((r) => r.completed).length / results.length;
    expect(completionRate).toBeGreaterThanOrEqual(0.85);
  });

  it("overall ≥70% first-action accuracy", async () => {
    if (!brain) return;
    if (results.length === 0) return;

    const accuracy = results.filter((r) => r.firstActionCorrect).length / results.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  });

  it("average efficiency < 0.8 (steps/max_steps)", async () => {
    if (!brain) return;
    if (results.length === 0) return;

    const avgEfficiency = results.reduce((sum, r) => sum + r.efficiency, 0) / results.length;
    expect(avgEfficiency).toBeLessThan(0.8);
  });
});
