/**
 * Tool Registry Tests
 *
 * Tests skill-to-tool conversion, embedding cache behavior,
 * and tool search correctness.
 *
 * @purpose Verify tool registry conversion and search accuracy
 * @spec AGENT_FACTORY_SPEC.md#g12-tool-registry-tests
 */

import { describe, it, expect } from "vitest";

import {
  defineTool,
  toToolRegistryYaml,
  validateToolSeparation,
  apiEndpointToTool,
} from "../../../src/sdk/ToolDefinitionHelpers.js";

describe("Tool Definition Helpers", () => {
  describe("defineTool", () => {
    it("generates correct rich_description format", () => {
      const tool = defineTool({
        name: "check_deployment_status",
        domain: "devops",
        description: "Check the current deployment status of a service",
        effects: ["deployment status retrieved", "service health known"],
      });

      expect(tool.id).toBe("check_deployment_status");
      expect(tool.action_type).toBe("check_deployment_status");
      expect(tool.rich_description).toContain("check_deployment_status (devops)");
      expect(tool.rich_description).toContain("effects:");
      expect(tool.rich_description).toContain("deployment status retrieved");
      expect(tool.requires_generation).toBe(false);
    });

    it("handles generation templates", () => {
      const tool = defineTool({
        name: "send_email",
        domain: "communication",
        description: "Send an email",
        effects: ["email sent"],
        requiresGeneration: true,
        generationTemplate: "To: {recipient}\nSubject: {subject}\nBody: {body}",
      });

      expect(tool.requires_generation).toBe(true);
      expect(tool.generation_template).toContain("{recipient}");
    });

    it("converts hyphens to underscores in action_type", () => {
      const tool = defineTool({
        name: "check-deployment-status",
        domain: "devops",
        description: "Check status",
        effects: ["status checked"],
      });

      expect(tool.action_type).toBe("check_deployment_status");
    });
  });

  describe("toToolRegistryYaml", () => {
    it("generates valid YAML structure", () => {
      const tools = [
        defineTool({
          name: "tool_a",
          domain: "test",
          description: "Tool A",
          effects: ["does A"],
        }),
        defineTool({
          name: "tool_b",
          domain: "test",
          description: "Tool B",
          effects: ["does B"],
        }),
      ];

      const yaml = toToolRegistryYaml("test_domain", tools);

      expect(yaml).toContain("domain: test_domain");
      expect(yaml).toContain("tools:");
      expect(yaml).toContain("- id: tool_a");
      expect(yaml).toContain("- id: tool_b");
      expect(yaml).toContain("rich_description:");
    });
  });

  describe("validateToolSeparation", () => {
    it("passes for distinct tools", () => {
      const tools = [
        defineTool({ name: "search", domain: "d", description: "Search the database for records", effects: ["records found"] }),
        defineTool({ name: "deploy", domain: "d", description: "Deploy code to production", effects: ["code deployed"] }),
      ];

      const result = validateToolSeparation(tools);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("warns for highly similar tools", () => {
      const tools = [
        defineTool({ name: "search_db", domain: "d", description: "Search the database for matching records", effects: ["records found"] }),
        defineTool({ name: "query_db", domain: "d", description: "Search the database for matching records", effects: ["records found"] }),
      ];

      const result = validateToolSeparation(tools);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("overlap");
    });
  });

  describe("apiEndpointToTool", () => {
    it("converts API endpoint to tool definition", () => {
      const input = apiEndpointToTool(
        {
          name: "get_orders",
          url: "https://api.example.com/orders",
          method: "GET",
          description: "Fetch customer orders",
          parameters: { customer_id: "string" },
        },
        "ecommerce",
      );

      expect(input.name).toBe("get_orders");
      expect(input.domain).toBe("ecommerce");
      expect(input.effects[0]).toContain("GET");
      expect(input.preconditions).toContain("customer_id provided");
    });
  });
});
