import type {
  ModelConfigInput,
  ModelRouteConfig,
  ModelRouteEndpoint,
  ModelRouteKey,
  TeacherReasoningEffort
} from "../shared/types.js";
import { mergeModelRoutes } from "../shared/modelRouting.js";
import { resolveReviewModelConfig } from "./modelClient.js";

export interface ResolvedModelRoute {
  routeKey: ModelRouteKey;
  endpoint: ModelRouteEndpoint;
  model: string;
  reasoningEffort: TeacherReasoningEffort | undefined;
  systemPrompt: string | undefined;
  systemPromptMode: ModelRouteConfig["systemPromptMode"];
  config: ModelConfigInput;
}

function routeConfig(config: ModelConfigInput, routeKey: ModelRouteKey): ModelRouteConfig {
  const routes = mergeModelRoutes(config);
  const route = routes[routeKey];
  if (!route || !route.model.trim()) {
    throw new Error(`批改链路 ${routeKey} 未配置模型`);
  }
  return route;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number, integer = false): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const normalized = integer ? Math.floor(value) : value;
  return Math.min(maximum, Math.max(minimum, normalized));
}

/**
 * Resolve a route into the legacy ModelConfigInput shape consumed by
 * modelClient. This keeps the transport contract centralized while allowing
 * each workflow call to select its own endpoint, model, prompt adjustment and limits.
 */
export function resolveModelRoute(config: ModelConfigInput, routeKey: ModelRouteKey): ResolvedModelRoute {
  const route = routeConfig(config, routeKey);
  const baseConfig = route.endpoint === "review" ? resolveReviewModelConfig(config, route.model) : config;
  const fallbackReasoning = route.endpoint === "review"
    ? config.reviewReasoningEffort
    : config.teacherReasoningEffort;
  const effectiveMaxRetries = route.maxRetries === undefined
    ? config.maxRetries
    : Math.min(config.maxRetries, boundedNumber(route.maxRetries, config.maxRetries, 0, 5, true));
  const effectiveConfig: ModelConfigInput = {
    ...baseConfig,
    timeoutMs: boundedNumber(route.timeoutMs, config.timeoutMs, 1_000, 300_000, true),
    maxRetries: effectiveMaxRetries,
    maxOutputTokens: boundedNumber(route.maxOutputTokens, config.maxOutputTokens, 256, 65_536, true)
  };
  return {
    routeKey,
    endpoint: route.endpoint,
    model: route.model.trim(),
    reasoningEffort: route.reasoningEffort ?? fallbackReasoning,
    systemPrompt: route.systemPrompt?.trim() || undefined,
    systemPromptMode: route.systemPromptMode,
    config: effectiveConfig
  };
}
