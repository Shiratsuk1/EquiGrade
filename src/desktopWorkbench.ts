import type { GradingArtifact, SmallQuestionBlankCropAudit, SubquestionResult } from "../shared/types.js";

export interface SubquestionCropLookupContext {
  result: {
    subquestions: SubquestionResult[];
    smallQuestionAudit?: {
      crops?: SmallQuestionBlankCropAudit[];
    };
  };
  artifacts?: GradingArtifact[];
}

/**
 * 伴侣视口（TemplateInspector）与批改结果的作答切片匹配纯函数
 */
export function findSubquestionCropArtifact(
  subq: SubquestionResult,
  record: SubquestionCropLookupContext
): GradingArtifact | undefined {
  const cropAudit = record.result.smallQuestionAudit?.crops?.find(
    (c) => c.subquestionId === subq.id
  );
  return record.artifacts?.find((a) => {
    if (cropAudit?.artifactFileName && a.fileName === cropAudit.artifactFileName) {
      return true;
    }
    const cleanSubqId = subq.id.replace(/[^a-zA-Z0-9]/g, "");
    const cleanFileName = a.fileName.toLowerCase();
    return (
      cleanFileName.includes(subq.id.toLowerCase()) ||
      (cleanSubqId.length > 0 && cleanFileName.includes(cleanSubqId.toLowerCase()))
    );
  });
}
