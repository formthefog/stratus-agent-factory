/**
 * Multi-Agent Coordination Tests
 *
 * Tests two agents collaborating on a task, agent-to-agent communication
 * via session tools, and shared sidecar performance under load.
 *
 * @purpose Verify multi-agent coordination and shared resource handling
 * @spec AGENT_FACTORY_SPEC.md#g33-multi-agent-coordination-tests
 */

import { describe, it, expect, beforeAll } from "vitest";

import type { IBrain, BrainToolDefinition, ToolExecutor } from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Brain factory — injected
// ---------------------------------------------------------------------------

let brainFactory: (() => Promise<IBrain>) | undefined;

export function setBrainFactory(factory: () => Promise<IBrain>) {
  brainFactory = factory;
}

// ---------------------------------------------------------------------------
// Shared message bus for agent-to-agent communication
// ---------------------------------------------------------------------------

class AgentMessageBus {
  private channels = new Map<string, string[]>();

  send(channel: string, message: string): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, []);
    }
    this.channels.get(channel)!.push(message);
  }

  receive(channel: string): string[] {
    return this.channels.get(channel) ?? [];
  }

  clear(): void {
    this.channels.clear();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Multi-Agent Coordination", () => {
  let brain1: IBrain;
  let brain2: IBrain;
  const bus = new AgentMessageBus();

  beforeAll(async () => {
    if (!brainFactory) return;

    brain1 = await brainFactory();
    brain2 = await brainFactory();

    await brain1.configure({
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 5,
    });
    await brain2.configure({
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 5,
    });
  });

  describe("Agent-to-Agent Communication", () => {
    it("agents can exchange messages via shared channel", async () => {
      if (!brain1 || !brain2) return;

      // Agent 1 tools include "send_to_agent" and "receive_from_agent"
      const agent1Tools: BrainToolDefinition[] = [
        { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar. effects: returns free slots" },
        { id: "send_to_agent", rich_description: "send_to_agent (coordination). Send message to another agent. effects: message delivered" },
      ];

      const agent2Tools: BrainToolDefinition[] = [
        { id: "schedule_event", rich_description: "schedule_event (assistant). Schedule event. effects: event created" },
        { id: "receive_from_agent", rich_description: "receive_from_agent (coordination). Receive messages from another agent. effects: returns messages" },
      ];

      await brain1.registerTools(agent1Tools);
      await brain2.registerTools(agent2Tools);

      // Agent 1 checks calendar and sends availability
      const executor1: ToolExecutor = async (toolName) => {
        if (toolName === "check_calendar") {
          return { result: "3pm-4pm free, 5pm-6pm free", success: true };
        }
        if (toolName === "send_to_agent") {
          bus.send("scheduling", "Available slots: 3pm-4pm, 5pm-6pm");
          return { result: "Message sent to scheduling agent", success: true };
        }
        return { result: "Unknown tool", success: false };
      };

      const response1 = await brain1.processTurn(
        "agent1-session",
        "Check calendar and send free slots to the scheduling agent",
        executor1,
      );

      expect(response1.actions_taken.length).toBeGreaterThan(0);

      // Agent 2 receives and schedules
      const executor2: ToolExecutor = async (toolName) => {
        if (toolName === "receive_from_agent") {
          const msgs = bus.receive("scheduling");
          return { result: msgs.join("\n") || "No messages", success: true };
        }
        if (toolName === "schedule_event") {
          return { result: "Meeting scheduled for 3pm", success: true };
        }
        return { result: "Unknown tool", success: false };
      };

      const response2 = await brain2.processTurn(
        "agent2-session",
        "Check for scheduling messages and book the first available slot",
        executor2,
      );

      expect(response2.actions_taken.length).toBeGreaterThan(0);

      // Verify the message was transmitted
      const messages = bus.receive("scheduling");
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toContain("3pm");
    });
  });

  describe("Concurrent Execution", () => {
    it("two agents process turns concurrently without interference", async () => {
      if (!brain1 || !brain2) return;

      const tools: BrainToolDefinition[] = [
        { id: "check_status", rich_description: "check_status (devops). Check status. effects: returns status" },
      ];

      await brain1.registerTools(tools);
      await brain2.registerTools(tools);

      const executor: ToolExecutor = async () => ({
        result: "Status: healthy",
        success: true,
      });

      // Run both concurrently
      const [r1, r2] = await Promise.all([
        brain1.processTurn("concurrent-1", "Check system status", executor),
        brain2.processTurn("concurrent-2", "Check system status", executor),
      ]);

      // Both should complete independently
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r1.actions_taken.length).toBeGreaterThan(0);
      expect(r2.actions_taken.length).toBeGreaterThan(0);
    });

    it("agents maintain separate session state", async () => {
      if (!brain1 || !brain2) return;

      const tools: BrainToolDefinition[] = [
        { id: "do_work", rich_description: "do_work (general). Do work. effects: work done" },
      ];

      await brain1.registerTools(tools);
      await brain2.registerTools(tools);

      const executor: ToolExecutor = async () => ({
        result: "Work completed",
        success: true,
      });

      await brain1.processTurn("isolated-1", "Do task A", executor);
      await brain2.processTurn("isolated-2", "Do task B", executor);

      const state1 = await brain1.getState("isolated-1");
      const state2 = await brain2.getState("isolated-2");

      // States should be independent
      expect(state1.turns_completed).toBeGreaterThanOrEqual(1);
      expect(state2.turns_completed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Shared Sidecar Under Load", () => {
    it("handles parallel encoding requests from multiple agents", async () => {
      // This test hits the sidecar directly to verify it handles load
      const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://127.0.0.1:7900";

      let available = false;
      try {
        const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
        available = res.ok;
      } catch {
        // Sidecar not available
      }

      if (!available) return;

      // Simulate 5 concurrent encoding requests (from multiple agents)
      const texts = [
        "[GOAL] Schedule meeting",
        "[GOAL] Deploy service",
        "[GOAL] Check support ticket",
        "[GOAL] Update CRM record",
        "[GOAL] Triage inbox",
      ];

      const requests = texts.map((text) =>
        fetch(`${SIDECAR_URL}/encode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, encode_type: "state" }),
        }),
      );

      const responses = await Promise.all(requests);

      // All should succeed
      for (const res of responses) {
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body.embedding.length).toBe(768);
      }
    });
  });

  describe("Handoff Pattern", () => {
    it("agent can hand off task to another agent with context", async () => {
      if (!brain1 || !brain2) return;

      // Agent 1: Research agent
      const researchTools: BrainToolDefinition[] = [
        { id: "search_knowledge_base", rich_description: "search_knowledge_base (research). Search for info. effects: returns results" },
        { id: "hand_off", rich_description: "hand_off (coordination). Hand off to action agent with context. effects: task transferred" },
      ];

      // Agent 2: Action agent
      const actionTools: BrainToolDefinition[] = [
        { id: "receive_handoff", rich_description: "receive_handoff (coordination). Receive handed-off task. effects: returns task and context" },
        { id: "apply_fix", rich_description: "apply_fix (support). Apply fix. effects: fix applied" },
      ];

      await brain1.registerTools(researchTools);
      await brain2.registerTools(actionTools);

      // Agent 1 researches and hands off
      const executor1: ToolExecutor = async (toolName) => {
        if (toolName === "search_knowledge_base") {
          return { result: "Found: KI-2847 — apply index rebuild to fix slow dashboard", success: true };
        }
        if (toolName === "hand_off") {
          bus.send("handoff", "Task: Apply fix KI-2847. Context: Dashboard slow, need index rebuild.");
          return { result: "Handed off to action agent", success: true };
        }
        return { result: "Unknown", success: false };
      };

      await brain1.processTurn("handoff-research", "Research the dashboard issue and hand off the fix", executor1);

      // Verify handoff message exists
      const handoffs = bus.receive("handoff");
      expect(handoffs.length).toBeGreaterThan(0);
      expect(handoffs[0]).toContain("KI-2847");

      // Agent 2 picks up and acts
      const executor2: ToolExecutor = async (toolName) => {
        if (toolName === "receive_handoff") {
          const msgs = bus.receive("handoff");
          return { result: msgs[0] || "No handoff", success: true };
        }
        if (toolName === "apply_fix") {
          return { result: "Index rebuilt. Dashboard performance restored.", success: true };
        }
        return { result: "Unknown", success: false };
      };

      const response2 = await brain2.processTurn(
        "handoff-action",
        "Pick up the handoff and apply the fix",
        executor2,
      );

      expect(response2.actions_taken.length).toBeGreaterThan(0);
    });
  });
});
