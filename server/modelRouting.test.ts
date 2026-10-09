import { describe, expect, it } from "vitest";
import { applyModelRouteSystemPrompt, createDefaultModelRoutes, mergeModelRoutes } from "../shared/modelRouting.js";
import type { ModelConfigInput } from "../shared/types.js";
import { resolveModelRoute } from "./modelRouting.js";

const config: ModelConfigInput = {
  name: "routing-test",
  baseUrl: "https://teacher.example.test/v1",
  apiKey: "teacher-key",
  visionModel: "teacher-vision",
  textModel: "teacher-text",
  reviewBaseUrl: "https://review.example.test/v1",
  reviewApiKey: "review-key",
  reviewModel: "review-vision",
  timeoutMs: 300_000,
  maxRetries: 2,
  maxConcurrency: 2,
  maxOutputTokens: 4096,
  unreadableReviewThreshold: 2,
  teacherReasoningEffort: "medium",
  reviewReasoningEffort: "low",
  supportsJsonSchema: true,
  supportsJsonObject: false,
  supportsBase64Images: true,
  enabled: true
};

describe("model routing", () => {
  it("creates migrated defaults from the legacy global fields", () => {
    const routes = createDefaultModelRoutes(config);
    expect(routes.large_question_answer_triage).toMatchObject({ endpoint: "teacher", model: "teacher-vision" });
    expect(routes.large_question_point_review).toMatchObject({ endpoint: "review", model: "review-vision" });
    expect(routes.small_question_grading_text).toMatchObject({ endpoint: "teacher", model: "teacher-text" });
  });

  it("uses a route override and keeps the global retry budget as the upper bound", () => {
    const routed = resolveModelRoute({
      ...config,
      modelRoutes: mergeModelRoutes({
        ...config,
        modelRoutes: {
          large_question_answer_triage: {
            endpoint: "review",
            model: "review-triage",
            timeoutMs: 120_000,
            maxRetries: 5,
            maxOutputTokens: 8192,
            reasoningEffort: "high"
          }
        }
      })
    }, "large_question_answer_triage");

    expect(routed.model).toBe("review-triage");
    expect(routed.config.baseUrl).toBe(config.reviewBaseUrl);
    expect(routed.config.apiKey).toBe(config.reviewApiKey);
    expect(routed.config.timeoutMs).toBe(120_000);
    expect(routed.config.maxRetries).toBe(config.maxRetries);
    expect(routed.config.maxOutputTokens).toBe(8192);
    expect(routed.reasoningEffort).toBe("high");
  });

  it("fails a review route without an independent review credential", () => {
    expect(() => resolveModelRoute({ ...config, reviewApiKey: "" }, "large_question_point_review"))
      .toThrow("局部审验模型缺少独立 API Key");
  });

  it("allows a review route override without requiring the legacy global review model", () => {
    const routed = resolveModelRoute({
      ...config,
      reviewModel: "",
      modelRoutes: {
        large_question_point_review: {
          endpoint: "review",
          model: "review-point-only"
        }
      }
    }, "large_question_point_review");

    expect(routed.model).toBe("review-point-only");
    expect(routed.config.apiKey).toBe(config.reviewApiKey);
  });

  it("treats an empty route model as inheritance instead of breaking config saves", () => {
    const routes = mergeModelRoutes({
      ...config,
      modelRoutes: {
        large_question_answer_triage: {
          endpoint: "teacher",
          model: ""
        },
        large_question_visual_review: {
          endpoint: "review",
          model: ""
        }
      }
    });

    expect(routes.large_question_answer_triage.model).toBe(config.visionModel);
    expect(routes.large_question_visual_review.model).toBe(config.reviewModel);
  });

  it("applies route prompt adjustments without changing the default prompt when empty", () => {
    expect(applyModelRouteSystemPrompt("内置提示词", undefined)).toBe("内置提示词");
    expect(applyModelRouteSystemPrompt("内置提示词", { systemPrompt: "只补充本步骤要求" }))
      .toContain("内置提示词\n\n【教师模型设置·本步骤追加指令】\n只补充本步骤要求");
    expect(applyModelRouteSystemPrompt("内置提示词", { systemPrompt: "完全自定义", systemPromptMode: "replace" }))
      .toBe("完全自定义");
    expect(applyModelRouteSystemPrompt("内置提示词", { systemPrompt: "   " }))
      .toBe("内置提示词");
  });

  it("exposes the configured route prompt to the resolved workflow route", () => {
    const routed = resolveModelRoute({
      ...config,
      modelRoutes: {
        large_question_answer_triage: {
          endpoint: "teacher",
          model: config.visionModel,
          systemPrompt: "补充首轮转录要求",
          systemPromptMode: "append"
        }
      }
    }, "large_question_answer_triage");

    expect(routed.systemPrompt).toBe("补充首轮转录要求");
    expect(routed.systemPromptMode).toBe("append");
  });
});
