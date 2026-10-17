import { describe, expect, it } from "vitest";
import type { SubquestionResult } from "../shared/types.js";
import { findSubquestionCropArtifact, type SubquestionCropLookupContext } from "./desktopWorkbench";

function createSubquestion(id: string, title: string, score: number, maxScore: number): SubquestionResult {
  return {
    id,
    title,
    score,
    maxScore,
    finalAnswerStatus: score >= maxScore ? "correct" : "incorrect",
    decisions: [],
    deductions: []
  };
}

describe("desktop workbench - latest result & crop presentation", () => {
  it("matches crop artifact using smallQuestionAudit.crops metadata when present", () => {
    const subq = createSubquestion("1", "第(1)问", 2, 2);

    const record: SubquestionCropLookupContext = {
      result: {
        subquestions: [subq],
        smallQuestionAudit: {
          crops: [
            {
              subquestionId: "1",
              title: "(1)",
              coordinate: [100, 200, 300, 400],
              hasAnswer: true,
              artifactFileName: "small-blank-1-crop.webp",
              cropWidth: 260,
              cropHeight: 89
            }
          ]
        }
      },
      artifacts: [
        {
          id: "art-1",
          fileName: "small-blank-1-crop.webp",
          mimeType: "image/webp",
          bytes: 4096,
          category: "material",
          url: "/api/artifacts/art-1"
        },
        {
          id: "art-2",
          fileName: "small-blank-2-crop.webp",
          mimeType: "image/webp",
          bytes: 4120,
          category: "material",
          url: "/api/artifacts/art-2"
        }
      ]
    };

    const match = findSubquestionCropArtifact(subq, record);
    expect(match).toBeDefined();
    expect(match?.fileName).toBe("small-blank-1-crop.webp");
    expect(match?.url).toBe("/api/artifacts/art-1");
  });

  it("falls back to matching subquestion id inside file name if audit artifactFileName is omitted", () => {
    const subq = createSubquestion("2", "第(2)问", 2, 2);

    const record: SubquestionCropLookupContext = {
      result: {
        subquestions: [subq]
      },
      artifacts: [
        {
          id: "art-q2",
          fileName: "subquestion-2-final-answer.webp",
          mimeType: "image/webp",
          bytes: 3800,
          category: "material",
          url: "/api/artifacts/art-q2"
        }
      ]
    };

    const match = findSubquestionCropArtifact(subq, record);
    expect(match).toBeDefined();
    expect(match?.id).toBe("art-q2");
  });

  it("returns undefined cleanly when neither audit nor artifact name matches", () => {
    const subq = createSubquestion("99", "第(99)问", 0, 2);

    const record: SubquestionCropLookupContext = {
      result: {
        subquestions: [subq]
      },
      artifacts: [
        {
          id: "art-1",
          fileName: "small-blank-1-crop.webp",
          mimeType: "image/webp",
          bytes: 4096,
          category: "material",
          url: "/api/artifacts/art-1"
        }
      ]
    };

    const match = findSubquestionCropArtifact(subq, record);
    expect(match).toBeUndefined();
  });
});
