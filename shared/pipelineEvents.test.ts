import { describe, expect, it } from "vitest";
import type { PipelineEvent } from "./electron.js";
import type { SystemLogEntry } from "./types.js";
import {
  cleanPipelineError,
  isConciseLogEntry,
  isConcisePipelineEvent,
  pipelineEventLabel,
  pipelineEventTone
} from "./pipelineEvents.js";

describe("pipelineEvents", () => {
  describe("cleanPipelineError", () => {
    it("strips remote IPC error prefixes and whitespace", () => {
      expect(cleanPipelineError("Error invoking remote method 'controlPipeline': Error: 批改已停止")).toBe("批改已停止");
      expect(cleanPipelineError("Error: 未找到题目标题")).toBe("未找到题目标题");
      expect(cleanPipelineError("普通网络连接超时")).toBe("普通网络连接超时");
      expect(cleanPipelineError(undefined)).toBe("");
    });
  });

  describe("pipelineEventTone", () => {
    it("classifies error events as error", () => {
      expect(pipelineEventTone({ type: "plugin_preflight_failed" })).toBe("error");
      expect(pipelineEventTone({ type: "page_failed" })).toBe("error");
      expect(pipelineEventTone({ type: "pipeline_question_mismatch_rejected" })).toBe("error");
    });

    it("classifies warning and retry events as warning", () => {
      expect(pipelineEventTone({ type: "page_review_flagged" })).toBe("warning");
      expect(pipelineEventTone({ type: "page_marked_excellent" })).toBe("warning");
      expect(pipelineEventTone({ type: "page_retry" })).toBe("warning");
      expect(pipelineEventTone({ type: "pipeline_paused" })).toBe("warning");
    });

    it("classifies completion events as success", () => {
      expect(pipelineEventTone({ type: "page_completed" })).toBe("success");
      expect(pipelineEventTone({ type: "pipeline_completed" })).toBe("success");
    });

    it("classifies ongoing process events as active", () => {
      expect(pipelineEventTone({ type: "image_extracted" })).toBe("active");
      expect(pipelineEventTone({ type: "grading_completed" })).toBe("active");
      expect(pipelineEventTone({ type: "score_writing" })).toBe("active");
    });
  });

  describe("pipelineEventLabel", () => {
    it("formats grading_completed with detailed summary and subquestion scores", () => {
      const event: PipelineEvent = {
        type: "grading_completed",
        score: 4,
        maxScore: 6,
        summary: "得分 4/6分 ((1):「C」✓ [2/2分]，(2):「2.4」✓ [2/2分]，(3):「A」✗ [0/2分])"
      };
      expect(pipelineEventLabel(event)).toBe("智能批改结果：得分 4/6分 ((1):「C」✓ [2/2分]，(2):「2.4」✓ [2/2分]，(3):「A」✗ [0/2分])");
    });

    it("formats score_writing with local recomputed score and segment scores", () => {
      const event: PipelineEvent = {
        type: "score_writing",
        score: 4,
        maxScore: 6,
        segments: [
          { id: "1", title: "(1)", score: 2, maxScore: 2, points: [] },
          { id: "2", title: "(2)", score: 2, maxScore: 2, points: [] },
          { id: "3", title: "(3)", score: 0, maxScore: 2, points: [] }
        ]
      };
      expect(pipelineEventLabel(event)).toBe("本地计分确认 4 / 6 分 ((1) 2/2分，(2) 2/2分，(3) 0/2分)，写入网页评分框");
    });

    it("formats page_completed with subquestion breakdown and review flag note", () => {
      const event: PipelineEvent = {
        type: "page_completed",
        score: 3,
        maxScore: 4,
        requiresReview: true,
        segments: [
          { id: "1", title: "(1)", score: 2, maxScore: 2, points: [] },
          { id: "2", title: "(2)", score: 1, maxScore: 2, points: [] }
        ]
      };
      expect(pipelineEventLabel(event)).toBe("已提交 3 / 4 分 ((1) 2/2分，(2) 1/2分)（已标记复核）");
    });
  });

  describe("isConcisePipelineEvent - 4-message lifecycle & noise filtering", () => {
    it("strictly preserves the 4 key milestones in a normal single-question lifecycle", () => {
      const questionLifecycle: PipelineEvent[] = [
        { type: "image_extracted", pageKey: "page-1" },
        { type: "grading_completed", score: 4, maxScore: 4, summary: "(1): A [2/2分]" },
        { type: "score_writing", score: 4, maxScore: 4 },
        { type: "page_completed", score: 4, maxScore: 4 }
      ];

      const retained = questionLifecycle.filter(isConcisePipelineEvent);
      expect(retained).toHaveLength(4);
      expect(retained.map((e) => e.type)).toEqual([
        "image_extracted",
        "grading_completed",
        "score_writing",
        "page_completed"
      ]);
    });

    it("filters out noisy micro-phase steps and heartbeat preflight successes", () => {
      expect(isConcisePipelineEvent({ type: "pipeline_phase", phase: "extracting" })).toBe(false);
      expect(isConcisePipelineEvent({ type: "plugin_preflight_completed" })).toBe(false);
      expect(isConcisePipelineEvent({ type: "pipeline_template_bound" })).toBe(false);
      expect(isConcisePipelineEvent({ type: "pipeline_template_restored" })).toBe(false);
    });

    it("unconditionally preserves errors, warnings, retries, and review signals", () => {
      expect(isConcisePipelineEvent({ type: "plugin_preflight_failed", reason: "控件未找到" })).toBe(true);
      expect(isConcisePipelineEvent({ type: "page_failed", reason: "写分超时" })).toBe(true);
      expect(isConcisePipelineEvent({ type: "page_retry", attempt: 1, maxAttempts: 3 })).toBe(true);
      expect(isConcisePipelineEvent({ type: "page_review_flagged", score: 2, maxScore: 4 })).toBe(true);
      expect(isConcisePipelineEvent({ type: "page_marked_excellent" })).toBe(true);
      expect(isConcisePipelineEvent({ type: "pipeline_paused" })).toBe(true);
      expect(isConcisePipelineEvent({ type: "pipeline_started" })).toBe(true);
      expect(isConcisePipelineEvent({ type: "pipeline_completed" })).toBe(true);
    });
  });

  describe("isConciseLogEntry", () => {
    it("retains any entry with error/warning level or failed status", () => {
      const errorEntry: SystemLogEntry = {
        id: "log-1",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "error",
        status: "failed",
        scope: "model",
        step: "call:completion",
        message: "API Key 无效"
      };
      expect(isConciseLogEntry(errorEntry)).toBe(true);

      const warningEntry: SystemLogEntry = {
        id: "log-2",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "warning",
        status: "completed",
        scope: "system",
        step: "network_jitter",
        message: "检测到网络轻微波动"
      };
      expect(isConciseLogEntry(warningEntry)).toBe(true);

      const discrepancyProgressEntry: SystemLogEntry = {
        id: "log-2b",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "warning",
        status: "progress",
        scope: "grading",
        step: "small_question_discrepancy_detected",
        message: "(3)初检出现分歧或疑点，正在调起思考预算拉满的深度终审模型(同时传入切片与全景)"
      };
      expect(isConciseLogEntry(discrepancyProgressEntry)).toBe(false);
    });

    it("delegates pipeline:* entries to isConcisePipelineEvent", () => {
      const milestoneEntry: SystemLogEntry = {
        id: "log-3",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "progress",
        scope: "system",
        step: "pipeline:grading_completed",
        message: "智能批改完成",
        details: { type: "grading_completed", score: 4, maxScore: 4 }
      };
      expect(isConciseLogEntry(milestoneEntry)).toBe(true);

      const noiseEntry: SystemLogEntry = {
        id: "log-4",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "progress",
        scope: "system",
        step: "pipeline:plugin_preflight_completed",
        message: "站点控件检查通过",
        details: { type: "plugin_preflight_completed" }
      };
      expect(isConciseLogEntry(noiseEntry)).toBe(false);
    });

    it("hides normal internal model calls and scoring logs", () => {
      const normalModelCall: SystemLogEntry = {
        id: "log-5",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "completed",
        scope: "model",
        step: "call:model_call",
        message: "POST /chat/completions 200 OK"
      };
      expect(isConciseLogEntry(normalModelCall)).toBe(false);

      const internalScoring: SystemLogEntry = {
        id: "log-6",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "progress",
        scope: "scoring",
        step: "subquestion_score",
        message: "(1)：2/2分"
      };
      expect(isConciseLogEntry(internalScoring)).toBe(false);
    });

    it("retains template save/update entries and grading_completed milestones", () => {
      const templateSaved: SystemLogEntry = {
        id: "log-7",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "completed",
        scope: "storage",
        step: "template_saved",
        message: "评分标准已保存"
      };
      expect(isConciseLogEntry(templateSaved)).toBe(true);

      const serverGradingCompleted: SystemLogEntry = {
        id: "log-8",
        operationId: "op-1",
        timestamp: new Date().toISOString(),
        level: "info",
        status: "completed",
        scope: "grading",
        step: "grading_completed",
        message: "网页答卷 zhixue:69220964 批改完成：6/6分 ((1)「C」 [2/2分]，(2)「2.4」 [2/2分]，(3)「B」 [2/2分])"
      };
      expect(isConciseLogEntry(serverGradingCompleted)).toBe(true);
    });
  });
});
