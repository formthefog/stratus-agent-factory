/**
 * Template Manager — Manages pre-configured agent skeletons
 *
 * Templates accelerate agent building by providing pre-defined tool
 * registries, test scenarios, personas, and configuration for common
 * domains. The Agent Builder uses templates as starting points,
 * customizing them for specific customer needs.
 *
 * @purpose Manage and apply pre-configured agent templates for common domains
 * @spec AGENT_FACTORY_SPEC.md#c41-build-template-system
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTemplate {
  /** Template identifier (directory name) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Domain this template is for */
  domain: string;
  /** One-line description */
  description: string;
  /** Training domains this template aligns with */
  trainingDomains: string[];
  /** Template files */
  files: TemplateFile[];
}

export interface TemplateFile {
  /** Filename relative to template directory */
  name: string;
  /** File content */
  content: string;
}

export interface TemplateMeta {
  name: string;
  domain: string;
  description: string;
  training_domains: string[];
}

export interface TemplateMatch {
  template: AgentTemplate;
  /** How well this template matches the query (0-1) */
  score: number;
  /** What the template covers */
  covers: string[];
  /** What the user needs that the template doesn't cover */
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TemplateManager {
  private templatesDir: string;
  private cache: Map<string, AgentTemplate> = new Map();

  constructor(templatesDir = "templates") {
    this.templatesDir = templatesDir;
  }

  /**
   * List all available templates.
   */
  listTemplates(): AgentTemplate[] {
    this.ensureLoaded();
    return [...this.cache.values()];
  }

  /**
   * Get a specific template by ID.
   */
  getTemplate(id: string): AgentTemplate | null {
    this.ensureLoaded();
    return this.cache.get(id) ?? null;
  }

  /**
   * Find templates that match a domain description.
   */
  findMatches(
    domainDescription: string,
    domainActions?: string[],
  ): TemplateMatch[] {
    this.ensureLoaded();
    const matches: TemplateMatch[] = [];
    const descWords = new Set(domainDescription.toLowerCase().split(/\s+/));
    const actionSet = new Set((domainActions ?? []).map((a) => a.toLowerCase()));

    for (const template of this.cache.values()) {
      let score = 0;
      const covers: string[] = [];
      const gaps: string[] = [];

      // Domain keyword match
      const domainWords = template.domain.split("_");
      for (const word of domainWords) {
        if (descWords.has(word)) score += 0.2;
      }

      // Training domain match
      for (const td of template.trainingDomains) {
        const tdWords = td.split("_");
        for (const word of tdWords) {
          if (descWords.has(word)) score += 0.1;
        }
      }

      // Name/description match
      const nameWords = template.name.toLowerCase().split(/\s+/);
      for (const word of nameWords) {
        if (descWords.has(word)) score += 0.15;
      }

      // Tool coverage (if actions provided)
      if (actionSet.size > 0) {
        const templateTools = this.extractToolIds(template);
        for (const tool of templateTools) {
          const toolWords = tool.split("_");
          const hasMatch = toolWords.some((w) => actionSet.has(w)) ||
            [...actionSet].some((a) => a.includes(tool) || tool.includes(a));
          if (hasMatch) {
            covers.push(tool);
            score += 0.05;
          }
        }

        for (const action of actionSet) {
          if (!covers.some((c) => c.includes(action) || action.includes(c))) {
            gaps.push(action);
          }
        }
      }

      score = Math.min(score, 1.0);

      if (score > 0.1) {
        matches.push({ template, score, covers, gaps });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply a template as a starting point for agent configuration.
   * Returns the template files that can be written to the agent directory.
   */
  applyTemplate(
    templateId: string,
    overrides?: {
      agentName?: string;
      agentId?: string;
      domain?: string;
    },
  ): TemplateFile[] | null {
    const template = this.getTemplate(templateId);
    if (!template) return null;

    const files = template.files.map((f) => ({
      name: f.name,
      content: this.applyOverrides(f.content, overrides ?? {}),
    }));

    return files;
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.cache.size > 0) return;

    if (!existsSync(this.templatesDir)) return;

    const entries = readdirSync(this.templatesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const templateDir = join(this.templatesDir, entry.name);
      const template = this.loadTemplate(entry.name, templateDir);
      if (template) {
        this.cache.set(template.id, template);
      }
    }
  }

  private loadTemplate(id: string, dir: string): AgentTemplate | null {
    // Load meta from template.yaml or infer from directory
    const metaPath = join(dir, "template.yaml");
    let meta: TemplateMeta;

    if (existsSync(metaPath)) {
      const raw = readFileSync(metaPath, "utf-8");
      meta = this.parseTemplateMeta(raw);
    } else {
      // Infer from directory name
      meta = {
        name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        domain: id.replace(/-/g, "_"),
        description: `Pre-configured template for ${id.replace(/-/g, " ")}`,
        training_domains: [id.replace(/-/g, "_")],
      };
    }

    // Load all files in the directory
    const files: TemplateFile[] = [];
    const fileEntries = readdirSync(dir, { withFileTypes: true });

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile()) continue;
      if (fileEntry.name === "template.yaml") continue; // Skip meta

      const content = readFileSync(join(dir, fileEntry.name), "utf-8");
      files.push({ name: fileEntry.name, content });
    }

    return {
      id,
      name: meta.name,
      domain: meta.domain,
      description: meta.description,
      trainingDomains: meta.training_domains,
      files,
    };
  }

  private parseTemplateMeta(raw: string): TemplateMeta {
    // Simple YAML-like parsing for template meta
    const lines = raw.split("\n");
    const meta: Record<string, string | string[]> = {};

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)/);
      if (match) {
        const [, key, value] = match;
        if (value.startsWith("[")) {
          // Array value
          meta[key] = value
            .replace(/[\[\]]/g, "")
            .split(",")
            .map((s) => s.trim().replace(/['"]/g, ""));
        } else {
          meta[key] = value.replace(/['"]/g, "").trim();
        }
      }
    }

    return {
      name: (meta.name as string) ?? "Unknown",
      domain: (meta.domain as string) ?? "unknown",
      description: (meta.description as string) ?? "",
      training_domains: Array.isArray(meta.training_domains)
        ? meta.training_domains
        : [(meta.domain as string) ?? "unknown"],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractToolIds(template: AgentTemplate): string[] {
    const toolsFile = template.files.find((f) => f.name === "agent.tools.yaml");
    if (!toolsFile) return [];

    const ids: string[] = [];
    const lines = toolsFile.content.split("\n");

    for (const line of lines) {
      const match = line.match(/^\s+-\s+id:\s+(\S+)/);
      if (match) ids.push(match[1]);
    }

    return ids;
  }

  private applyOverrides(
    content: string,
    overrides: { agentName?: string; agentId?: string; domain?: string },
  ): string {
    let result = content;

    if (overrides.agentName) {
      result = result.replace(/\{\{agent_name\}\}/g, overrides.agentName);
    }
    if (overrides.agentId) {
      result = result.replace(/\{\{agent_id\}\}/g, overrides.agentId);
    }
    if (overrides.domain) {
      result = result.replace(/\{\{domain\}\}/g, overrides.domain);
    }

    return result;
  }
}
