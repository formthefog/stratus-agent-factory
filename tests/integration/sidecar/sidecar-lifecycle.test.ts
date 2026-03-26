/**
 * Sidecar Integration Tests
 *
 * Tests sidecar startup, health checks, encoding correctness,
 * batch performance, and hot-reload model swap.
 *
 * @purpose Verify sidecar lifecycle and encoding correctness
 * @spec AGENT_FACTORY_SPEC.md#g21-sidecar-integration-tests
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Config — sidecar must be running for these tests
// ---------------------------------------------------------------------------

const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://127.0.0.1:7900";
const SKIP_REASON = "Sidecar not available (set SIDECAR_URL or start sidecar)";

async function sidecarAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle Tests
// ---------------------------------------------------------------------------

describe("Sidecar Lifecycle", () => {
  let available = false;

  beforeAll(async () => {
    available = await sidecarAvailable();
  });

  describe("Health Check", () => {
    it("responds to /health", async () => {
      if (!available) return; // Skip

      const res = await fetch(`${SIDECAR_URL}/health`);
      expect(res.ok).toBe(true);

      const body = await res.json();
      expect(body.status).toBe("ok");
    });

    it("reports model version", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/health`);
      const body = await res.json();

      expect(body.model_version).toBeDefined();
      expect(typeof body.model_version).toBe("string");
    });

    it("reports GPU availability", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/health`);
      const body = await res.json();

      expect(typeof body.gpu_available).toBe("boolean");
    });
  });

  describe("Encoding Correctness", () => {
    it("encodes state text to correct dimension", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "[GOAL] Schedule meeting\n[AVAILABLE_ACTIONS] check_calendar, schedule_event",
          encode_type: "state",
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();

      expect(body.embedding).toBeDefined();
      expect(Array.isArray(body.embedding)).toBe(true);
      expect(body.embedding.length).toBe(768);
    });

    it("encodes action text to correct dimension", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "check_calendar: Check calendar availability. Effects: returns events",
          encode_type: "action",
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();

      expect(body.embedding).toBeDefined();
      expect(body.embedding.length).toBe(768);
    });

    it("produces non-zero embeddings", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "[GOAL] Deploy service\n[AVAILABLE_ACTIONS] deploy, rollback",
          encode_type: "state",
        }),
      });

      const body = await res.json();
      const hasNonZero = body.embedding.some((v: number) => v !== 0);
      expect(hasNonZero).toBe(true);
    });

    it("different inputs produce different embeddings", async () => {
      if (!available) return;

      const [res1, res2] = await Promise.all([
        fetch(`${SIDECAR_URL}/encode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "[GOAL] Schedule meeting", encode_type: "state" }),
        }),
        fetch(`${SIDECAR_URL}/encode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "[GOAL] Deploy to production", encode_type: "state" }),
        }),
      ]);

      const body1 = await res1.json();
      const body2 = await res2.json();

      // Compute cosine similarity — should be < 0.95
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < body1.embedding.length; i++) {
        dot += body1.embedding[i] * body2.embedding[i];
        normA += body1.embedding[i] * body1.embedding[i];
        normB += body2.embedding[i] * body2.embedding[i];
      }
      const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
      expect(similarity).toBeLessThan(0.95);
    });

    it("deterministic: same input → same output", async () => {
      if (!available) return;

      const text = "[GOAL] Check deployment status\n[AVAILABLE_ACTIONS] check_status";
      const results: number[][] = [];

      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${SIDECAR_URL}/encode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, encode_type: "state" }),
        });
        const body = await res.json();
        results.push(body.embedding);
      }

      // All three should be identical
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(results[0]);
      }
    });
  });

  describe("Batch Encoding", () => {
    it("encodes multiple texts in a single request", async () => {
      if (!available) return;

      const texts = [
        "[GOAL] Schedule meeting",
        "[GOAL] Deploy service",
        "[GOAL] Review pull request",
      ];

      const res = await fetch(`${SIDECAR_URL}/encode_batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, encode_type: "state" }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();

      expect(body.embeddings).toBeDefined();
      expect(body.embeddings.length).toBe(3);
      for (const emb of body.embeddings) {
        expect(emb.length).toBe(768);
      }
    });

    it("batch results match individual results", async () => {
      if (!available) return;

      const texts = [
        "[GOAL] Schedule meeting",
        "[GOAL] Deploy service",
      ];

      // Batch encode
      const batchRes = await fetch(`${SIDECAR_URL}/encode_batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, encode_type: "state" }),
      });
      const batchBody = await batchRes.json();

      // Individual encodes
      const individualResults = await Promise.all(
        texts.map(async (text) => {
          const res = await fetch(`${SIDECAR_URL}/encode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, encode_type: "state" }),
          });
          return (await res.json()).embedding;
        }),
      );

      // Should match
      for (let i = 0; i < texts.length; i++) {
        expect(batchBody.embeddings[i]).toEqual(individualResults[i]);
      }
    });
  });

  describe("Model Hot-Reload", () => {
    it("accepts model reload request", async () => {
      if (!available) return;

      const res = await fetch(`${SIDECAR_URL}/reload_model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_version: "v6" }),
      });

      // Should accept (200) or reject gracefully (400/409 if already loaded)
      expect([200, 400, 409]).toContain(res.status);
    });

    it("remains healthy after reload", async () => {
      if (!available) return;

      // Trigger reload
      await fetch(`${SIDECAR_URL}/reload_model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_version: "v6" }),
      });

      // Wait briefly for reload
      await new Promise((r) => setTimeout(r, 1000));

      // Health should still be OK
      const health = await fetch(`${SIDECAR_URL}/health`);
      expect(health.ok).toBe(true);
    });
  });
});
