import { describe, expect, it } from "vitest";
import {
  compactDirectVisionGradeJsonSchema,
  directVisionGradeJsonSchema,
  directVisualReviewJsonSchema,
  evidenceJsonSchema,
  finalAnswerJudgementsJsonSchema,
  largeQuestionAnswerTriageJsonSchema,
  largeQuestionPointReviewJsonSchema,
  localNumericAnswerReviewJsonSchema,
  processJudgementJsonSchema,
  processJudgementWithCommentaryJsonSchema,
  rubricJsonSchema,
  responsesAgentGradeJsonSchema,
  responsesAgentVerifierJsonSchema,
  smallQuestionGradeJsonSchema,
  studentAnswerReconstructionJsonSchema,
  teacherCommentaryJsonSchema,
  unreadableLocalReviewJsonSchema
} from "./schemas.js";

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
};

function findMissingRequiredFields(schema: JsonSchemaNode, path = "root"): string[] {
  const missing: string[] = [];
  if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const property of Object.keys(schema.properties)) {
      if (!required.has(property)) missing.push(`${path}.${property}`);
    }
  }
  for (const [property, child] of Object.entries(schema.properties ?? {})) {
    missing.push(...findMissingRequiredFields(child, `${path}.properties.${property}`));
  }
  if (schema.items) missing.push(...findMissingRequiredFields(schema.items, `${path}.items`));
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    missing.push(...findMissingRequiredFields(child, `${path}.anyOf[${index}]`));
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    missing.push(...findMissingRequiredFields(child, `${path}.oneOf[${index}]`));
  }
  return missing;
}

describe("strict model JSON Schemas", () => {
  it("requires every declared object property for provider strict mode", () => {
    const schemas = {
      compactDirectVisionGradeJsonSchema,
      directVisionGradeJsonSchema,
      directVisualReviewJsonSchema,
      evidenceJsonSchema,
      finalAnswerJudgementsJsonSchema,
      largeQuestionAnswerTriageJsonSchema,
      largeQuestionPointReviewJsonSchema,
      localNumericAnswerReviewJsonSchema,
      processJudgementJsonSchema,
      processJudgementWithCommentaryJsonSchema,
      rubricJsonSchema,
      responsesAgentGradeJsonSchema,
      responsesAgentVerifierJsonSchema,
      smallQuestionGradeJsonSchema,
      studentAnswerReconstructionJsonSchema,
      teacherCommentaryJsonSchema,
      unreadableLocalReviewJsonSchema
    };
    const missing = Object.entries(schemas).flatMap(([name, schema]) => findMissingRequiredFields(schema as unknown as JsonSchemaNode, name));
    expect(missing).toEqual([]);
  });
});
