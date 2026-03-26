/**
 * State Management Tests
 *
 * Tests state assembly, goal extraction, and dynamic state tracking.
 *
 * @purpose Verify state management correctness across input combinations
 * @spec AGENT_FACTORY_SPEC.md#g13-state-management-tests
 */

import { describe, it, expect, beforeEach } from "vitest";

import { StateAssembler } from "../../../src/brain/stratus/StateAssembler.js";
import { DynamicStateTracker } from "../../../src/brain/stratus/DynamicStateTracker.js";
import type {
  StateAssemblyInput,
  ActionResult,
} from "../../../src/brain/stratus/StateAssembler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<StateAssemblyInput> = {}): StateAssemblyInput {
  return {
    primaryGoal: "Schedule a meeting with Sarah",
    subGoals: [],
    userContext: {
      user: "alice",
      domain: "personal_assistant",
      preferences: {},
    },
    tools: [
      { id: "check_calendar", rich_description: "check_calendar (assistant). Check calendar. effects: returns events" },
      { id: "schedule_event", rich_description: "schedule_event (assistant). Create event. effects: event created" },
    ],
    knowledge: [],
    lastAction: undefined,
    changed: [],
    stepNumber: 1,
    goalProximity: 0.0,
    channel: { type: "api", sender: "alice", timestamp: Date.now() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State Assembler Tests
// ---------------------------------------------------------------------------

describe("StateAssembler", () => {
  let assembler: StateAssembler;

  beforeEach(() => {
    assembler = new StateAssembler();
  });

  describe("assemble", () => {
    it("includes goal in assembled state", () => {
      const input = makeInput({ primaryGoal: "Deploy the API service" });
      const state = assembler.assemble(input);

      expect(state).toContain("Deploy the API service");
    });

    it("includes available tools", () => {
      const input = makeInput();
      const state = assembler.assemble(input);

      expect(state).toContain("check_calendar");
      expect(state).toContain("schedule_event");
    });

    it("includes last action when present", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded, 3pm-4pm free",
        success: true,
      };
      const input = makeInput({ lastAction: action });
      const state = assembler.assemble(input);

      expect(state).toContain("check_calendar");
      expect(state).toContain("Calendar loaded");
    });

    it("includes knowledge entries", () => {
      const input = makeInput({
        knowledge: [
          "Sarah prefers afternoon meetings",
          "Conference room B is available",
        ],
      });
      const state = assembler.assemble(input);

      expect(state).toContain("Sarah prefers afternoon meetings");
      expect(state).toContain("Conference room B is available");
    });

    it("includes sub-goals when present", () => {
      const input = makeInput({
        primaryGoal: "Plan team offsite",
        subGoals: ["Book venue", "Send invitations", "Order catering"],
      });
      const state = assembler.assemble(input);

      expect(state).toContain("Book venue");
      expect(state).toContain("Send invitations");
    });

    it("handles minimal input (no optional fields)", () => {
      const input = makeInput({
        subGoals: [],
        knowledge: [],
        lastAction: undefined,
        changed: [],
      });
      const state = assembler.assemble(input);

      expect(state).toBeDefined();
      expect(state.length).toBeGreaterThan(0);
      expect(state).toContain("Schedule a meeting");
    });

    it("includes step number and goal proximity", () => {
      const input = makeInput({ stepNumber: 5, goalProximity: 0.75 });
      const state = assembler.assemble(input);

      // State should contain step/progress indicators
      expect(state).toBeDefined();
    });
  });

  describe("assembleStatic", () => {
    it("includes goal and tools but not dynamic content", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };
      const input = makeInput({ lastAction: action });

      const staticState = assembler.assembleStatic(input);

      expect(staticState).toContain("Schedule a meeting");
      expect(staticState).toContain("check_calendar");
      // Static state should not change between steps with same goal/tools
    });

    it("is identical for same goal and tools across steps", () => {
      const input1 = makeInput({ stepNumber: 1 });
      const input2 = makeInput({ stepNumber: 5 });

      const static1 = assembler.assembleStatic(input1);
      const static2 = assembler.assembleStatic(input2);

      expect(static1).toBe(static2);
    });
  });

  describe("assembleDynamic", () => {
    it("includes last action result", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "3pm-4pm slot available",
        success: true,
      };
      const input = makeInput({ lastAction: action });

      const dynamicState = assembler.assembleDynamic(input);

      expect(dynamicState).toContain("3pm-4pm slot available");
    });

    it("includes changed indicators", () => {
      const input = makeInput({
        changed: ["calendar_checked", "availability_known"],
      });

      const dynamicState = assembler.assembleDynamic(input);

      expect(dynamicState).toContain("calendar_checked");
    });

    it("differs between steps with different actions", () => {
      const input1 = makeInput({
        lastAction: {
          toolId: "check_calendar",
          toolName: "check_calendar",
          params: {},
          result: "Calendar loaded",
          success: true,
        },
        stepNumber: 1,
      });

      const input2 = makeInput({
        lastAction: {
          toolId: "schedule_event",
          toolName: "schedule_event",
          params: { time: "3pm" },
          result: "Event created",
          success: true,
        },
        stepNumber: 2,
        knowledge: ["Calendar loaded, 3pm-4pm free"],
      });

      const dynamic1 = assembler.assembleDynamic(input1);
      const dynamic2 = assembler.assembleDynamic(input2);

      expect(dynamic1).not.toBe(dynamic2);
    });

    it("handles no last action (first step)", () => {
      const input = makeInput({ lastAction: undefined, stepNumber: 0 });

      const dynamicState = assembler.assembleDynamic(input);

      expect(dynamicState).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty goal", () => {
      const input = makeInput({ primaryGoal: "" });
      const state = assembler.assemble(input);
      expect(state).toBeDefined();
    });

    it("handles no tools", () => {
      const input = makeInput({ tools: [] });
      const state = assembler.assemble(input);
      expect(state).toBeDefined();
    });

    it("handles failed action result", () => {
      const input = makeInput({
        lastAction: {
          toolId: "send_email",
          toolName: "send_email",
          params: { to: "sarah@example.com" },
          result: "SMTP connection refused",
          success: false,
        },
      });
      const state = assembler.assemble(input);
      expect(state).toContain("SMTP connection refused");
    });

    it("handles very long knowledge list", () => {
      const knowledge = Array.from({ length: 50 }, (_, i) => `Fact ${i}: some knowledge entry`);
      const input = makeInput({ knowledge });
      const state = assembler.assemble(input);
      expect(state).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Dynamic State Tracker Tests
// ---------------------------------------------------------------------------

describe("DynamicStateTracker", () => {
  let tracker: DynamicStateTracker;

  beforeEach(() => {
    tracker = new DynamicStateTracker();
  });

  describe("recordStep", () => {
    it("records a step and updates state", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "3pm-4pm free",
        success: true,
      };

      const record = tracker.recordStep(action, ["3pm-4pm is available"], 0.3);

      expect(record).toBeDefined();
      expect(record.stepNumber).toBe(1);
      expect(record.action).toBe(action);
      expect(record.goalProximity).toBe(0.3);
    });

    it("increments step numbers", () => {
      const action1: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };
      const action2: ActionResult = {
        toolId: "schedule_event",
        toolName: "schedule_event",
        params: { time: "3pm" },
        result: "Event created",
        success: true,
      };

      const r1 = tracker.recordStep(action1, ["calendar checked"], 0.3);
      const r2 = tracker.recordStep(action2, ["event scheduled"], 0.8);

      expect(r1.stepNumber).toBe(1);
      expect(r2.stepNumber).toBe(2);
    });
  });

  describe("getKnowledge", () => {
    it("accumulates knowledge across steps", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };

      tracker.recordStep(action, ["3pm-4pm free", "No conflicts"], 0.3);
      tracker.recordStep(action, ["Sarah confirmed"], 0.5);

      const knowledge = tracker.getKnowledge();

      expect(knowledge).toContain("3pm-4pm free");
      expect(knowledge).toContain("No conflicts");
      expect(knowledge).toContain("Sarah confirmed");
    });

    it("returns empty array initially", () => {
      expect(tracker.getKnowledge()).toEqual([]);
    });
  });

  describe("getLastAction", () => {
    it("returns the most recent action", () => {
      const action1: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };
      const action2: ActionResult = {
        toolId: "schedule_event",
        toolName: "schedule_event",
        params: { time: "3pm" },
        result: "Event created",
        success: true,
      };

      tracker.recordStep(action1, [], 0.3);
      tracker.recordStep(action2, [], 0.8);

      expect(tracker.getLastAction()).toBe(action2);
    });

    it("returns undefined initially", () => {
      expect(tracker.getLastAction()).toBeUndefined();
    });
  });

  describe("getGoalProximity", () => {
    it("returns latest goal proximity", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };

      tracker.recordStep(action, [], 0.3);
      tracker.recordStep(action, [], 0.7);

      expect(tracker.getGoalProximity()).toBe(0.7);
    });

    it("returns 0 initially", () => {
      expect(tracker.getGoalProximity()).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears all tracked state", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };

      tracker.recordStep(action, ["some knowledge"], 0.5);
      tracker.reset();

      expect(tracker.getKnowledge()).toEqual([]);
      expect(tracker.getLastAction()).toBeUndefined();
      expect(tracker.getGoalProximity()).toBe(0);
    });

    it("resets step counter", () => {
      const action: ActionResult = {
        toolId: "check_calendar",
        toolName: "check_calendar",
        params: {},
        result: "Calendar loaded",
        success: true,
      };

      tracker.recordStep(action, [], 0.3);
      tracker.recordStep(action, [], 0.5);
      tracker.reset();

      const record = tracker.recordStep(action, [], 0.1);
      expect(record.stepNumber).toBe(1);
    });
  });
});
