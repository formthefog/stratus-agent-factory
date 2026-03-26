/**
 * Stratus CLI — Internal build/test/deploy tool
 *
 * Used by the team to manage agents during development and by
 * the AI Transformation product for automated operations.
 * Not a public-facing CLI.
 *
 * Commands:
 *   stratus init [template]      — Create agent from template
 *   stratus build [dir]          — Validate, embed tools, package
 *   stratus test [dir]           — Run test scenarios
 *   stratus deploy [dir] [target] — Deploy to local|docker|fly
 *   stratus status [agent-id]    — Agent health/metrics
 *   stratus probe train [dir]    — Train custom probe
 *   stratus probe eval [probe]   — Evaluate probe
 *   stratus list                 — List deployed agents
 *
 * @purpose Internal CLI for agent lifecycle management
 * @spec AGENT_FACTORY_SPEC.md#f11-build-stratus-claw-cli
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CLICommand {
  name: string;
  description: string;
  args: CLIArg[];
  handler: (args: Record<string, string>, flags: Record<string, boolean>) => Promise<void>;
}

export interface CLIArg {
  name: string;
  description: string;
  required: boolean;
  default?: string;
}

// ---------------------------------------------------------------------------
// Command definitions (for wiring into OpenClaw CLI or standalone)
// ---------------------------------------------------------------------------

export const commands: CLICommand[] = [
  {
    name: "init",
    description: "Create a new agent from a template",
    args: [
      { name: "template", description: "Template ID (devops-incident, sales-pipeline, customer-support, personal-assistant)", required: false, default: "personal-assistant" },
      { name: "name", description: "Agent name", required: false },
    ],
    handler: async (args) => {
      const { TemplateManager } = await import("../agent-builder/templates/index.js");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");

      const manager = new TemplateManager("templates");
      const templateId = args.template ?? "personal-assistant";
      const agentName = args.name ?? `my-${templateId}`;
      const outputDir = agentName;

      const files = manager.applyTemplate(templateId, { agentName, agentId: agentName });
      if (!files) {
        console.error(`Template "${templateId}" not found`);
        return;
      }

      mkdirSync(outputDir, { recursive: true });
      for (const file of files) {
        writeFileSync(join(outputDir, file.name), file.content);
      }

      console.log(`Agent "${agentName}" created from template "${templateId}"`);
      console.log(`  Directory: ${outputDir}/`);
      console.log(`  Files: ${files.map((f) => f.name).join(", ")}`);
    },
  },

  {
    name: "build",
    description: "Validate and package an agent",
    args: [
      { name: "dir", description: "Agent directory", required: false, default: "." },
    ],
    handler: async (args) => {
      const { AgentPackager } = await import("../packaging/AgentPackager.js");

      const agentDir = args.dir ?? ".";
      const packager = new AgentPackager({
        stratusModelVersion: "v6",
        cacheEmbeddings: true,
        sidecarUrl: "http://127.0.0.1:7900",
      });

      // Validate first
      const validation = packager.validate(agentDir);
      if (!validation.valid) {
        console.error("Validation failed:");
        for (const err of validation.errors) {
          console.error(`  ERROR: ${err.message}`);
        }
        return;
      }

      for (const warn of validation.warnings) {
        console.warn(`  WARNING: ${warn.message}`);
      }

      // Package
      const pkg = await packager.package(agentDir);
      console.log(`Package created: ${pkg.manifest.agentId} v${pkg.manifest.stratusModelVersion}`);
      console.log(`  Tools: ${pkg.manifest.tools.count}`);
      console.log(`  Probe: ${pkg.manifest.probe.primaryProbeId}`);
      console.log(`  Files: ${pkg.manifest.files.length}`);
    },
  },

  {
    name: "test",
    description: "Run test scenarios against an agent",
    args: [
      { name: "dir", description: "Agent directory", required: false, default: "." },
    ],
    handler: async (args) => {
      const { TestAgentTool } = await import("../agent-builder/tools/index.js");

      const agentDir = args.dir ?? ".";
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      const scenariosPath = join(agentDir, "tests", "scenarios.yaml");
      const scenariosYaml = readFileSync(scenariosPath, "utf-8");

      console.log(`Running tests from ${scenariosPath}...`);

      const testTool = new TestAgentTool();
      const report = await testTool.execute({
        agentDir,
        scenariosYaml,
        sandboxRunner: async () => ({ steps: [], goalReached: false }),
      });

      console.log(`\nResults: ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(1)}%)`);
      console.log(report.markdownReport);
    },
  },

  {
    name: "deploy",
    description: "Deploy an agent to a target",
    args: [
      { name: "dir", description: "Agent directory", required: false, default: "." },
      { name: "target", description: "Deployment target (local|docker|fly)", required: false, default: "local" },
    ],
    handler: async (args) => {
      const target = args.target ?? "local";
      const agentDir = args.dir ?? ".";

      // Load manifest
      const { AgentLoader } = await import("../packaging/AgentLoader.js");
      const loader = new AgentLoader({ currentModelVersion: "v6" });
      const info = loader.loadInfo(agentDir);

      console.log(`Deploying ${info.agentId} to ${target}...`);

      switch (target) {
        case "local": {
          const { LocalDeployer } = await import("../deploy/LocalDeployer.js");
          const deployer = new LocalDeployer({ ensureSidecar: true });
          const manifest = JSON.parse(
            (await import("node:fs")).readFileSync(
              (await import("node:path")).join(agentDir, ".stratus", "manifest.json"),
              "utf-8",
            ),
          );
          const result = await deployer.deploy({
            manifest,
            rootDir: agentDir,
          });
          console.log(`Installed to: ${result.installDir}`);
          console.log(`Gateway registered: ${result.gatewayRegistered}`);
          console.log(`Sidecar: ${result.sidecarRunning ? "running" : "not running"}`);
          break;
        }

        case "docker": {
          const { DockerDeployer } = await import("../deploy/DockerDeployer.js");
          const deployer = new DockerDeployer({
            outputDir: `${agentDir}/.deploy`,
          });
          const manifest = JSON.parse(
            (await import("node:fs")).readFileSync(
              (await import("node:path")).join(agentDir, ".stratus", "manifest.json"),
              "utf-8",
            ),
          );
          const result = deployer.generate({ manifest, rootDir: agentDir });
          console.log(`Dockerfile: ${result.dockerfilePath}`);
          console.log(`Build: ${result.buildCommand}`);
          console.log(`Run: ${result.runCommand}`);
          break;
        }

        case "fly": {
          const { FlyDeployer } = await import("../deploy/FlyDeployer.js");
          const deployer = new FlyDeployer({
            outputDir: `${agentDir}/.deploy`,
          });
          const manifest = JSON.parse(
            (await import("node:fs")).readFileSync(
              (await import("node:path")).join(agentDir, ".stratus", "manifest.json"),
              "utf-8",
            ),
          );
          const result = deployer.generate({ manifest, rootDir: agentDir });
          console.log(`fly.toml: ${result.flyTomlPath}`);
          console.log(`Deploy: ${result.deployCommand}`);
          break;
        }
      }
    },
  },

  {
    name: "list",
    description: "List locally installed agents",
    args: [],
    handler: async () => {
      const { LocalDeployer } = await import("../deploy/LocalDeployer.js");
      const deployer = new LocalDeployer();
      const agents = deployer.listInstalled();

      if (agents.length === 0) {
        console.log("No agents installed locally.");
        return;
      }

      console.log(`${agents.length} agent(s) installed:`);
      for (const agent of agents) {
        console.log(`  - ${agent}`);
      }
    },
  },
];

/**
 * Parse and execute a CLI command.
 */
export async function runCLI(argv: string[]): Promise<void> {
  const commandName = argv[0];
  const command = commands.find((c) => c.name === commandName);

  if (!command) {
    console.log("Usage: stratus <command> [args]");
    console.log("");
    console.log("Commands:");
    for (const cmd of commands) {
      console.log(`  ${cmd.name.padEnd(12)} ${cmd.description}`);
    }
    return;
  }

  // Parse positional args
  const args: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  let argIdx = 0;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = true;
    } else if (argIdx < command.args.length) {
      args[command.args[argIdx].name] = argv[i];
      argIdx++;
    }
  }

  // Apply defaults
  for (const arg of command.args) {
    if (!args[arg.name] && arg.default) {
      args[arg.name] = arg.default;
    }
  }

  await command.handler(args, flags);
}
