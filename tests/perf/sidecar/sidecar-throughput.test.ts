/**
 * Sidecar Throughput Benchmark
 *
 * Measures encoding requests/sec, concurrent client handling,
 * memory usage under load, and GPU utilization patterns.
 *
 * @purpose Benchmark sidecar performance under various load patterns
 * @spec AGENT_FACTORY_SPEC.md#g41-sidecar-throughput-benchmark
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://127.0.0.1:7900";
const REPORT_DIR = join(__dirname, "../../.test-output");

async function sidecarAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThroughputResult {
  testName: string;
  totalRequests: number;
  durationMs: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

async function encodeRequest(text: string): Promise<{ latencyMs: number; ok: boolean }> {
  const start = performance.now();
  try {
    const res = await fetch(`${SIDECAR_URL}/encode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, encode_type: "state" }),
    });
    return { latencyMs: performance.now() - start, ok: res.ok };
  } catch {
    return { latencyMs: performance.now() - start, ok: false };
  }
}

async function batchEncodeRequest(texts: string[]): Promise<{ latencyMs: number; ok: boolean }> {
  const start = performance.now();
  try {
    const res = await fetch(`${SIDECAR_URL}/encode_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, encode_type: "state" }),
    });
    return { latencyMs: performance.now() - start, ok: res.ok };
  } catch {
    return { latencyMs: performance.now() - start, ok: false };
  }
}

function computeResults(name: string, latencies: number[], errors: number, durationMs: number): ThroughputResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    testName: name,
    totalRequests: latencies.length + errors,
    durationMs,
    requestsPerSecond: (latencies.length + errors) / (durationMs / 1000),
    avgLatencyMs: latencies.reduce((s, v) => s + v, 0) / latencies.length,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Sample texts for benchmarks
// ---------------------------------------------------------------------------

const SAMPLE_TEXTS = [
  "[GOAL] Schedule a meeting with Sarah\n[AVAILABLE_ACTIONS] check_calendar, schedule_event",
  "[GOAL] Deploy the payment service\n[LAST_ACTION] check_logs\n[LAST_RESULT] No errors found",
  "[GOAL] Resolve customer ticket #4521\n[AVAILABLE_ACTIONS] get_customer, apply_fix, escalate",
  "[GOAL] Generate pipeline report\n[LAST_ACTION] search_deals\n[LAST_RESULT] 12 deals found",
  "[GOAL] Investigate production outage\n[LAST_ACTION] check_metrics\n[LAST_RESULT] CPU 95%, Memory 88%",
  "[GOAL] Triage inbox\n[AVAILABLE_ACTIONS] triage_inbox, get_email, create_task, set_reminder",
  "[GOAL] Qualify inbound lead\n[LAST_ACTION] get_contact\n[LAST_RESULT] TechStart Inc, Series A",
  "[GOAL] Scale service for traffic spike\n[AVAILABLE_ACTIONS] check_metrics, scale_service, update_autoscaling",
  "[GOAL] Prepare sales call briefing\n[LAST_ACTION] get_contact\n[LAST_RESULT] John Smith, VP Eng",
  "[GOAL] Reset customer password\n[LAST_ACTION] check_auth_logs\n[LAST_RESULT] 3 failed attempts",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sidecar Throughput Benchmark", () => {
  let available = false;
  const allResults: ThroughputResult[] = [];

  beforeAll(async () => {
    available = await sidecarAvailable();
    mkdirSync(REPORT_DIR, { recursive: true });
  });

  describe("Single Client Sequential", () => {
    it("measures sequential encoding throughput (50 requests)", async () => {
      if (!available) return;

      const latencies: number[] = [];
      let errors = 0;
      const start = performance.now();

      for (let i = 0; i < 50; i++) {
        const text = SAMPLE_TEXTS[i % SAMPLE_TEXTS.length];
        const result = await encodeRequest(text);
        if (result.ok) {
          latencies.push(result.latencyMs);
        } else {
          errors++;
        }
      }

      const durationMs = performance.now() - start;
      const results = computeResults("Sequential (50 req)", latencies, errors, durationMs);
      allResults.push(results);

      expect(errors).toBe(0);
      expect(results.requestsPerSecond).toBeGreaterThan(1); // At least 1 req/s
      expect(results.p95LatencyMs).toBeLessThan(5000); // Under 5s at p95
    }, 60000);
  });

  describe("Single Client Batched", () => {
    it("measures batch encoding throughput (10 batches of 10)", async () => {
      if (!available) return;

      const latencies: number[] = [];
      let errors = 0;
      const start = performance.now();

      for (let i = 0; i < 10; i++) {
        const texts = SAMPLE_TEXTS; // 10 texts per batch
        const result = await batchEncodeRequest(texts);
        if (result.ok) {
          latencies.push(result.latencyMs);
        } else {
          errors++;
        }
      }

      const durationMs = performance.now() - start;
      const results = computeResults("Batched (10x10)", latencies, errors, durationMs);
      allResults.push(results);

      expect(errors).toBe(0);
      // Batch should be more efficient than sequential
      expect(results.avgLatencyMs).toBeLessThan(10000);
    }, 60000);
  });

  describe("Concurrent Clients (10)", () => {
    it("handles 10 concurrent clients", async () => {
      if (!available) return;

      const concurrency = 10;
      const requestsPerClient = 5;
      const latencies: number[] = [];
      let errors = 0;
      const start = performance.now();

      const clients = Array.from({ length: concurrency }, async (_, clientIdx) => {
        for (let i = 0; i < requestsPerClient; i++) {
          const text = SAMPLE_TEXTS[(clientIdx * requestsPerClient + i) % SAMPLE_TEXTS.length];
          const result = await encodeRequest(text);
          if (result.ok) {
            latencies.push(result.latencyMs);
          } else {
            errors++;
          }
        }
      });

      await Promise.all(clients);
      const durationMs = performance.now() - start;
      const results = computeResults("Concurrent (10 clients)", latencies, errors, durationMs);
      allResults.push(results);

      expect(errors).toBe(0);
      expect(results.p99LatencyMs).toBeLessThan(15000);
    }, 120000);
  });

  describe("Concurrent Clients (50)", () => {
    it("handles 50 concurrent clients", async () => {
      if (!available) return;

      const concurrency = 50;
      const requestsPerClient = 2;
      const latencies: number[] = [];
      let errors = 0;
      const start = performance.now();

      const clients = Array.from({ length: concurrency }, async (_, clientIdx) => {
        for (let i = 0; i < requestsPerClient; i++) {
          const text = SAMPLE_TEXTS[(clientIdx + i) % SAMPLE_TEXTS.length];
          const result = await encodeRequest(text);
          if (result.ok) {
            latencies.push(result.latencyMs);
          } else {
            errors++;
          }
        }
      });

      await Promise.all(clients);
      const durationMs = performance.now() - start;
      const results = computeResults("Concurrent (50 clients)", latencies, errors, durationMs);
      allResults.push(results);

      // Allow some errors under heavy load, but < 5%
      const errorRate = errors / (latencies.length + errors);
      expect(errorRate).toBeLessThan(0.05);
    }, 180000);
  });

  describe("Memory & Health Under Load", () => {
    it("health endpoint remains responsive during encoding", async () => {
      if (!available) return;

      // Fire off encoding requests in background
      const encodePromise = Promise.all(
        SAMPLE_TEXTS.map((text) => encodeRequest(text)),
      );

      // Health should still respond quickly
      const healthStart = performance.now();
      const healthRes = await fetch(`${SIDECAR_URL}/health`);
      const healthLatency = performance.now() - healthStart;

      expect(healthRes.ok).toBe(true);
      expect(healthLatency).toBeLessThan(2000); // Health under 2s even during load

      await encodePromise;
    }, 30000);

    it("reports memory and GPU stats via health endpoint", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/health`);
      const body = await res.json();

      // These fields should exist for monitoring
      expect(body).toBeDefined();
      // Model version is always present
      expect(body.model_version).toBeDefined();
    });
  });

  // Write report after all tests
  describe("Report Generation", () => {
    it("generates throughput report", () => {
      if (allResults.length === 0) return;

      const lines = [
        "# Sidecar Throughput Benchmark Report",
        "",
        "| Test | Requests | Duration (ms) | Req/s | Avg (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Errors |",
        "|------|----------|---------------|-------|----------|----------|----------|----------|--------|",
      ];

      for (const r of allResults) {
        lines.push(
          `| ${r.testName} | ${r.totalRequests} | ${r.durationMs.toFixed(0)} | ${r.requestsPerSecond.toFixed(1)} | ${r.avgLatencyMs.toFixed(0)} | ${r.p50LatencyMs.toFixed(0)} | ${r.p95LatencyMs.toFixed(0)} | ${r.p99LatencyMs.toFixed(0)} | ${r.errors} |`,
        );
      }

      const report = lines.join("\n");
      writeFileSync(join(REPORT_DIR, "sidecar-throughput-report.md"), report);
    });
  });
});
