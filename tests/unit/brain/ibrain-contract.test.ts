/**
 * IBrain Contract Tests
 *
 * Behavioral assertions against the IBrain interface — any brain implementation
 * must pass these. Test data in JSON fixtures for v2 (pytest) portability.
 *
 * @purpose Verify IBrain contract compliance for any brain implementation
 * @spec AGENT_FACTORY_SPEC.md#g11-brain-interface-tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Import types — tests against interface, not implementation
import type { IBrain, StateSnapshot, ActionRanking } from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_PATH = join(__dirname, "../../fixtures/brain-contract.json");
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Helper: create brain instance under test
// ---------------------------------------------------------------------------

// This factory is swapped per implementation. For StratusBrain, it connects
// to the sidecar. For ReActBrain, it wraps the LLM. The same tests run
// against both — that's the point of the contract.

let brainFactory: () => Promise<IBrain>;

function setBrainFactory(factory: () => Promise<IBrain>) {
  brainFactory = factory;
}

// Export for test runners to inject the implementation
export { setBrainFactory };

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

describe("IBrain Contract", () => {
  let brain: IBrain;

  beforeAll(async () => {
    if (!brainFactory) {
      // Default: skip if no factory set (CI will inject the right one)
      return;
    }
    brain = await brainFactory();
  });

  describe("State Encoding", () => {
    for (const fixture of fixtures.encoding_roundtrip) {
      it(`encodes state: ${fixture.name}`, async () => {
        if (!brain) return; // Skip if no factory

        const snapshot: StateSnapshot = {
          stateText: fixture.state_text,
          goalText: fixture.state_text.match(/\[GOAL\]\s*(.*)/)?.[1] ?? "",
          turnNumber: 1,
          timestamp: Date.now(),
        };

        const encoded = await brain.encodeState(snapshot);

        expect(encoded).toBeDefined();
        expect(encoded.length).toBe(fixture.expected_embedding_dim);

        if (fixture.expected_nonzero) {
          const nonZero = encoded.some((v: number) => v !== 0);
          expect(nonZero).toBe(true);
        }
      });
    }

    it("different states produce different embeddings", async () => {
      if (!brain) return;

      const state1: StateSnapshot = {
        stateText: fixtures.encoding_roundtrip[0].state_text,
        goalText: "Schedule a meeting",
        turnNumber: 1,
        timestamp: Date.now(),
      };

      const state2: StateSnapshot = {
        stateText: fixtures.encoding_roundtrip[2].state_text,
        goalText: "Resolve production outage",
        turnNumber: 1,
        timestamp: Date.now(),
      };

      const emb1 = await brain.encodeState(state1);
      const emb2 = await brain.encodeState(state2);

      // Cosine similarity should be < 0.95 (different states)
      const similarity = cosineSimilarity(emb1, emb2);
      expect(similarity).toBeLessThan(0.95);
    });
  });

  describe("Action Ranking", () => {
    for (const fixture of fixtures.action_ranking) {
      it(`ranks correctly: ${fixture.name}`, async () => {
        if (!brain) return;

        const ranking = await brain.rankActions(
          fixture.state_text,
          fixture.goal_text,
          fixture.tools,
        );

        expect(ranking).toBeDefined();
        expect(ranking.length).toBe(fixture.tools.length);

        // Top-1 should match expected
        expect(ranking[0].toolId).toBe(fixture.expected_top1);

        // Scores should be in descending order
        for (let i = 1; i < ranking.length; i++) {
          expect(ranking[i].score).toBeLessThanOrEqual(ranking[i - 1].score);
        }

        // All scores should be between 0 and 1
        for (const entry of ranking) {
          expect(entry.score).toBeGreaterThanOrEqual(0);
          expect(entry.score).toBeLessThanOrEqual(1);
        }
      });
    }
  });

  describe("Determinism", () => {
    for (const fixture of fixtures.determinism) {
      it(`same input → same output: ${fixture.name}`, async () => {
        if (!brain) return;

        const results: ActionRanking[][] = [];

        for (let i = 0; i < fixture.runs; i++) {
          const ranking = await brain.rankActions(
            fixture.state_text,
            "Schedule meeting",
            [
              { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar availability. effects: returns events" },
              { id: "schedule_event", rich_description: "schedule_event (assistant). Create a calendar event. effects: event created" },
            ],
          );
          results.push(ranking);
        }

        // All runs should produce identical rankings
        for (let i = 1; i < results.length; i++) {
          expect(results[i].map((r) => r.toolId)).toEqual(
            results[0].map((r) => r.toolId),
          );
        }
      });
    }
  });

  describe("processTurn", () => {
    it("returns a valid turn result", async () => {
      if (!brain) return;

      const result = await brain.processTurn({
        stateText: "[GOAL] Check calendar\n[AVAILABLE_ACTIONS] check_calendar",
        goalText: "Check calendar",
        turnNumber: 1,
        tools: [
          { id: "check_calendar", rich_description: "check_calendar. Check calendar. effects: returns events" },
        ],
      });

      expect(result).toBeDefined();
      expect(result.selectedAction).toBeDefined();
      expect(result.selectedAction.toolId).toBe("check_calendar");
      expect(typeof result.confidence).toBe("number");
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
