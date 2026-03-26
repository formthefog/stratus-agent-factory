/**
 * Analyze Domain Tool — Extracts entities, actions, and workflows from a domain
 *
 * Takes a natural language or structured domain description, uses an LLM to
 * extract the key entities, common actions, typical workflows, and goals.
 * Maps against the existing 87+ training domains to identify coverage gaps.
 *
 * @purpose Extract domain structure (entities, actions, workflows) for agent building
 * @spec AGENT_FACTORY_SPEC.md#c11-analyze_domain-tool
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input to the analyze_domain tool. */
export interface AnalyzeDomainInput {
  /** Natural language or structured description of the domain */
  description: string;
  /** Optional: list of API endpoints or tools available in this domain */
  availableApis?: string[];
  /** Optional: example user goals/requests in this domain */
  exampleGoals?: string[];
}

/** A key entity identified in the domain. */
export interface DomainEntity {
  name: string;
  description: string;
  /** Common attributes of this entity */
  attributes: string[];
  /** CRUD and domain-specific operations on this entity */
  operations: string[];
}

/** A workflow identified in the domain. */
export interface DomainWorkflow {
  name: string;
  description: string;
  /** Ordered steps in this workflow */
  steps: string[];
  /** Tools/actions involved */
  actionsInvolved: string[];
  /** Typical goal that triggers this workflow */
  triggerGoal: string;
}

/** An action identified in the domain. */
export interface DomainAction {
  /** Action type (e.g. "create_ticket", "approve_request") */
  actionType: string;
  description: string;
  /** What this action changes */
  effects: string;
  /** What must be true for this action */
  preconditions: string;
  /** Whether this action needs LLM parameter generation */
  requiresGeneration: boolean;
}

/** Match against an existing training domain. */
export interface TrainingDomainMatch {
  /** Name of the training domain */
  domain: string;
  /** How well it matches (0-1) */
  similarity: number;
  /** Which actions are covered by this training domain */
  coveredActions: string[];
  /** Which actions are NOT covered */
  gapActions: string[];
}

/** Full output of the domain analysis. */
export interface DomainAnalysis {
  /** Domain name (inferred from description) */
  domainName: string;
  /** One-line summary */
  summary: string;
  /** Key entities in this domain */
  entities: DomainEntity[];
  /** Common actions */
  actions: DomainAction[];
  /** Typical workflows */
  workflows: DomainWorkflow[];
  /** Common goals users have in this domain */
  goals: string[];
  /** Matches against existing training domains */
  trainingCoverage: TrainingDomainMatch[];
  /** Actions not covered by any training domain */
  gaps: string[];
  /** Whether a custom probe is recommended */
  customProbeRecommended: boolean;
  /** Reasoning for probe recommendation */
  probeReasoning: string;
}

// ---------------------------------------------------------------------------
// LLM Callback
// ---------------------------------------------------------------------------

/**
 * LLM function signature for domain analysis.
 * The Agent Builder's own LLM handles the extraction.
 */
export type AnalyzeLlmFn = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Known Training Domains (subset for matching)
// ---------------------------------------------------------------------------

const KNOWN_TRAINING_DOMAINS = [
  "customer_support", "project_management", "devops", "hr_onboarding",
  "sales_pipeline", "content_management", "inventory_management",
  "incident_response", "code_review", "documentation", "scheduling",
  "expense_management", "data_analysis", "email_management",
  "social_media", "legal_review", "financial_reporting",
  "user_onboarding", "bug_tracking", "release_management",
  "api_management", "database_admin", "security_audit",
  "compliance_check", "vendor_management", "contract_management",
  "recruitment", "performance_review", "training_management",
  "knowledge_base", "workflow_automation", "notification_management",
  "access_control", "backup_management", "monitoring",
  "capacity_planning", "cost_optimization", "feature_flags",
  "ab_testing", "analytics_dashboard", "report_generation",
];

// ---------------------------------------------------------------------------
// Tool Implementation
// ---------------------------------------------------------------------------

export class AnalyzeDomainTool {
  private llm: AnalyzeLlmFn;

  constructor(llm: AnalyzeLlmFn) {
    this.llm = llm;
  }

  /**
   * Analyze a domain to extract its structure.
   */
  async execute(
    input: AnalyzeDomainInput,
    signal?: AbortSignal,
  ): Promise<DomainAnalysis> {
    const prompt = this.buildPrompt(input);
    const raw = await this.llm(prompt, signal);
    const parsed = this.parseResponse(raw);

    // Match against training domains
    parsed.trainingCoverage = this.matchTrainingDomains(parsed);
    parsed.gaps = this.findGaps(parsed);
    parsed.customProbeRecommended = this.shouldRecommendCustomProbe(parsed);
    parsed.probeReasoning = this.buildProbeReasoning(parsed);

    return parsed;
  }

  // -----------------------------------------------------------------------
  // Prompt Building
  // -----------------------------------------------------------------------

  private buildPrompt(input: AnalyzeDomainInput): string {
    const parts: string[] = [];

    parts.push("Analyze the following domain for building an AI agent.");
    parts.push("");
    parts.push("## Domain Description");
    parts.push(input.description);

    if (input.availableApis?.length) {
      parts.push("");
      parts.push("## Available APIs/Tools");
      for (const api of input.availableApis) {
        parts.push(`- ${api}`);
      }
    }

    if (input.exampleGoals?.length) {
      parts.push("");
      parts.push("## Example User Goals");
      for (const goal of input.exampleGoals) {
        parts.push(`- ${goal}`);
      }
    }

    parts.push("");
    parts.push("## Required Output (JSON)");
    parts.push("Return a JSON object with these fields:");
    parts.push("- domainName: short identifier (snake_case)");
    parts.push("- summary: one-line description");
    parts.push("- entities: array of { name, description, attributes: string[], operations: string[] }");
    parts.push("- actions: array of { actionType, description, effects, preconditions, requiresGeneration }");
    parts.push("- workflows: array of { name, description, steps: string[], actionsInvolved: string[], triggerGoal }");
    parts.push("- goals: array of common user goals (strings)");
    parts.push("");
    parts.push("For each action, determine requiresGeneration=true if the action needs");
    parts.push("free-text or structured parameters that must be generated by an LLM");
    parts.push("(e.g., composing a message, writing a summary). Set false for actions");
    parts.push("with fixed or derivable parameters (e.g., approve_request, close_ticket).");

    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Response Parsing
  // -----------------------------------------------------------------------

  private parseResponse(raw: string): DomainAnalysis {
    // Extract JSON from response (may be wrapped in code blocks)
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw];
    const jsonStr = (jsonMatch[1] ?? raw).trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        domainName: parsed.domainName ?? "unknown",
        summary: parsed.summary ?? "",
        entities: parsed.entities ?? [],
        actions: parsed.actions ?? [],
        workflows: parsed.workflows ?? [],
        goals: parsed.goals ?? [],
        trainingCoverage: [],
        gaps: [],
        customProbeRecommended: false,
        probeReasoning: "",
      };
    } catch {
      // If parsing fails, return a minimal analysis
      return {
        domainName: "parse_error",
        summary: "Failed to parse LLM response",
        entities: [],
        actions: [],
        workflows: [],
        goals: [],
        trainingCoverage: [],
        gaps: [],
        customProbeRecommended: true,
        probeReasoning: "Analysis incomplete — could not parse LLM response.",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Training Domain Matching
  // -----------------------------------------------------------------------

  private matchTrainingDomains(analysis: DomainAnalysis): TrainingDomainMatch[] {
    const matches: TrainingDomainMatch[] = [];
    const actionTypes = new Set(analysis.actions.map((a) => a.actionType.toLowerCase()));

    for (const domain of KNOWN_TRAINING_DOMAINS) {
      // Simple keyword overlap scoring
      const domainKeywords = domain.split("_");
      const descWords = analysis.summary.toLowerCase().split(/\s+/);
      const entityNames = analysis.entities.map((e) => e.name.toLowerCase());

      let score = 0;
      for (const kw of domainKeywords) {
        if (descWords.includes(kw)) score += 0.3;
        if (entityNames.some((e) => e.includes(kw))) score += 0.2;
      }

      // Check if domain name appears in the domain description
      if (analysis.domainName.includes(domain) || domain.includes(analysis.domainName)) {
        score += 0.5;
      }

      score = Math.min(score, 1.0);

      if (score > 0.1) {
        // Estimate covered actions (heuristic: domain-related action types)
        const covered: string[] = [];
        const gaps: string[] = [];

        for (const action of actionTypes) {
          const isLikelyCovered = domainKeywords.some((kw) => action.includes(kw));
          if (isLikelyCovered) {
            covered.push(action);
          } else {
            gaps.push(action);
          }
        }

        matches.push({
          domain,
          similarity: score,
          coveredActions: covered,
          gapActions: gaps,
        });
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  private findGaps(analysis: DomainAnalysis): string[] {
    const coveredByAny = new Set<string>();
    for (const match of analysis.trainingCoverage) {
      for (const action of match.coveredActions) {
        coveredByAny.add(action);
      }
    }

    return analysis.actions
      .map((a) => a.actionType.toLowerCase())
      .filter((a) => !coveredByAny.has(a));
  }

  private shouldRecommendCustomProbe(analysis: DomainAnalysis): boolean {
    // Recommend custom probe if:
    // 1. No training domain matches > 0.5 similarity
    // 2. More than 30% of actions are gaps
    const bestMatch = analysis.trainingCoverage[0]?.similarity ?? 0;
    const totalActions = analysis.actions.length;
    const gapRatio = totalActions > 0 ? analysis.gaps.length / totalActions : 1;

    return bestMatch < 0.5 || gapRatio > 0.3;
  }

  private buildProbeReasoning(analysis: DomainAnalysis): string {
    const bestMatch = analysis.trainingCoverage[0];

    if (!bestMatch || bestMatch.similarity < 0.2) {
      return `Domain "${analysis.domainName}" has no close match in training data. A custom probe trained on domain-specific trajectories is strongly recommended.`;
    }

    if (analysis.customProbeRecommended) {
      return `Best training match is "${bestMatch.domain}" (${(bestMatch.similarity * 100).toFixed(0)}% similarity) but ${analysis.gaps.length}/${analysis.actions.length} actions are uncovered. Recommend starting with general probe and training a custom one.`;
    }

    return `Domain "${analysis.domainName}" is well-covered by training domain "${bestMatch.domain}" (${(bestMatch.similarity * 100).toFixed(0)}% similarity). General probe should work; custom probe optional for optimization.`;
  }
}
