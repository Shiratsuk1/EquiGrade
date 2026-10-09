import type { QuestionType } from "../shared/types.js";
import { RUBRIC_WORKFLOW_PROMPTS } from "../shared/modelPrompts.js";

export interface RubricWorkflowPolicy {
  questionType: QuestionType;
  structureSystem: string;
  structurePrompt: string;
  refinementSystem: string;
}

/** 大题评分标准的独立提示词入口，后续可单独演进而不影响小题。 */
export const LARGE_QUESTION_RUBRIC_POLICY: RubricWorkflowPolicy = {
  questionType: "large",
  ...RUBRIC_WORKFLOW_PROMPTS.large
};

/** 小题评分标准的独立提示词入口，故意不复用大题 policy 对象。 */
export const SMALL_QUESTION_RUBRIC_POLICY: RubricWorkflowPolicy = {
  questionType: "small",
  ...RUBRIC_WORKFLOW_PROMPTS.small
};

export function rubricWorkflowPolicy(questionType: QuestionType): RubricWorkflowPolicy {
  return questionType === "small" ? SMALL_QUESTION_RUBRIC_POLICY : LARGE_QUESTION_RUBRIC_POLICY;
}
