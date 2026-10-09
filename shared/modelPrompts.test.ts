import { describe, expect, it } from "vitest";
import { ACTIVE_MODEL_ROUTE_DEFINITIONS } from "./modelRouting.js";
import { getBuiltInSystemPrompt, getBuiltInSystemPromptVariants } from "./modelPrompts.js";

describe("model prompt catalog", () => {
  it("provides a visible built-in prompt for every active model route", () => {
    for (const definition of ACTIVE_MODEL_ROUTE_DEFINITIONS) {
      const variants = getBuiltInSystemPromptVariants(definition.key);
      expect(variants.length).toBeGreaterThan(0);
      expect(variants.every((variant) => variant.prompt.trim().length > 0)).toBe(true);
    }
  });

  it("keeps rubric prompt previews aligned with the question type", () => {
    const large = getBuiltInSystemPrompt("rubric_structure_vision", "large");
    const small = getBuiltInSystemPrompt("rubric_structure_vision", "small");

    expect(large).toContain("当前题型为大题");
    expect(small).toContain("当前题型为小题");
    expect(large).not.toBe(small);
  });

  it("shows the actual safeguards for the active grading stages", () => {
    expect(getBuiltInSystemPrompt("large_question_answer_triage")).toContain("PaddleOCR");
    expect(getBuiltInSystemPrompt("large_question_point_review")).toContain("awardedScore");
    expect(getBuiltInSystemPrompt("small_question_reconstruction")).toContain("作答还原模型");
    expect(getBuiltInSystemPrompt("small_question_grading_text")).toContain("评分点证据协议");
  });

  it("keeps the Responses Agent prompt OCR-free and single-agent", () => {
    const prompt = getBuiltInSystemPrompt("large_question_responses_agent");

    expect(prompt).toContain("完全不使用 OCR");
    expect(prompt).toContain("inspect_page_tiles");
    expect(prompt).toContain("inspect_page_region");
    expect(prompt).toContain("WebP q90");
    expect(prompt).toContain("后端无条件满分");
    expect(prompt).toContain("相对于完整学生答卷整页的 0–1000 归一化 region");
    expect(prompt).toContain("region 始终必须使用完整学生答卷整页坐标");
    expect(prompt).toContain("严禁返回相对于局部 crop 的坐标");
    expect(prompt).not.toContain("PaddleOCR");
    expect(prompt).not.toContain("子 Agent");
  });
});
