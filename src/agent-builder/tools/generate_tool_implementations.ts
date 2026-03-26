/**
 * Generate Tool Implementations — Creates executable tool code from definitions
 *
 * Takes tool definitions (from generate_tool_registry) and produces actual
 * executable tool implementations: API clients, mock implementations for testing,
 * parameter validation, and integration adapters.
 *
 * This is what makes the Agent Factory truly end-to-end. A customer describes
 * their business process → analyze_domain extracts actions → generate_tool_registry
 * creates definitions → THIS tool generates the executable code.
 *
 * @purpose Generate executable tool implementations from tool definitions
 */

import type { ToolDefinition, ToolParameter, ApiEndpoint } from "./generate_tool_registry.js";
import type { DomainAnalysis, DomainWorkflow } from "./analyze_domain.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateToolImplementationsInput {
  /** Tool definitions from generate_tool_registry */
  tools: ToolDefinition[];
  /** Domain analysis for context */
  analysis: DomainAnalysis;
  /** Implementation mode */
  mode: ImplementationMode;
  /** Target language */
  language: "typescript" | "python";
  /** Integration config (auth, base URLs, etc.) */
  integrations?: IntegrationConfig[];
}

export type ImplementationMode =
  /** Full API client implementations (requires integration config) */
  | "api_client"
  /** Mock implementations that simulate real behavior (for testing + initial deploy) */
  | "mock"
  /** Stub implementations that log calls but don't execute (for development) */
  | "stub"
  /** LLM-powered implementations where the LLM generates responses (for rapid prototyping) */
  | "llm_powered";

export interface IntegrationConfig {
  /** Service name (e.g., "salesforce", "github", "custom_api") */
  service: string;
  /** Auth type */
  authType: "oauth2" | "api_key" | "bearer" | "basic" | "none";
  /** Base URL for API calls */
  baseUrl?: string;
  /** Environment variable for credentials */
  envVar?: string;
  /** OpenAPI/Swagger spec URL (if available) */
  specUrl?: string;
  /** Which tool IDs this integration covers */
  toolIds: string[];
}

export interface ToolImplementation {
  /** Tool ID this implements */
  toolId: string;
  /** Generated source code */
  sourceCode: string;
  /** File path (relative to agent package) */
  filePath: string;
  /** Implementation mode used */
  mode: ImplementationMode;
  /** Dependencies required */
  dependencies: string[];
  /** Environment variables needed */
  envVars: string[];
  /** Whether this needs human review before production use */
  needsReview: boolean;
  /** Notes for the developer */
  notes: string;
}

export interface ToolImplementationsOutput {
  /** All generated implementations */
  implementations: ToolImplementation[];
  /** Shared utilities (auth, HTTP client, error handling) */
  sharedCode: GeneratedFile[];
  /** Package configuration (package.json / requirements.txt) */
  packageConfig: GeneratedFile;
  /** Entry point that exports all tools */
  entryPoint: GeneratedFile;
  /** Test file for all tools */
  testFile: GeneratedFile;
  /** Environment template (.env.example) */
  envTemplate: GeneratedFile;
  /** Total files generated */
  totalFiles: number;
}

export interface GeneratedFile {
  path: string;
  content: string;
  description: string;
}

// ---------------------------------------------------------------------------
// LLM Callback
// ---------------------------------------------------------------------------

export type GenerateLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Implementation Generator
// ---------------------------------------------------------------------------

export class GenerateToolImplementationsTool {
  private llm: GenerateLlmFn;

  constructor(llm: GenerateLlmFn) {
    this.llm = llm;
  }

  async execute(
    input: GenerateToolImplementationsInput,
    signal?: AbortSignal,
  ): Promise<ToolImplementationsOutput> {
    const { tools, analysis, mode, language, integrations } = input;

    // Step 1: Generate shared utilities (auth, HTTP, error handling)
    const sharedCode = await this.generateSharedCode(language, integrations ?? [], signal);

    // Step 2: Generate each tool implementation
    const implementations: ToolImplementation[] = [];
    for (const tool of tools) {
      const integration = integrations?.find((i) => i.toolIds.includes(tool.id));
      const impl = await this.generateToolImpl(tool, analysis, mode, language, integration, signal);
      implementations.push(impl);
    }

    // Step 3: Generate entry point (exports all tools)
    const entryPoint = this.generateEntryPoint(tools, implementations, language);

    // Step 4: Generate package config
    const packageConfig = this.generatePackageConfig(implementations, language, analysis.domainName);

    // Step 5: Generate test file
    const testFile = await this.generateTestFile(tools, implementations, analysis, language, signal);

    // Step 6: Generate env template
    const envTemplate = this.generateEnvTemplate(implementations, integrations ?? []);

    return {
      implementations,
      sharedCode,
      packageConfig,
      entryPoint,
      testFile,
      envTemplate,
      totalFiles: implementations.length + sharedCode.length + 4,
    };
  }

  // -----------------------------------------------------------------------
  // Shared Code Generation
  // -----------------------------------------------------------------------

  private async generateSharedCode(
    language: "typescript" | "python",
    integrations: IntegrationConfig[],
    signal?: AbortSignal,
  ): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];

    // HTTP client wrapper
    if (language === "typescript") {
      files.push({
        path: "tools/shared/http-client.ts",
        content: this.tsHttpClient(),
        description: "Shared HTTP client with retry, auth, and error handling",
      });

      // Auth helpers per auth type
      const authTypes = new Set(integrations.map((i) => i.authType));
      if (authTypes.size > 0) {
        files.push({
          path: "tools/shared/auth.ts",
          content: this.tsAuthHelpers(integrations),
          description: "Authentication helpers for configured integrations",
        });
      }

      // Tool execution wrapper
      files.push({
        path: "tools/shared/tool-wrapper.ts",
        content: this.tsToolWrapper(),
        description: "Tool execution wrapper with logging, validation, and error handling",
      });
    } else {
      files.push({
        path: "tools/shared/http_client.py",
        content: this.pyHttpClient(),
        description: "Shared HTTP client with retry, auth, and error handling",
      });

      files.push({
        path: "tools/shared/tool_wrapper.py",
        content: this.pyToolWrapper(),
        description: "Tool execution wrapper with logging, validation, and error handling",
      });
    }

    return files;
  }

  // -----------------------------------------------------------------------
  // Tool Implementation Generation
  // -----------------------------------------------------------------------

  private async generateToolImpl(
    tool: ToolDefinition,
    analysis: DomainAnalysis,
    mode: ImplementationMode,
    language: "typescript" | "python",
    integration: IntegrationConfig | undefined,
    signal?: AbortSignal,
  ): Promise<ToolImplementation> {
    switch (mode) {
      case "api_client":
        return this.generateApiClientImpl(tool, analysis, language, integration, signal);
      case "mock":
        return this.generateMockImpl(tool, analysis, language, signal);
      case "stub":
        return this.generateStubImpl(tool, language);
      case "llm_powered":
        return this.generateLlmPoweredImpl(tool, analysis, language, signal);
    }
  }

  private async generateApiClientImpl(
    tool: ToolDefinition,
    analysis: DomainAnalysis,
    language: "typescript" | "python",
    integration: IntegrationConfig | undefined,
    signal?: AbortSignal,
  ): Promise<ToolImplementation> {
    const prompt = [
      `Generate a ${language} implementation for this tool:`,
      ``,
      `Tool: ${tool.id}`,
      `Description: ${tool.description}`,
      `Effects: ${tool.effects}`,
      `Preconditions: ${tool.preconditions}`,
      `Parameters: ${JSON.stringify(tool.parameters, null, 2)}`,
      ``,
      integration ? `Integration: ${integration.service} (${integration.authType})` : `No specific integration — generate standalone implementation.`,
      integration?.baseUrl ? `Base URL: ${integration.baseUrl}` : ``,
      ``,
      `Domain context: ${analysis.summary}`,
      ``,
      `Requirements:`,
      `- Import from shared/http-client and shared/tool-wrapper`,
      `- Validate required parameters before executing`,
      `- Return a structured result object with { success, data, error? }`,
      `- Handle common errors (auth, network, validation)`,
      `- Include JSDoc/docstring`,
      `- Export as default and named export`,
      ``,
      `Return ONLY the code, no markdown blocks.`,
    ].filter(Boolean).join("\n");

    const code = await this.llm(prompt, signal);
    const ext = language === "typescript" ? "ts" : "py";

    return {
      toolId: tool.id,
      sourceCode: code,
      filePath: `tools/${tool.id}.${ext}`,
      mode: "api_client",
      dependencies: integration ? [this.inferDependency(integration)] : [],
      envVars: integration?.envVar ? [integration.envVar] : [],
      needsReview: true, // API client code should always be reviewed
      notes: integration
        ? `Calls ${integration.service} API. Verify endpoint paths and response shapes match your API version.`
        : `Standalone implementation. Connect to your API by updating the HTTP calls.`,
    };
  }

  private async generateMockImpl(
    tool: ToolDefinition,
    analysis: DomainAnalysis,
    language: "typescript" | "python",
    signal?: AbortSignal,
  ): Promise<ToolImplementation> {
    // Find workflows that use this tool to understand realistic behavior
    const relevantWorkflows = analysis.workflows.filter(
      (w) => w.actionsInvolved.includes(tool.actionType),
    );

    const prompt = [
      `Generate a ${language} MOCK implementation for this tool:`,
      ``,
      `Tool: ${tool.id}`,
      `Description: ${tool.description}`,
      `Effects: ${tool.effects}`,
      `Parameters: ${JSON.stringify(tool.parameters, null, 2)}`,
      ``,
      `This mock should simulate realistic behavior:`,
      `- Return plausible data that matches what the real tool would return`,
      `- Simulate side effects in a local state store (in-memory dict/map)`,
      `- Respect preconditions: ${tool.preconditions}`,
      `- Sometimes return errors (10% rate) to test error handling`,
      relevantWorkflows.length > 0
        ? `- Used in workflows: ${relevantWorkflows.map((w) => w.name).join(", ")}`
        : ``,
      ``,
      `The mock must be functional enough that an agent can run full workflows`,
      `against it and produce meaningful traces for probe training.`,
      ``,
      `Return ONLY the code, no markdown blocks.`,
    ].filter(Boolean).join("\n");

    const code = await this.llm(prompt, signal);
    const ext = language === "typescript" ? "ts" : "py";

    return {
      toolId: tool.id,
      sourceCode: code,
      filePath: `tools/${tool.id}.${ext}`,
      mode: "mock",
      dependencies: [],
      envVars: [],
      needsReview: false, // Mocks are safe to run without review
      notes: "Mock implementation with simulated state. Produces realistic traces for probe training. Replace with api_client mode for production.",
    };
  }

  private generateStubImpl(
    tool: ToolDefinition,
    language: "typescript" | "python",
  ): ToolImplementation {
    const ext = language === "typescript" ? "ts" : "py";

    let code: string;
    if (language === "typescript") {
      const params = tool.parameters.map((p) =>
        `  ${p.name}${p.required ? "" : "?"}: ${p.type === "string" ? "string" : p.type === "number" ? "number" : "any"}`,
      ).join(";\n");

      code = [
        `/**`,
        ` * ${tool.description}`,
        ` * @stub Replace with real implementation`,
        ` */`,
        ``,
        `import { ToolResult, wrapTool } from "./shared/tool-wrapper.js";`,
        ``,
        `interface ${this.toPascalCase(tool.id)}Params {`,
        params,
        `}`,
        ``,
        `export async function ${tool.id}(params: ${this.toPascalCase(tool.id)}Params): Promise<ToolResult> {`,
        `  console.log("[STUB] ${tool.id} called with:", params);`,
        `  return {`,
        `    success: true,`,
        `    data: { message: "Stub: ${tool.description}", params },`,
        `  };`,
        `}`,
        ``,
        `export default wrapTool("${tool.id}", ${tool.id});`,
      ].join("\n");
    } else {
      code = [
        `"""`,
        `${tool.description}`,
        `Stub: Replace with real implementation`,
        `"""`,
        ``,
        `from tools.shared.tool_wrapper import wrap_tool, ToolResult`,
        ``,
        ``,
        `async def ${tool.id}(**params) -> ToolResult:`,
        `    print(f"[STUB] ${tool.id} called with: {params}")`,
        `    return ToolResult(`,
        `        success=True,`,
        `        data={"message": "Stub: ${tool.description}", "params": params},`,
        `    )`,
        ``,
        ``,
        `${tool.id}_wrapped = wrap_tool("${tool.id}", ${tool.id})`,
      ].join("\n");
    }

    return {
      toolId: tool.id,
      sourceCode: code,
      filePath: `tools/${tool.id}.${ext}`,
      mode: "stub",
      dependencies: [],
      envVars: [],
      needsReview: false,
      notes: "Stub implementation. Logs calls but does not execute. Replace with mock or api_client.",
    };
  }

  private async generateLlmPoweredImpl(
    tool: ToolDefinition,
    analysis: DomainAnalysis,
    language: "typescript" | "python",
    signal?: AbortSignal,
  ): Promise<ToolImplementation> {
    const ext = language === "typescript" ? "ts" : "py";

    // LLM-powered tools use the agent's LLM to simulate tool behavior
    // This is rapid prototyping — the LLM generates realistic responses
    const prompt = [
      `Generate a ${language} tool implementation that uses an LLM to simulate this tool:`,
      ``,
      `Tool: ${tool.id}`,
      `Description: ${tool.description}`,
      `Effects: ${tool.effects}`,
      `Parameters: ${JSON.stringify(tool.parameters, null, 2)}`,
      ``,
      `The implementation should:`,
      `- Accept an LLM function as a constructor parameter`,
      `- When called, prompt the LLM to generate a realistic response`,
      `- The LLM prompt should include the tool description, parameters, and effects`,
      `- Parse the LLM response into the expected output format`,
      `- This is for rapid prototyping — the LLM simulates what the real tool would do`,
      ``,
      `Return ONLY the code, no markdown blocks.`,
    ].join("\n");

    const code = await this.llm(prompt, signal);

    return {
      toolId: tool.id,
      sourceCode: code,
      filePath: `tools/${tool.id}.${ext}`,
      mode: "llm_powered",
      dependencies: [],
      envVars: [],
      needsReview: false,
      notes: "LLM-powered tool — the agent's LLM simulates tool behavior. Good for prototyping and trace generation. Not for production.",
    };
  }

  // -----------------------------------------------------------------------
  // Entry Point
  // -----------------------------------------------------------------------

  private generateEntryPoint(
    tools: ToolDefinition[],
    implementations: ToolImplementation[],
    language: "typescript" | "python",
  ): GeneratedFile {
    if (language === "typescript") {
      const imports = implementations.map((impl) => {
        const name = impl.toolId;
        const path = `./${impl.filePath.replace("tools/", "").replace(".ts", ".js")}`;
        return `export { default as ${name} } from "${path}";`;
      });

      return {
        path: "tools/index.ts",
        content: [
          `/**`,
          ` * Tool Registry — Auto-generated by Agent Factory`,
          ` * ${tools.length} tools for domain: ${tools[0]?.domain ?? "unknown"}`,
          ` */`,
          ``,
          ...imports,
          ``,
          `/** All tool IDs in this registry */`,
          `export const TOOL_IDS = [`,
          ...tools.map((t) => `  "${t.id}",`),
          `] as const;`,
        ].join("\n"),
        description: "Entry point exporting all tool implementations",
      };
    } else {
      const imports = implementations.map((impl) =>
        `from tools.${impl.toolId} import ${impl.toolId}_wrapped as ${impl.toolId}`,
      );

      return {
        path: "tools/__init__.py",
        content: [
          `"""`,
          `Tool Registry — Auto-generated by Agent Factory`,
          `${tools.length} tools for domain: ${tools[0]?.domain ?? "unknown"}`,
          `"""`,
          ``,
          ...imports,
          ``,
          `TOOL_IDS = [`,
          ...tools.map((t) => `    "${t.id}",`),
          `]`,
          ``,
          `ALL_TOOLS = {`,
          ...tools.map((t) => `    "${t.id}": ${t.id},`),
          `}`,
        ].join("\n"),
        description: "Entry point exporting all tool implementations",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Test File
  // -----------------------------------------------------------------------

  private async generateTestFile(
    tools: ToolDefinition[],
    implementations: ToolImplementation[],
    analysis: DomainAnalysis,
    language: "typescript" | "python",
    signal?: AbortSignal,
  ): Promise<GeneratedFile> {
    const prompt = [
      `Generate a ${language} test file for these tool implementations:`,
      ``,
      ...tools.map((t) => `- ${t.id}: ${t.description}`),
      ``,
      `Each test should:`,
      `- Call the tool with valid parameters and assert success`,
      `- Call with missing required parameters and assert error`,
      `- Test the specific effects described in the tool definition`,
      ``,
      language === "typescript"
        ? `Use vitest (import { describe, it, expect } from "vitest")`
        : `Use pytest`,
      ``,
      `Return ONLY the code, no markdown blocks.`,
    ].join("\n");

    const code = await this.llm(prompt, signal);
    const ext = language === "typescript" ? "test.ts" : "test.py";

    return {
      path: `tools/tools.${ext}`,
      content: code,
      description: "Test suite for all generated tool implementations",
    };
  }

  // -----------------------------------------------------------------------
  // Package Config
  // -----------------------------------------------------------------------

  private generatePackageConfig(
    implementations: ToolImplementation[],
    language: "typescript" | "python",
    domain: string,
  ): GeneratedFile {
    const allDeps = new Set<string>();
    for (const impl of implementations) {
      for (const dep of impl.dependencies) {
        allDeps.add(dep);
      }
    }

    if (language === "typescript") {
      const pkg = {
        name: `@agent-tools/${domain}`,
        version: "0.1.0",
        type: "module",
        main: "tools/index.js",
        dependencies: Object.fromEntries([...allDeps].map((d) => [d, "latest"])),
        devDependencies: { vitest: "^3.0.0", typescript: "^5.0.0" },
      };
      return {
        path: "package.json",
        content: JSON.stringify(pkg, null, 2),
        description: "Package configuration with tool dependencies",
      };
    } else {
      const lines = [
        `# Agent Tools — ${domain}`,
        ...([...allDeps].map((d) => d)),
        "pytest>=7.0",
        "httpx>=0.24",
      ];
      return {
        path: "requirements.txt",
        content: lines.join("\n"),
        description: "Python dependencies for tool implementations",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Env Template
  // -----------------------------------------------------------------------

  private generateEnvTemplate(
    implementations: ToolImplementation[],
    integrations: IntegrationConfig[],
  ): GeneratedFile {
    const lines = ["# Agent Tool Configuration", "# Generated by Agent Factory", ""];

    const envVars = new Set<string>();
    for (const impl of implementations) {
      for (const v of impl.envVars) envVars.add(v);
    }
    for (const int of integrations) {
      if (int.envVar) envVars.add(int.envVar);
    }

    for (const v of envVars) {
      lines.push(`${v}=`);
    }

    if (envVars.size === 0) {
      lines.push("# No environment variables needed for current implementation mode");
    }

    return {
      path: ".env.example",
      content: lines.join("\n"),
      description: "Environment variable template for tool integrations",
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private toPascalCase(s: string): string {
    return s.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  }

  private inferDependency(integration: IntegrationConfig): string {
    const map: Record<string, string> = {
      salesforce: "jsforce",
      github: "octokit",
      slack: "@slack/web-api",
      jira: "jira-client",
      zendesk: "node-zendesk",
      stripe: "stripe",
      twilio: "twilio",
      sendgrid: "@sendgrid/mail",
      aws: "@aws-sdk/client-s3",
    };
    return map[integration.service.toLowerCase()] ?? "node-fetch";
  }

  // -----------------------------------------------------------------------
  // Shared Code Templates
  // -----------------------------------------------------------------------

  private tsHttpClient(): string {
    return `/**
 * Shared HTTP Client — retry, auth, error handling
 * @purpose HTTP client wrapper for tool implementations
 */

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  retries?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export async function httpRequest<T = unknown>(
  url: string,
  options: HttpOptions = {},
): Promise<HttpResponse<T>> {
  const { method = "GET", headers = {}, body, timeout = 30000, retries = 2 } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const data = await response.json() as T;

      if (!response.ok) {
        throw new Error(\`HTTP \${response.status}: \${JSON.stringify(data)}\`);
      }

      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error("Request failed");
}
`;
  }

  private tsAuthHelpers(integrations: IntegrationConfig[]): string {
    const authTypes = new Set(integrations.map((i) => i.authType));
    const parts: string[] = [
      `/**`,
      ` * Auth Helpers — Generated for configured integrations`,
      ` * @purpose Authentication helpers for tool API calls`,
      ` */`,
      ``,
    ];

    if (authTypes.has("api_key")) {
      parts.push(`export function apiKeyHeaders(envVar: string): Record<string, string> {`);
      parts.push(`  const key = process.env[envVar];`);
      parts.push(`  if (!key) throw new Error(\`Missing env var: \${envVar}\`);`);
      parts.push(`  return { "X-API-Key": key };`);
      parts.push(`}`);
      parts.push(``);
    }

    if (authTypes.has("bearer")) {
      parts.push(`export function bearerHeaders(envVar: string): Record<string, string> {`);
      parts.push(`  const token = process.env[envVar];`);
      parts.push(`  if (!token) throw new Error(\`Missing env var: \${envVar}\`);`);
      parts.push(`  return { Authorization: \`Bearer \${token}\` };`);
      parts.push(`}`);
      parts.push(``);
    }

    if (authTypes.has("oauth2")) {
      parts.push(`export async function getOAuthToken(envVar: string): Promise<string> {`);
      parts.push(`  const token = process.env[envVar];`);
      parts.push(`  if (!token) throw new Error(\`Missing OAuth token env var: \${envVar}\`);`);
      parts.push(`  // TODO: Implement token refresh logic for production`);
      parts.push(`  return token;`);
      parts.push(`}`);
    }

    return parts.join("\n");
  }

  private tsToolWrapper(): string {
    return `/**
 * Tool Wrapper — Execution, logging, validation, error handling
 * @purpose Wrap tool functions with consistent behavior
 */

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  duration_ms?: number;
}

export function wrapTool<P, R>(
  toolId: string,
  fn: (params: P) => Promise<ToolResult<R>>,
): (params: P) => Promise<ToolResult<R>> {
  return async (params: P): Promise<ToolResult<R>> => {
    const start = Date.now();
    try {
      const result = await fn(params);
      result.duration_ms = Date.now() - start;
      return result;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      };
    }
  };
}
`;
  }

  private pyHttpClient(): string {
    return `"""
Shared HTTP Client — retry, auth, error handling.

@purpose HTTP client wrapper for tool implementations
"""

import httpx
import asyncio
from typing import Any, Optional


async def http_request(
    url: str,
    method: str = "GET",
    headers: Optional[dict] = None,
    body: Optional[Any] = None,
    timeout: float = 30.0,
    retries: int = 2,
) -> dict:
    headers = {"Content-Type": "application/json", **(headers or {})}
    last_error = None

    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.request(
                    method, url, headers=headers, json=body,
                )
                response.raise_for_status()
                return {
                    "status": response.status_code,
                    "data": response.json(),
                    "headers": dict(response.headers),
                }
        except Exception as e:
            last_error = e
            if attempt < retries:
                await asyncio.sleep(1.0 * (attempt + 1))

    raise last_error or Exception("Request failed")
`;
  }

  private pyToolWrapper(): string {
    return `"""
Tool Wrapper — Execution, logging, validation, error handling.

@purpose Wrap tool functions with consistent behavior
"""

import time
from dataclasses import dataclass, field
from typing import Any, Optional, Callable


@dataclass
class ToolResult:
    success: bool
    data: Any = None
    error: Optional[str] = None
    duration_ms: Optional[float] = None


def wrap_tool(tool_id: str, fn: Callable) -> Callable:
    async def wrapped(**params) -> ToolResult:
        start = time.monotonic()
        try:
            result = await fn(**params)
            result.duration_ms = (time.monotonic() - start) * 1000
            return result
        except Exception as e:
            return ToolResult(
                success=False,
                error=str(e),
                duration_ms=(time.monotonic() - start) * 1000,
            )
    wrapped.__name__ = tool_id
    return wrapped
`;
  }
}
