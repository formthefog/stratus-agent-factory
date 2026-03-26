/**
 * BrainRegistry — Brain Implementation Selection
 *
 * Manages available brain implementations and selects the active one
 * based on agent configuration. Falls back to ReAct if Stratus not configured.
 *
 * @purpose Brain implementation registry and selection
 * @spec AGENT_FACTORY_SPEC.md#a24-create-brain-registry
 */

import type { IBrain, BrainConfig } from "./IBrain.js";

type BrainFactory = (config: BrainConfig) => Promise<IBrain>;

const registry = new Map<string, BrainFactory>();

/**
 * Register a brain implementation factory.
 * Called at startup by each brain implementation module.
 *
 * @example
 * ```typescript
 * registerBrain("react", async (config) => {
 *   const brain = new ReActBrainAdapter();
 *   await brain.configure(config);
 *   return brain;
 * });
 * ```
 */
export function registerBrain(type: string, factory: BrainFactory): void {
  registry.set(type, factory);
}

/**
 * Create a brain instance from config.
 * Falls back to "react" if the requested type is not registered.
 *
 * @param config - Brain configuration (includes type field)
 * @returns Configured brain instance
 * @throws If neither requested type nor "react" fallback is registered
 */
export async function createBrain(config: BrainConfig): Promise<IBrain> {
  const factory = registry.get(config.type);

  if (factory) {
    return factory(config);
  }

  // Fallback to ReAct if Stratus not available
  if (config.type !== "react") {
    const reactFactory = registry.get("react");
    if (reactFactory) {
      console.warn(
        `[BrainRegistry] Brain type "${config.type}" not registered, falling back to "react"`,
      );
      return reactFactory({ ...config, type: "react" });
    }
  }

  throw new Error(
    `[BrainRegistry] No brain implementation registered for type "${config.type}" and no "react" fallback available. ` +
      `Registered types: ${[...registry.keys()].join(", ") || "(none)"}`,
  );
}

/**
 * Check if a brain type is registered.
 */
export function hasBrain(type: string): boolean {
  return registry.has(type);
}

/**
 * List all registered brain types.
 */
export function registeredBrains(): string[] {
  return [...registry.keys()];
}
