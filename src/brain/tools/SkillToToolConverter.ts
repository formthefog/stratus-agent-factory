/**
 * Skill-to-Tool Converter — Reads OpenClaw skill manifests from disk
 *
 * Scans OpenClaw skill directories for openclaw.plugin.json manifests and
 * SKILL.md files, then converts them into BrainToolDefinitions.
 *
 * This complements ToolRegistry.ts (which converts in-memory registrations)
 * by handling the filesystem discovery path: agent startup scans skills dirs,
 * reads manifests, and pre-computes tool definitions before any plugin loads.
 *
 * @purpose Filesystem-based skill manifest reader and converter
 * @spec AGENT_FACTORY_SPEC.md#a33-build-skill-to-tool-converter
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { BrainToolDefinition } from "../IBrain.js";
import type { ToolRegistryEntry, ToolAction } from "./ToolRegistry.js";
import { entryToBrainTool } from "./ToolRegistry.js";

// ---------------------------------------------------------------------------
// Manifest Types (from openclaw.plugin.json)
// ---------------------------------------------------------------------------

interface PluginManifest {
  id: string;
  name?: string;
  description?: string;
  skills?: string[];
  configSchema?: Record<string, unknown>;
}

interface SkillFrontmatter {
  name: string;
  description?: string;
  "user-invocable"?: boolean;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan a directory for OpenClaw plugin manifests and convert all discovered
 * skills into BrainToolDefinitions.
 *
 * @param extensionsDir - Path to the extensions/ directory
 * @returns Array of BrainToolDefinitions for all discovered tools
 */
export function discoverSkills(extensionsDir: string): BrainToolDefinition[] {
  if (!existsSync(extensionsDir)) return [];

  const entries: ToolRegistryEntry[] = [];

  for (const pluginDir of listSubdirectories(extensionsDir)) {
    const manifestPath = join(pluginDir, "openclaw.plugin.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = readJsonFile<PluginManifest>(manifestPath);
    if (!manifest) continue;

    // Read skills from manifest-declared skill directories
    const skillDirs = manifest.skills ?? ["./skills"];
    for (const relSkillDir of skillDirs) {
      const skillsPath = join(pluginDir, relSkillDir);
      if (!existsSync(skillsPath)) continue;

      for (const skillDir of listSubdirectories(skillsPath)) {
        const skillEntry = readSkillDir(skillDir, manifest);
        if (skillEntry) entries.push(skillEntry);
      }
    }

    // Also check for a top-level SKILL.md (some plugins like lobster use this)
    const topSkillMd = join(pluginDir, "SKILL.md");
    if (existsSync(topSkillMd)) {
      const entry = readSkillFile(topSkillMd, manifest);
      if (entry) entries.push(entry);
    }
  }

  return entries.map(entryToBrainTool);
}

/**
 * Convert a single plugin manifest + skill directory into a ToolRegistryEntry.
 */
function readSkillDir(
  skillDir: string,
  manifest: PluginManifest,
): ToolRegistryEntry | null {
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;
  return readSkillFile(skillMdPath, manifest);
}

/**
 * Parse a SKILL.md file into a ToolRegistryEntry.
 */
function readSkillFile(
  skillMdPath: string,
  manifest: PluginManifest,
): ToolRegistryEntry | null {
  const content = readTextFile(skillMdPath);
  if (!content) return null;

  const frontmatter = parseFrontmatter(content);
  if (!frontmatter?.name) return null;

  const body = stripFrontmatter(content);
  const actions = parseActions(body);
  const description =
    frontmatter.description ?? manifest.description ?? `Skill: ${frontmatter.name}`;

  return {
    id: frontmatter.name,
    name: frontmatter.name,
    pluginId: manifest.id,
    description,
    parametersSchema: inferSchemaFromActions(actions),
    optional: false,
    domain: inferDomainFromManifest(manifest),
    effects: inferEffectsFromBody(body),
    preconditions: [],
    actions: actions.length > 0 ? actions : undefined,
  };
}

// ---------------------------------------------------------------------------
// Rich Description (Training Format)
// ---------------------------------------------------------------------------

/**
 * Build rich_description matching the Stratus action encoder training format:
 * "{action_type} ({domain}). {description}. effects: {effects}"
 *
 * This format matches what the V6 JEPA model was trained on for action encoding.
 */
export function buildRichDescription(entry: ToolRegistryEntry): string {
  const actionType = classifyActionType(entry);
  const effects = entry.effects.length > 0 ? entry.effects.join(", ") : "unknown";
  return `${actionType} (${entry.domain}). ${entry.description}. effects: ${effects}`;
}

/** Classify tool into action type categories matching training data. */
function classifyActionType(entry: ToolRegistryEntry): string {
  const desc = entry.description.toLowerCase();
  if (/search|find|query|list|get|read|fetch/.test(desc)) return "observe";
  if (/creat|write|add|insert|post|send|publish/.test(desc)) return "create";
  if (/updat|edit|modif|chang|set|configur|move|rename/.test(desc)) return "modify";
  if (/delet|remov|drop|clear|destroy/.test(desc)) return "destroy";
  if (/run|execut|invoke|call|trigger/.test(desc)) return "execute";
  if (/analyz|compar|diff|check|validat/.test(desc)) return "analyze";
  return "interact";
}

// ---------------------------------------------------------------------------
// Parsing Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\S+):\s*(.+)/);
    if (kv) {
      const value = kv[2].trim();
      // Strip quotes
      result[kv[1]] = value.replace(/^["']|["']$/g, "");
    }
  }

  if (!result.name) return null;
  return result as unknown as SkillFrontmatter;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

/** Extract action patterns from SKILL.md body (```json blocks with "action" field). */
function parseActions(body: string): ToolAction[] {
  const actions: ToolAction[] = [];
  const codeBlocks = body.matchAll(/```json\s*\n([\s\S]*?)\n```/g);

  for (const match of codeBlocks) {
    try {
      const json = JSON.parse(match[1]);
      if (json.action && typeof json.action === "string") {
        actions.push({
          name: json.action,
          description: `Action: ${json.action}`,
          schema: json,
        });
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return actions;
}

function inferSchemaFromActions(actions: ToolAction[]): Record<string, unknown> {
  if (actions.length === 0) return { type: "object", properties: {} };

  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: actions.map((a) => a.name),
      },
    },
    required: ["action"],
  };
}

function inferDomainFromManifest(manifest: PluginManifest): string {
  if (manifest.id.includes("feishu") || manifest.id.includes("slack")) {
    return "collaboration";
  }
  if (manifest.id.includes("discord") || manifest.id.includes("msteams")) {
    return "messaging";
  }
  if (manifest.id.includes("brave") || manifest.id.includes("exa") || manifest.id.includes("firecrawl")) {
    return "web-search";
  }
  if (manifest.id.includes("memory")) return "memory";
  return manifest.id;
}

function inferEffectsFromBody(body: string): string[] {
  const effects: string[] = [];
  const lower = body.toLowerCase();
  if (/creat|add|write|send/.test(lower)) effects.push("creates_resource");
  if (/updat|edit|modif/.test(lower)) effects.push("modifies_resource");
  if (/delet|remov/.test(lower)) effects.push("deletes_resource");
  if (/read|get|list|search/.test(lower)) effects.push("reads_resource");
  return effects.length > 0 ? effects : ["unknown"];
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}
