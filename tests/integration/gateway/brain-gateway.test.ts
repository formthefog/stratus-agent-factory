/**
 * Brain-Gateway Integration Tests
 *
 * Tests the full message → brain → response flow,
 * multi-turn conversation handling, and channel-specific formatting.
 *
 * @purpose Verify brain integration with gateway message flow
 * @spec AGENT_FACTORY_SPEC.md#g22-brain-gateway-integration-tests
 */

import { describe, it, expect, beforeAll } from "vitest";

import type {
  IBrain,
  BrainConfig,
  BrainToolDefinition,
  BrainResponse,
  ToolExecutor,
} from "../../../src/brain/index.js";

// ---------------------------------------------------------------------------
// Mock tool executor for integration tests
// ---------------------------------------------------------------------------

function createMockExecutor(responses: Record<string, string>): ToolExecutor {
  return async (toolName: string, params: Record<string, unknown>) => {
    const key = toolName;
    return {
      result: responses[key] ?? `${toolName} executed with ${JSON.stringify(params)}`,
      success: true,
    };
  };
}

// ---------------------------------------------------------------------------
// Brain factory — injected per implementation
// ---------------------------------------------------------------------------

let brainFactory: (() => Promise<IBrain>) | undefined;

export function setBrainFactory(factory: () => Promise<IBrain>) {
  brainFactory = factory;
}

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------

const TEST_TOOLS: BrainToolDefinition[] = [
  {
    id: "check_calendar",
    rich_description: "check_calendar (assistant). Check calendar availability. effects: returns available time slots",
  },
  {
    id: "schedule_event",
    rich_description: "schedule_event (assistant). Create a calendar event. effects: event created and confirmation sent",
  },
  {
    id: "send_email",
    rich_description: "send_email (communication). Send an email to recipients. effects: email delivered",
  },
];

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Brain-Gateway Integration", () => {
  let brain: IBrain;

  beforeAll(async () => {
    if (!brainFactory) return;

    brain = await brainFactory();
    await brain.configure({
      type: "stratus",
      llm_provider: "anthropic",
      llm_model: "claude-sonnet-4-6",
      max_steps_per_turn: 5,
    });
    await brain.registerTools(TEST_TOOLS);
  });

  describe("Message → Brain → Response Flow", () => {
    it("processes a simple message and returns a response", async () => {
      if (!brain) return;

      const executor = createMockExecutor({
        check_calendar: "Calendar checked. 3pm-4pm is free.",
      });

      const response = await brain.processTurn(
        "test-session-1",
        "Check my calendar for this afternoon",
        executor,
      );

      expect(response).toBeDefined();
      expect(response.actions_taken).toBeDefined();
      expect(response.actions_taken.length).toBeGreaterThan(0);
      expect(response.final_response).toBeDefined();
    });

    it("selects appropriate tool for the task", async () => {
      if (!brain) return;

      const executor = createMockExecutor({
        check_calendar: "3pm-4pm free, 5pm-6pm free",
      });

      const response = await brain.processTurn(
        "test-session-2",
        "What time slots do I have free today?",
        executor,
      );

      const toolsUsed = response.actions_taken.map((a) => a.tool_name);
      expect(toolsUsed).toContain("check_calendar");
    });

    it("includes token usage in response", async () => {
      if (!brain) return;

      const executor = createMockExecutor({});
      const response = await brain.processTurn(
        "test-session-3",
        "Check my calendar",
        executor,
      );

      expect(response.total_usage).toBeDefined();
      expect(response.total_usage.total_tokens).toBeGreaterThanOrEqual(0);
    });

    it("includes duration in response", async () => {
      if (!brain) return;

      const executor = createMockExecutor({});
      const response = await brain.processTurn(
        "test-session-4",
        "Check calendar",
        executor,
      );

      expect(typeof response.duration_ms).toBe("number");
      expect(response.duration_ms).toBeGreaterThan(0);
    });

    it("reports goal proximity", async () => {
      if (!brain) return;

      const executor = createMockExecutor({
        check_calendar: "3pm-4pm free",
      });

      const response = await brain.processTurn(
        "test-session-5",
        "Check my calendar",
        executor,
      );

      expect(typeof response.goal_proximity).toBe("number");
      expect(response.goal_proximity).toBeGreaterThanOrEqual(0);
      expect(response.goal_proximity).toBeLessThanOrEqual(1);
    });
  });

  describe("Multi-Turn Conversation", () => {
    it("maintains context across turns", async () => {
      if (!brain) return;

      const sessionId = "test-multi-turn-1";
      const executor = createMockExecutor({
        check_calendar: "3pm-4pm free, 5pm-6pm free",
        schedule_event: "Meeting scheduled for 3pm with Sarah",
      });

      // Turn 1: Check calendar
      const turn1 = await brain.processTurn(
        sessionId,
        "Check my calendar for free slots",
        executor,
      );
      expect(turn1.actions_taken.length).toBeGreaterThan(0);

      // Turn 2: Schedule based on previous result
      const turn2 = await brain.processTurn(
        sessionId,
        "Schedule a meeting with Sarah at the first free slot",
        executor,
      );
      expect(turn2.actions_taken.length).toBeGreaterThan(0);

      // State should show progression
      const state = await brain.getState(sessionId);
      expect(state.turns_completed).toBeGreaterThanOrEqual(2);
    });

    it("goal proximity increases toward completion", async () => {
      if (!brain) return;

      const sessionId = "test-multi-turn-2";
      const executor = createMockExecutor({
        check_calendar: "3pm-4pm free",
        schedule_event: "Event created successfully",
      });

      const turn1 = await brain.processTurn(
        sessionId,
        "Schedule a meeting with Sarah at 3pm",
        executor,
      );

      const turn2 = await brain.processTurn(
        sessionId,
        "Confirm the meeting is scheduled",
        executor,
      );

      // Later turn should have equal or higher proximity
      expect(turn2.goal_proximity).toBeGreaterThanOrEqual(turn1.goal_proximity);
    });
  });

  describe("State Management", () => {
    it("getState returns valid state for active session", async () => {
      if (!brain) return;

      const sessionId = "test-state-1";
      const executor = createMockExecutor({});

      await brain.processTurn(sessionId, "Check calendar", executor);

      const state = await brain.getState(sessionId);
      expect(state).toBeDefined();
      expect(state.is_active).toBe(true);
      expect(state.turns_completed).toBeGreaterThanOrEqual(1);
    });

    it("reset clears session state", async () => {
      if (!brain) return;

      const sessionId = "test-state-2";
      const executor = createMockExecutor({});

      await brain.processTurn(sessionId, "Check calendar", executor);
      await brain.reset(sessionId);

      const state = await brain.getState(sessionId);
      expect(state.turns_completed).toBe(0);
    });
  });

  describe("Error Handling", () => {
    it("handles tool execution failure gracefully", async () => {
      if (!brain) return;

      const failingExecutor: ToolExecutor = async () => ({
        result: "Connection refused",
        success: false,
      });

      const response = await brain.processTurn(
        "test-error-1",
        "Send an email to sarah@example.com",
        failingExecutor,
      );

      // Should still return a response, not throw
      expect(response).toBeDefined();
      expect(response.final_response).toBeDefined();
    });

    it("respects max steps per turn", async () => {
      if (!brain) return;

      // Executor that always succeeds but never completes the goal
      const loopExecutor: ToolExecutor = async (toolName) => ({
        result: `${toolName} executed but more work needed`,
        success: true,
      });

      const response = await brain.processTurn(
        "test-error-2",
        "Do a complex multi-step task",
        loopExecutor,
      );

      // Should not exceed max_steps_per_turn (configured as 5)
      expect(response.steps_taken).toBeLessThanOrEqual(5);
    });
  });

  describe("Channel-Specific Formatting", () => {
    it("processes API channel messages", async () => {
      if (!brain) return;

      const executor = createMockExecutor({});
      const response = await brain.processTurn(
        "test-channel-api",
        "Check calendar",
        executor,
        { channel: "api" },
      );

      expect(response).toBeDefined();
      expect(response.final_response).toBeDefined();
    });

    it("processes chat channel messages", async () => {
      if (!brain) return;

      const executor = createMockExecutor({});
      const response = await brain.processTurn(
        "test-channel-chat",
        "Check calendar",
        executor,
        { channel: "chat" },
      );

      expect(response).toBeDefined();
    });
  });
});
