import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  AnswerEvidence,
  AnswerLine,
  AppliedDeduction,
  FinalAnswerJudgement,
  GradingResult,
  ResponsesAgentAudit,
  ResponsesAgentImageAudit,
  ResponsesAgentLocalReviewAudit,
  ResponsesAgentRoundAudit,
  ResponsesAgentToolCallAudit,
  ResponsesAgentVerifierConflict,
  ResponsesAgentVerifierAudit,
  Rubric,
  RubricDecision,
  ResponsesAgentConfigInput,
  ModelConfigInput
} from "../shared/types.js";
import { applyModelRouteSystemPrompt } from "../shared/modelRouting.js";
import { getBuiltInSystemPrompt, LARGE_QUESTION_RESPONSES_AGENT_VERIFIER_SYSTEM, SCORE_POINT_EVIDENCE_PROTOCOL } from "../shared/modelPrompts.js";
import {
  responsesAgentGradeJsonSchema,
  responsesAgentGradeSchema,
  responsesAgentVerifierJsonSchema,
  responsesAgentVerifierSchema,
  unreadableLocalReviewJsonSchema,
  unreadableLocalReviewSchema,
  type ResponsesAgentGrade,
  type ResponsesAgentVerifier,
  type UnreadableLocalReview
} from "./schemas.js";
import { calculateGrade, createFallbackTeacherCommentary, normalizeEvidenceReferences } from "./gradingEngine.js";
import { normalizeFinalAnswerJudgement } from "./finalAnswerNormalization.js";
import { combineFinalAnswerExpression } from "../shared/finalAnswer.js";
import { preprocessResponsesAgentImage } from "./imagePreprocess.js";
import type { GradingArtifactSource, GradingAgentArtifactSource } from "./gradingArtifactStore.js";
import type { LargeQuestionGradingImage, LargeQuestionGradingInput } from "./largeQuestionGrading.js";
import { callResponsesAgent, type ResponsesAgentFunctionCall, type ResponsesAgentImageInput, type ResponsesAgentToolDefinition } from "./responsesAgentClient.js";
import { logProgress, isOperationCancelled, throwIfOperationCancelled } from "./systemLog.js";

const GRID_ROWS = 4;
const GRID_COLUMNS = 4;
const COORDINATE_MAX = 1000;
const DEFAULT_MAX_TOOL_ROUNDS = 3;
const DEFAULT_MAX_REGIONS = 6;
const REGION_COORDINATE_TOLERANCE = 10;

type RegionSource = {
  callIds: ReadonlySet<string>;
  imageSha256: string;
  normalizedRegion: [number, number, number, number];
};

function regionIsContainedBySource(
  region: [number, number, number, number] | null,
  source: RegionSource | undefined
): boolean {
  if (!region || !source) return false;
  const [x, y, width, height] = region;
  const [sourceX, sourceY, sourceWidth, sourceHeight] = source.normalizedRegion;
  return x >= Math.max(0, sourceX - REGION_COORDINATE_TOLERANCE)
    && y >= Math.max(0, sourceY - REGION_COORDINATE_TOLERANCE)
    && x + width <= Math.min(COORDINATE_MAX, sourceX + sourceWidth + REGION_COORDINATE_TOLERANCE)
    && y + height <= Math.min(COORDINATE_MAX, sourceY + sourceHeight + REGION_COORDINATE_TOLERANCE);
}

interface AgentImageRecord {
  imageId: string;
  role: "student" | "question" | "reference" | "grid";
  label: string;
  buffer: Buffer;
  mimeType: "image/webp";
  audit?: ResponsesAgentImageAudit;
}

interface AgentRegionResult {
  regionId: string;
  kind: "tile" | "region";
  normalizedRegion: [number, number, number, number];
  pixelRegion: [number, number, number, number];
  buffer?: Buffer;
  error?: string;
  deduplicated?: boolean;
}

interface AgentToolExecution {
  output: Array<Record<string, unknown>>;
  audit: ResponsesAgentToolCallAudit;
  regions: AgentRegionResult[];
}

interface AgentGradeResult {
  result: GradingResult;
  artifactSource: GradingArtifactSource;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function toModelImage(record: AgentImageRecord): ResponsesAgentImageInput {
  return {
    mimeType: "image/webp",
    base64: record.buffer.toString("base64"),
    label: record.label,
    imageId: record.imageId
  };
}

function imageSource(record: AgentImageRecord): LargeQuestionGradingImage {
  return {
    mimeType: "image/webp",
    base64: record.buffer.toString("base64"),
    label: record.label
  };
}

function normalizedToPixels(region: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const [x, y, w, h] = region;
  const left = Math.min(width - 1, Math.max(0, Math.floor((x / COORDINATE_MAX) * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor((y / COORDINATE_MAX) * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil(((x + w) / COORDINATE_MAX) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil(((y + h) / COORDINATE_MAX) * height)));
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
}

function canonicalRegion(values: number[]): [number, number, number, number] | null {
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = values;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > COORDINATE_MAX || y + height > COORDINATE_MAX) return null;
  return [
    Math.round(x * 10) / 10,
    Math.round(y * 10) / 10,
    Math.round(width * 10) / 10,
    Math.round(height * 10) / 10
  ];
}

function tileRegion(tileId: string): [number, number, number, number] | null {
  const match = /^r([1-4])c([1-4])$/i.exec(tileId.trim());
  if (!match) return null;
  const row = Number(match[1]) - 1;
  const column = Number(match[2]) - 1;
  return [column * (COORDINATE_MAX / GRID_COLUMNS), row * (COORDINATE_MAX / GRID_ROWS), COORDINATE_MAX / GRID_COLUMNS, COORDINATE_MAX / GRID_ROWS];
}

function regionKey(region: [number, number, number, number]): string {
  // A tile and an explicit rectangle covering that tile are the same visual
  // evidence and must consume only one of the six-region budget.
  return region.join(",");
}

function extractArguments(call: ResponsesAgentFunctionCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments) as unknown;
  } catch (error) {
    throw new Error(`工具 ${call.name} 参数不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`工具 ${call.name} 参数必须是对象`);
  return value as Record<string, unknown>;
}

function responseToolDefinitions(): ResponsesAgentToolDefinition[] {
  return [
    {
      name: "inspect_page_tiles",
      description: "只读查看学生答卷整页中的确定性网格单元。tileIds 使用 r1c1 至 r4c4；仅在整页难以辨认时请求必要单元。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tileIds"],
        properties: { tileIds: { type: "array", items: { type: "string", pattern: "^r[1-4]c[1-4]$" }, minItems: 1, maxItems: 6 } }
      }
    },
    {
      name: "inspect_page_region",
      description: "只读查看学生答卷指定矩形。x、y、width、height 为 0–1000 归一化坐标，矩形必须完全位于整页内。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "width", "height"],
        properties: {
          x: { type: "number", minimum: 0, maximum: 1000 },
          y: { type: "number", minimum: 0, maximum: 1000 },
          width: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          height: { type: "number", exclusiveMinimum: 0, maximum: 1000 }
        }
      }
    }
  ];
}

function toolOutputText(value: unknown): Record<string, unknown> {
  return { type: "input_text", text: JSON.stringify(value) };
}

async function createGridImage(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const labels = Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
    const row = Math.floor(index / GRID_COLUMNS);
    const column = index % GRID_COLUMNS;
    const x = Math.round((column / GRID_COLUMNS) * width);
    const y = Math.round((row / GRID_ROWS) * height);
    const tileWidth = Math.round(width / GRID_COLUMNS);
    const tileHeight = Math.round(height / GRID_ROWS);
    const id = `r${row + 1}c${column + 1}`;
    return `<rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" fill="none" stroke="#e11d48" stroke-width="3"/><rect x="${x + 4}" y="${y + 4}" width="${Math.max(36, id.length * 13)}" height="24" fill="#fff" fill-opacity="0.8"/><text x="${x + 8}" y="${y + 21}" font-family="Arial" font-size="16" font-weight="700" fill="#be123c">${id}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`);
  return sharp(buffer).composite([{ input: svg }]).webp({ quality: 90 }).toBuffer();
}

async function executeTool(
  call: ResponsesAgentFunctionCall,
  studentBuffer: Buffer,
  width: number,
  height: number,
  usedRegions: Set<string>,
  regionIdsByKey: Map<string, string>,
  maxRegions: number,
  artifacts: GradingAgentArtifactSource[],
): Promise<AgentToolExecution> {
  const regions: AgentRegionResult[] = [];
  let args: Record<string, unknown> = {};
  try {
    args = extractArguments(call);
    const requested: Array<{ kind: "tile" | "region"; region: [number, number, number, number]; label: string }> = [];
    if (call.name === "inspect_page_tiles") {
      const tileIds = Array.isArray(args.tileIds) ? args.tileIds.filter((value): value is string => typeof value === "string") : [];
      for (const tileId of tileIds) {
        const region = tileRegion(tileId);
        if (!region) throw new Error(`网格单元 ${tileId} 无效，必须使用 r1c1 至 r4c4`);
        requested.push({ kind: "tile", region, label: tileId.toLowerCase() });
      }
    } else if (call.name === "inspect_page_region") {
      const values = ["x", "y", "width", "height"].map((key) => Number(args[key]));
      const region = canonicalRegion(values);
      if (!region) throw new Error("局部矩形坐标无效：必须是 0–1000 范围内且不越界的正矩形");
      requested.push({ kind: "region", region, label: `region-${region.join("-")}` });
    } else {
      throw new Error(`未知只读工具：${call.name}`);
    }
    if (!requested.length) throw new Error(`${call.name} 没有可用的局部区域参数`);
    if (requested.length > maxRegions) throw new Error(`${call.name} 单次请求区域过多，最多可请求 ${maxRegions} 个区域`);
    for (const request of requested) {
      const key = regionKey(request.region);
      if (usedRegions.has(key)) {
        const duplicate: AgentRegionResult = {
          regionId: regionIdsByKey.get(key) ?? request.label,
          kind: request.kind,
          normalizedRegion: request.region,
          pixelRegion: normalizedToPixels(request.region, width, height),
          deduplicated: true
        };
        regions.push(duplicate);
        continue;
      }
      if (usedRegions.size >= maxRegions) {
        regions.push({
          regionId: request.label,
          kind: request.kind,
          normalizedRegion: request.region,
          pixelRegion: normalizedToPixels(request.region, width, height),
          error: `局部区域额度已用尽（最多 ${maxRegions} 个唯一区域）`
        });
        continue;
      }
      usedRegions.add(key);
      const pixelRegion = normalizedToPixels(request.region, width, height);
      // Reserve the canonical id before awaiting sharp so a parallel tool call
      // for the same rectangle can inherit it in the same Responses round.
      const regionId = `${request.kind}-${usedRegions.size}`;
      regionIdsByKey.set(key, regionId);
      try {
        const [left, top, cropWidth, cropHeight] = pixelRegion;
        const cropBuffer = await sharp(studentBuffer)
          .extract({ left, top, width: cropWidth, height: cropHeight })
          .webp({ quality: 90 })
          .toBuffer();
        const artifactFileName = `responses-agent-${regionId}.webp`;
        artifacts.push({ fileName: artifactFileName, mimeType: "image/webp", category: "agent_region", buffer: cropBuffer });
        regions.push({ regionId, kind: request.kind, normalizedRegion: request.region, pixelRegion, buffer: cropBuffer });
      } catch (error) {
        regions.push({ regionId, kind: request.kind, normalizedRegion: request.region, pixelRegion, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const content: Array<Record<string, unknown>> = [toolOutputText({
      ok: regions.every((region) => !region.error),
      regions: regions.map((region) => ({
        regionId: region.regionId,
        kind: region.kind,
        normalizedRegion: region.normalizedRegion,
        pixelRegion: region.pixelRegion,
        ...(region.error ? { error: region.error } : {}),
        ...(region.deduplicated ? { deduplicated: true } : {})
      }))
    })];
    for (const region of regions) {
      if (region.buffer) {
        content.push({ type: "input_image", image_url: `data:image/webp;base64,${region.buffer.toString("base64")}`, detail: "high" });
      }
    }
    const toolStatus = regions.some((region) => region.error)
      ? "failed" as const
      : regions.length > 0 && regions.every((region) => region.deduplicated)
        ? "deduplicated" as const
        : "completed" as const;
    const toolAudit = createToolAudit(call, args, regions, toolStatus, toolStatus === "completed" ? "已返回 WebP q90 局部图" : toolStatus === "deduplicated" ? "重复局部区域已去重" : "局部区域处理失败");
    return { output: content, audit: toolAudit, regions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const audit = createToolAudit(call, args, regions, "rejected", message);
    return {
      output: [toolOutputText({ ok: false, error: message, regions: [] })],
      audit,
      regions
    };
  }
}

function createToolAudit(
  call: ResponsesAgentFunctionCall,
  args: Record<string, unknown>,
  regions: AgentRegionResult[],
  status: ResponsesAgentToolCallAudit["status"],
  resultSummary: string
): ResponsesAgentToolCallAudit {
  const isKnownTool = call.name === "inspect_page_tiles" || call.name === "inspect_page_region";
  return {
    callId: call.callId,
    name: call.name === "inspect_page_tiles" ? "inspect_page_tiles" : call.name === "inspect_page_region" ? "inspect_page_region" : "unknown",
    ...(isKnownTool ? {} : { requestedName: call.name }),
    arguments: args,
    status,
    resultSummary,
    regions: regions.map((region) => ({
      regionId: region.regionId,
      kind: region.kind,
      normalizedRegion: region.normalizedRegion,
      pixelRegion: region.pixelRegion,
      imageSha256: region.buffer ? sha256(region.buffer) : "",
      mimeType: "image/webp",
      ...(region.buffer ? { artifactFileName: `responses-agent-${region.regionId}.webp` } : {}),
      sourceToolCallIds: [call.callId]
    })),
    durationMs: 0
  };
}

function buildFunctionCallOutputs(
  outputItems: unknown[],
  calls: readonly ResponsesAgentFunctionCall[],
  executions: readonly AgentToolExecution[]
): unknown[] {
  const outputCallIds = outputItems.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call") return [];
    const callId = (item as { call_id?: unknown }).call_id;
    return typeof callId === "string" ? [callId] : [];
  });
  const callIds = calls.map((call) => call.callId);
  if (outputCallIds.length !== calls.length || outputCallIds.some((callId, index) => callId !== callIds[index])) {
    throw new Error("Responses Agent function_call 输出项与 call_id 不一致，未重放工具结果");
  }
  if (executions.length !== calls.length) throw new Error("Responses Agent 工具执行结果数量与 function_call 不一致");
  return calls.map((call, index) => ({
    type: "function_call_output",
    call_id: call.callId,
    output: executions[index]!.output
  }));
}

function addDuration(audit: ResponsesAgentToolCallAudit, durationMs: number): ResponsesAgentToolCallAudit {
  return { ...audit, durationMs: Math.max(0, Math.round(durationMs)) };
}

function buildRegionSources(
  toolCalls: readonly ResponsesAgentToolCallAudit[]
): Map<string, RegionSource> {
  const regionSources = new Map<string, RegionSource>();
  for (const call of toolCalls) {
    if (call.status !== "completed" && call.status !== "deduplicated") continue;
    for (const region of call.regions) {
      const previous = regionSources.get(region.regionId);
      const imageSha256 = region.imageSha256 || previous?.imageSha256;
      // A deduplicated audit intentionally has no new image bytes.  Reuse the
      // first successful crop's hash while merging the later call id so a
      // transcription may legitimately cite either tool invocation.
      if (!imageSha256) continue;
      regionSources.set(region.regionId, {
        imageSha256,
        callIds: new Set([...(previous?.callIds ?? []), ...region.sourceToolCallIds]),
        normalizedRegion: previous?.normalizedRegion ?? region.normalizedRegion
      });
    }
  }
  return regionSources;
}

function collectValidTranscriptionLineIds(
  data: ResponsesAgentGrade,
  initialImageIds: ReadonlySet<string>,
  regionSources: ReadonlyMap<string, RegionSource>
): Set<string> {
  const validLineIds = new Set<string>();
  for (const line of data.transcription.lines) {
    const sourceImageId = line.sourceImageId.trim();
    const sourceRegion = regionSources.get(sourceImageId);
    const sourceIsInitial = initialImageIds.has(sourceImageId);
    const sourceToolCallIds = [...new Set(line.sourceToolCallIds.map((id) => id.trim()).filter(Boolean))];
    const lineRegion = canonicalRegion(line.region);
    const sourceRegionContainsLine = regionIsContainedBySource(lineRegion, sourceRegion);
    const validSource = sourceIsInitial
      ? sourceToolCallIds.length === 0
      : Boolean(sourceRegion && sourceRegion.imageSha256 && sourceToolCallIds.length > 0 && sourceToolCallIds.every((id) => sourceRegion.callIds.has(id)) && sourceRegionContainsLine);
    if (lineRegion && sourceImageId && validSource) validLineIds.add(line.id);
  }
  return validLineIds;
}

function isActiveVisualEvidence(line: AnswerLine | undefined): boolean {
  return Boolean(line && line.status === "active" && (line.text.trim() || line.latex?.trim()) && line.region);
}

function hasAuditableNotPresentEvidence(lines: readonly AnswerLine[], lineIds: readonly string[]): boolean {
  const uniqueLineIds = [...new Set(lineIds)];
  if (uniqueLineIds.length === 0) return false;
  const linesById = new Map(lines.map((line) => [line.id, line]));
  return uniqueLineIds.every((lineId) => {
    const line = linesById.get(lineId);
    const structuredAbsenceAudit = Boolean(
      line
      && line.status === "uncertain"
      && line.text.trim().startsWith("缺失审验锚点：")
      && line.region
    );
    if (structuredAbsenceAudit) return true;
    return Boolean(
      line
      && line.status !== "uncertain"
      && (line.text.trim() || line.latex?.trim())
      && line.confidence >= 0.6
      && line.region
    );
  });
}

function normalizeAgentOutput(
  data: ResponsesAgentGrade,
  input: LargeQuestionGradingInput,
  imageWidth: number,
  imageHeight: number,
  initialImageIds: ReadonlySet<string>,
  regionSources: ReadonlyMap<string, RegionSource>,
  reviewReasons: string[]
): { evidence: AnswerEvidence; finalAnswers: FinalAnswerJudgement[]; decisions: RubricDecision[]; deductions: AppliedDeduction[]; reviewItems: string[] } {
  const knownSubquestions = new Set(input.rubric.subquestions.map((item) => item.id));
  const points = new Map<string, Rubric["subquestions"][number]["scorePoints"][number]>(input.rubric.subquestions.flatMap((subquestion) => subquestion.scorePoints.map((point) => [`${subquestion.id}:${point.id}`, point] as const)));
  const seenLineIds = new Set<string>();
  const lines: AnswerLine[] = [];
  for (const raw of data.transcription.lines) {
    if (seenLineIds.has(raw.id)) {
      reviewReasons.push(`Responses Agent 重复返回视觉转录行 ${raw.id}，已保留第一条。`);
      continue;
    }
    seenLineIds.add(raw.id);
    const region = canonicalRegion(raw.region);
    const sourceImageId = raw.sourceImageId.trim();
    const sourceRegion = regionSources.get(sourceImageId);
    const sourceIsInitial = initialImageIds.has(sourceImageId);
    const toolSourceIds = [...new Set(raw.sourceToolCallIds.map((id) => id.trim()).filter(Boolean))];
    const sourceRegionContainsLine = regionIsContainedBySource(region, sourceRegion);
    const validSource = sourceIsInitial
      ? toolSourceIds.length === 0
      : Boolean(sourceRegion && sourceRegion.imageSha256 && toolSourceIds.length > 0 && toolSourceIds.every((id) => sourceRegion.callIds.has(id)) && sourceRegionContainsLine);
    if (!region || !sourceImageId || !validSource) {
      const sourceReason = !sourceImageId
        ? "缺少来源图像"
        : !validSource
          ? "来源图像或工具调用未通过审计关联校验"
          : "缺少有效归一化坐标";
      reviewReasons.push(`视觉转录行 ${raw.id}${sourceReason}，已标记不确定。`);
    }
    const status = !region || !sourceImageId || !validSource ? "uncertain" : raw.status;
    const confidence = !region || !sourceImageId || !validSource ? Math.min(raw.confidence, 0.49) : raw.confidence;
    lines.push({
      id: raw.id,
      text: raw.text,
      latex: raw.latex || undefined,
      region: region ? normalizedToPixels(region, imageWidth, imageHeight) : undefined,
      status,
      confidence,
      alternatives: raw.alternatives
    });
  }
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const finalAnswers: FinalAnswerJudgement[] = [];
  const seenAnswers = new Set<string>();
  for (const raw of data.finalAnswerJudgements) {
    if (!knownSubquestions.has(raw.subquestionId)) {
      reviewReasons.push(`Responses Agent 返回未知小问 ${raw.subquestionId}，已忽略。`);
      continue;
    }
    if (seenAnswers.has(raw.subquestionId)) {
      reviewReasons.push(`${raw.subquestionId} 重复返回最终答案，已保留第一条。`);
      continue;
    }
    seenAnswers.add(raw.subquestionId);
    const evidenceLineIds = raw.evidenceLineIds.filter((id) => lineById.has(id));
    if (raw.evidenceLineIds.some((id) => !lineById.has(id))) reviewReasons.push(`${raw.subquestionId}最终答案引用了不存在的视觉转录行，已标记复核。`);
    const usableEvidenceLineIds = evidenceLineIds.filter((id) => isActiveVisualEvidence(lineById.get(id)));
    if (raw.status === "correct" && usableEvidenceLineIds.length === 0) {
      reviewReasons.push(`${raw.subquestionId}判定为 correct 但没有有效 evidenceLineIds，仍按满分处理并标记人工复核。`);
    }
    if (raw.status === "incorrect" && (raw.evidenceLineIds.length !== evidenceLineIds.length || usableEvidenceLineIds.length === 0)) {
      reviewReasons.push(`${raw.subquestionId}判定为 incorrect 但没有完整、有效的 active 视觉证据，已降为 uncertain。`);
    }
    let finalAnswerStatus = raw.status;
    let finalAnswerConfidence = raw.confidence;
    if (raw.status === "incorrect" && (raw.evidenceLineIds.length !== evidenceLineIds.length || usableEvidenceLineIds.length === 0)) {
      finalAnswerStatus = "uncertain";
      finalAnswerConfidence = Math.min(raw.confidence, 0.49);
    }
    if (raw.status === "missing" && !hasAuditableNotPresentEvidence(lines, evidenceLineIds)) {
      reviewReasons.push(`${raw.subquestionId}判定为 missing 但没有可定位的缺失审验锚点，已降为 uncertain。`);
      finalAnswerStatus = "uncertain";
      finalAnswerConfidence = Math.min(raw.confidence, 0.49);
    }
    const normalized = normalizeFinalAnswerJudgement({
      ...raw,
      status: finalAnswerStatus,
      confidence: finalAnswerConfidence,
      evidenceLineIds,
      decisionSource: "teacher_model"
    });
    finalAnswers.push(normalized.judgement);
  }
  const decisions: RubricDecision[] = [];
  const seenPoints = new Set<string>();
  for (const raw of data.decisions) {
    const pointKey = `${raw.subquestionId}:${raw.pointId}`;
    const point = points.get(pointKey);
    if (!point) {
      reviewReasons.push(`Responses Agent 返回未知评分点 ${pointKey}，已忽略。`);
      continue;
    }
    if (seenPoints.has(pointKey)) {
      reviewReasons.push(`Responses Agent 重复返回评分点 ${pointKey}，已标记复核。`);
      continue;
    }
    seenPoints.add(pointKey);
    const evidenceLineIds = raw.evidenceLineIds.filter((id) => lineById.has(id));
    const invalidEvidence = raw.evidenceLineIds.length !== evidenceLineIds.length;
    const activeEvidenceLineIds = evidenceLineIds.filter((id) => isActiveVisualEvidence(lineById.get(id)));
    const statusNeedsVisualEvidence = raw.status === "satisfied" || raw.status === "not_satisfied";
    const missingAnchorAuditable = raw.status === "not_present" && !invalidEvidence && hasAuditableNotPresentEvidence(lines, evidenceLineIds);
    let status = raw.status;
    // A satisfied point is binary under the locked rubric and must receive the
    // point's full value. Only not_satisfied may carry a bounded partial score;
    // uncertain/absent states are normalized to zero below.
    let awardedScore = raw.status === "satisfied"
      ? point.score
      : raw.status === "not_satisfied"
        ? Math.max(0, Math.min(point.score, raw.awardedScore))
        : 0;
    let requiresReview = raw.requiresReview || invalidEvidence;
    let reviewReason: string | undefined = invalidEvidence ? "评分点引用了不存在的视觉转录行" : undefined;
    const contradictoryReviewFlag = raw.requiresReview
      && raw.status !== "unreadable"
      && raw.status !== "insufficient_evidence";
    if (contradictoryReviewFlag) {
      status = "unreadable";
      awardedScore = 0;
      requiresReview = true;
      reviewReason = "Responses Agent 同时返回明确评分状态和 requiresReview=true，必须先做局部视觉复查";
      reviewReasons.push(`评分点 ${pointKey}${reviewReason}，已改为 unreadable 并触发局部复查。`);
    }
    if (!contradictoryReviewFlag && statusNeedsVisualEvidence && (invalidEvidence || activeEvidenceLineIds.length === 0)) {
      status = "unreadable";
      awardedScore = 0;
      requiresReview = true;
      reviewReason = invalidEvidence
        ? "评分点引用了不存在或不完整的视觉转录行"
        : "评分点没有有效 active 视觉证据";
      reviewReasons.push(`评分点 ${pointKey}${reviewReason}，已改为 unreadable 并忽略模型分数。`);
    } else if (!contradictoryReviewFlag && (raw.status === "unreadable" || raw.status === "insufficient_evidence")) {
      status = "unreadable";
      awardedScore = 0;
      requiresReview = true;
      reviewReason = raw.status === "insufficient_evidence" ? "评分点证据不足" : "评分点卷面内容无法可靠辨认";
    } else if (!contradictoryReviewFlag && raw.status === "not_present" && (!missingAnchorAuditable || raw.awardedScore > 0)) {
      status = "unreadable";
      awardedScore = 0;
      requiresReview = true;
      reviewReason = !missingAnchorAuditable
        ? "not_present 缺少可定位的缺失审验锚点"
        : "not_present 不允许携带模型得分";
      reviewReasons.push(`评分点 ${pointKey}${reviewReason}，已改为 unreadable 并忽略模型分数。`);
    } else if (!contradictoryReviewFlag && raw.status === "not_present") {
      awardedScore = 0;
    }
    decisions.push({
      ...raw,
      status,
      evidenceLineIds,
      evidenceQuote: raw.evidenceQuote,
      awardedScore,
      requiresReview: requiresReview || status === "unreadable" || status === "insufficient_evidence",
      reviewReason,
      decisionSource: "model"
    });
  }
  const deductions: AppliedDeduction[] = data.appliedDeductions.flatMap((raw) => {
    const subquestion = input.rubric.subquestions.find((item) => item.id === raw.subquestionId);
    const rule = subquestion?.deductions.find((item) => item.id === raw.ruleId);
    if (!rule) {
      reviewReasons.push(`Responses Agent 返回未知扣分规则 ${raw.subquestionId}:${raw.ruleId}，已忽略。`);
      return [];
    }
    const uniqueEvidenceLineIds = [...new Set(raw.evidenceLineIds)];
    const uniqueEvidenceLineIdSet = new Set(uniqueEvidenceLineIds);
    const validEvidenceLineIds = uniqueEvidenceLineIds.filter((id) => {
      return isActiveVisualEvidence(lineById.get(id));
    });
    const validEvidenceLineIdSet = new Set(validEvidenceLineIds);
    const invalidEvidenceLineIds = [...uniqueEvidenceLineIdSet].filter((id) => !validEvidenceLineIdSet.has(id));
    if (invalidEvidenceLineIds.length > 0 || validEvidenceLineIds.length === 0) {
      const evidenceReason = validEvidenceLineIds.length === 0
        ? "没有有效 evidenceLineIds"
        : `包含无效 evidenceLineIds：${invalidEvidenceLineIds.join("、")}`;
      reviewReasons.push(`Responses Agent 扣分规则 ${raw.subquestionId}:${raw.ruleId}${evidenceReason}，已忽略扣分并标记复核。`);
      return [];
    }
    return [{ ...raw, evidenceLineIds: validEvidenceLineIds }];
  });
  const evidence: AnswerEvidence = normalizeEvidenceReferences({
    lines,
    finalAnswers: finalAnswers.flatMap((item) => item.evidenceLineIds.slice(0, 1).map((lineId) => ({
      subquestionId: item.subquestionId,
      lineId,
      expression: item.studentAnswer,
      confidence: item.confidence
    }))),
    ambiguities: data.transcription.ambiguities.map((item) => ({ lineId: item.lineId || undefined, reason: item.reason, scoreImpact: item.scoreImpact }))
  });
  const reviewItems = data.review_items.map((item) => `${item.subquestionId || "整卷"}：${item.reason}`);
  if (data.review_required) reviewReasons.push(...reviewItems.length ? reviewItems : ["Responses Agent 标记了需要人工复核，但未提供具体原因。"]);
  return { evidence, finalAnswers, decisions, deductions, reviewItems };
}

interface AgentLocalReviewTarget {
  key: string;
  subquestionId: string;
  pointId?: string;
  title: string;
  score: number;
  evidenceLineIds: string[];
  status: string;
  reason: string;
  studentAnswer?: string;
  expected?: string;
  pointType?: string;
  description?: string;
}

interface AgentLocalReviewImage {
  imageId: string;
  label: string;
  buffer: Buffer;
}

interface AgentLocalReviewApplication {
  normalized: ReturnType<typeof normalizeAgentOutput>;
  reviewedKeys: string[];
  missingKeys: string[];
  results: ResponsesAgentLocalReviewAudit["results"];
  reviewReasons: string[];
}

interface AgentLocalReviewOutcome {
  normalized: ReturnType<typeof normalizeAgentOutput>;
  audit: ResponsesAgentLocalReviewAudit;
  reviewReasons: string[];
}

function finalAnswerExpectedText(subquestion: Rubric["subquestions"][number]): string {
  return subquestion.finalAnswers
    .map((answer) => combineFinalAnswerExpression(answer.expression, answer.unit))
    .filter(Boolean)
    .join(" 或 ");
}

function buildAgentLocalReviewTargets(
  input: LargeQuestionGradingInput,
  normalized: ReturnType<typeof normalizeAgentOutput>
): AgentLocalReviewTarget[] {
  const targets: AgentLocalReviewTarget[] = [];
  const targetKeys = new Set<string>();
  const finalAnswersBySubquestion = new Map(normalized.finalAnswers.map((item) => [item.subquestionId, item]));
  const decisionsByPoint = new Map(normalized.decisions.map((item) => [`${item.subquestionId}:${item.pointId}`, item]));
  const addTarget = (target: AgentLocalReviewTarget) => {
    if (targetKeys.has(target.key)) return;
    targetKeys.add(target.key);
    targets.push(target);
  };

  for (const subquestion of input.rubric.subquestions) {
    const judgement = finalAnswersBySubquestion.get(subquestion.id);
    const finalActionableEvidenceLineIds = localReviewEvidenceLineIds(normalized.evidence, judgement?.evidenceLineIds ?? []);
    const finalNeedsReview = judgement?.status === "uncertain" && finalActionableEvidenceLineIds.length > 0;
    if (finalNeedsReview) {
      addTarget({
        key: `${subquestion.id}:final`,
        subquestionId: subquestion.id,
        title: `${subquestion.title}最终答案`,
        score: subquestion.maxScore,
        evidenceLineIds: finalActionableEvidenceLineIds,
        status: judgement?.status ?? "uncertain",
        reason: judgement?.reason ?? "主 Responses Agent 判定最终答案为 uncertain，需局部视觉复查确认。",
        studentAnswer: judgement?.studentAnswer,
        expected: finalAnswerExpectedText(subquestion)
      });
    }

    for (const point of subquestion.scorePoints) {
      const pointKey = `${subquestion.id}:${point.id}`;
      const decision = decisionsByPoint.get(pointKey);
      const actionablePointEvidenceLineIds = localReviewEvidenceLineIds(normalized.evidence, decision?.evidenceLineIds ?? []);
      const pointNeedsReview = Boolean(
        decision
        && (decision.status === "unreadable" || decision.status === "insufficient_evidence" || decision.requiresReview)
        && actionablePointEvidenceLineIds.length > 0
      );
      if (!pointNeedsReview) continue;
      addTarget({
        key: pointKey,
        subquestionId: subquestion.id,
        pointId: point.id,
        title: point.title,
        score: point.score,
        evidenceLineIds: actionablePointEvidenceLineIds,
        status: decision?.status ?? "unreadable",
        reason: decision?.reviewReason ?? decision?.reason ?? "主 Responses Agent 标记该评分点需局部视觉复查。",
        expected: point.expected,
        pointType: point.type,
        description: point.description
      });
    }
  }
  return targets;
}

function localReviewEvidenceLineIds(evidence: AnswerEvidence, lineIds: readonly string[]): string[] {
  const linesById = new Map(evidence.lines.map((line) => [line.id, line]));
  return [...new Set(lineIds.map((id) => id.trim()).filter(Boolean))].filter((lineId) => {
    const line = linesById.get(lineId);
    return Boolean(line && line.status !== "crossed_out" && line.region);
  });
}

async function createAgentLocalReviewCrop(
  imageBuffer: Buffer,
  width: number,
  height: number,
  evidence: AnswerEvidence,
  lineIds: readonly string[],
  imageId: string,
  label: string
): Promise<AgentLocalReviewImage | null> {
  if (!width || !height) return null;
  const regions = lineIds.flatMap((lineId) => {
    const region = evidence.lines.find((line) => line.id === lineId)?.region;
    if (!region || region.some((value) => !Number.isFinite(value))) return [];
    const [x, y, regionWidth, regionHeight] = region;
    if (regionWidth <= 0 || regionHeight <= 0) return [];
    return [[
      Math.max(0, Math.min(width - 1, x)),
      Math.max(0, Math.min(height - 1, y)),
      Math.max(1, Math.min(width, regionWidth)),
      Math.max(1, Math.min(height, regionHeight))
    ] as [number, number, number, number]];
  });
  if (!regions.length) return null;

  const minX = Math.min(...regions.map(([x]) => x));
  const minY = Math.min(...regions.map(([, y]) => y));
  const maxX = Math.max(...regions.map(([x, , regionWidth]) => Math.min(width, x + regionWidth)));
  const maxY = Math.max(...regions.map(([, y, , regionHeight]) => Math.min(height, y + regionHeight)));
  const padding = Math.max(24, Math.round(Math.max(maxX - minX, maxY - minY) * 0.18));
  const left = Math.max(0, Math.floor(minX - padding));
  const top = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(width, Math.ceil(maxX + padding));
  const bottom = Math.min(height, Math.ceil(maxY + padding));
  const cropWidth = Math.max(1, right - left);
  const cropHeight = Math.max(1, bottom - top);
  const scale = Math.min(4, 2200 / cropWidth, 2200 / cropHeight);
  const reviewBuffer = await sharp(imageBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({
      width: Math.max(1, Math.round(cropWidth * scale)),
      height: Math.max(1, Math.round(cropHeight * scale)),
      fit: "fill"
    })
    .webp({ quality: 90 })
    .toBuffer();
  return { imageId, label: `${label}（x=${left}, y=${top}, w=${cropWidth}, h=${cropHeight}）`, buffer: reviewBuffer };
}

function localReviewImageContent(image: AgentLocalReviewImage): Array<Record<string, unknown>> {
  return [
    { type: "input_text", text: `[${image.imageId}] ${image.label}` },
    { type: "input_image", image_url: `data:image/webp;base64,${image.buffer.toString("base64")}`, detail: "high" }
  ];
}

function buildAgentLocalReviewInput(
  input: LargeQuestionGradingInput,
  normalized: ReturnType<typeof normalizeAgentOutput>,
  targets: readonly AgentLocalReviewTarget[],
  reviewImages: readonly AgentLocalReviewImage[]
): unknown[] {
  const targetSummary = targets.map((target) => ({
    key: target.key,
    subquestionId: target.subquestionId,
    ...(target.pointId ? { pointId: target.pointId } : {}),
    title: target.title,
    score: target.score,
    status: target.status,
    reason: target.reason,
    studentAnswer: target.studentAnswer ?? "",
    expected: target.expected ?? "",
    ...(target.pointId ? { type: target.pointType, description: target.description } : {}),
    evidenceLineIds: target.evidenceLineIds
  }));
  const transcription = normalized.evidence.lines.map((line) => ({
    id: line.id,
    text: line.text,
    latex: line.latex,
    status: line.status,
    confidence: line.confidence,
    region: line.region
  }));
  const text = [
    "你是阅卷后端强制调用的局部视觉复查模型。主 Responses Agent 已经把下列项目标记为 uncertain、无法辨认、缺少证据或漏返回；你必须重新查看学生答卷整页和局部放大图，不能盲从第一次结论。",
    "禁止根据题目、参考答案或评分标准推导并补写学生没有写出的答案；只能使用图片中实际可见的学生笔迹。学生确实写了答案时，必须尽量读取并在 studentAnswer/evidenceLineIds 中回写。",
    `题目文字：${input.questionText?.trim() || "题目内容见评分标准"}`,
    `参考答案文字：${input.referenceText?.trim() || "无"}`,
    `锁定评分标准 JSON：${JSON.stringify(input.rubric)}`,
    `复查目标 JSON：${JSON.stringify(targetSummary)}`,
    `可引用的既有视觉转录行 JSON：${JSON.stringify(transcription)}`,
    "finalAnswers 中每个目标最多返回一条。correct/incorrect 必须引用当前既有、未划掉且有区域的 evidenceLineIds；missing 必须引用能证明已搜索相关区域的可定位证据；仍看不清时返回 uncertain 并设置 requiresReview=true。reviews 中每个目标评分点最多返回一条；satisfied/not_satisfied 需要可定位视觉证据，not_present 需要可定位缺失审验锚点，仍看不清时返回 unreadable 并设置 requiresReview=true。",
    "不得臆造 evidenceLineIds，不得返回复查目标之外的评分点或小问。"
  ].join("\n\n");
  return [{
    role: "user",
    content: [
      { type: "input_text", text },
      ...reviewImages.flatMap(localReviewImageContent)
    ]
  }];
}

function unresolvedLocalFinalAnswer(
  target: AgentLocalReviewTarget,
  original: FinalAnswerJudgement | undefined,
  evidenceLineIds: string[],
  reason: string,
  confidence: number
): FinalAnswerJudgement {
  return {
    subquestionId: target.subquestionId,
    status: "uncertain",
    evidenceLineIds: evidenceLineIds.length ? evidenceLineIds : original?.evidenceLineIds ?? [],
    studentAnswer: original?.studentAnswer ?? target.studentAnswer ?? "",
    referenceAnswer: original?.referenceAnswer ?? target.expected ?? "",
    reason,
    confidence: Math.min(confidence, 0.49),
    decisionSource: "unreadable_local_review"
  };
}

function applyAgentLocalReview(
  input: LargeQuestionGradingInput,
  normalized: ReturnType<typeof normalizeAgentOutput>,
  targets: readonly AgentLocalReviewTarget[],
  parsed: UnreadableLocalReview
): AgentLocalReviewApplication {
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const finalReviewByKey = new Map<string, UnreadableLocalReview["finalAnswers"][number]>();
  for (const review of parsed.finalAnswers) {
    const key = `${review.subquestionId}:final`;
    if (targetByKey.has(key) && !finalReviewByKey.has(key)) finalReviewByKey.set(key, review);
  }
  const pointReviewByKey = new Map<string, UnreadableLocalReview["reviews"][number]>();
  for (const review of parsed.reviews) {
    const key = `${review.subquestionId}:${review.pointId}`;
    if (targetByKey.has(key) && !pointReviewByKey.has(key)) pointReviewByKey.set(key, review);
  }

  const reviewedKeys = new Set<string>();
  const missingKeys: string[] = [];
  const reviewReasons: string[] = [];
  const results: ResponsesAgentLocalReviewAudit["results"] = [];
  const finalAnswersBySubquestion = new Map(normalized.finalAnswers.map((item) => [item.subquestionId, item]));
  const nextFinalAnswers = [...normalized.finalAnswers];
  const finalAnswerIndex = new Map(nextFinalAnswers.map((item, index) => [item.subquestionId, index]));

  for (const target of targets.filter((item) => !item.pointId)) {
    const original = finalAnswersBySubquestion.get(target.subquestionId);
    const review = finalReviewByKey.get(target.key);
    if (!review) {
      missingKeys.push(target.key);
      reviewReasons.push(`${target.key} 未被局部视觉复查结果覆盖，保留人工复核。`);
      if (original) {
        const index = finalAnswerIndex.get(target.subquestionId);
        if (index !== undefined) nextFinalAnswers[index] = unresolvedLocalFinalAnswer(target, original, original.evidenceLineIds, "局部视觉复查未返回该小问的结论，不能确认学生最终答案。", 0.49);
      }
      continue;
    }
    reviewedKeys.add(target.key);
    const suppliedIds = localReviewEvidenceLineIds(normalized.evidence, review.evidenceLineIds);
    const fallbackIds = localReviewEvidenceLineIds(normalized.evidence, target.evidenceLineIds);
    const evidenceLineIds = review.evidenceLineIds.length ? suppliedIds : fallbackIds;
    const hasVisualEvidence = evidenceLineIds.length > 0;
    const hasMissingAudit = review.status === "missing" && hasAuditableNotPresentEvidence(normalized.evidence.lines, evidenceLineIds);
    const accepted = !review.requiresReview
      && (review.status === "correct" || review.status === "incorrect" ? hasVisualEvidence : review.status === "missing" ? hasMissingAudit : false);
    const judgement = accepted
      ? {
          subquestionId: target.subquestionId,
          status: review.status,
          evidenceLineIds,
          studentAnswer: review.studentAnswer,
          referenceAnswer: original?.referenceAnswer ?? target.expected ?? "",
          reason: review.reason,
          confidence: review.confidence,
          decisionSource: "unreadable_local_review" as const
        }
      : unresolvedLocalFinalAnswer(
          target,
          original,
          evidenceLineIds,
          `局部视觉复查后仍无法可靠确认：${review.reason}`,
          review.confidence
        );
    const index = finalAnswerIndex.get(target.subquestionId);
    if (index !== undefined) nextFinalAnswers[index] = judgement;
    else nextFinalAnswers.push(judgement);
    results.push({
      key: target.key,
      subquestionId: target.subquestionId,
      status: judgement.status,
      confidence: judgement.confidence,
      requiresReview: !accepted
    });
    if (!accepted) reviewReasons.push(`${target.key} 局部视觉复查后仍需人工复核：${review.reason}`);
  }

  const nextDecisions = [...normalized.decisions];
  const decisionIndex = new Map(nextDecisions.map((item, index) => [`${item.subquestionId}:${item.pointId}`, index]));
  for (const target of targets.filter((item) => Boolean(item.pointId))) {
    const pointId = target.pointId!;
    const point = input.rubric.subquestions.find((item) => item.id === target.subquestionId)?.scorePoints.find((item) => item.id === pointId);
    if (!point) continue;
    const key = target.key;
    const original = normalized.decisions.find((item) => `${item.subquestionId}:${item.pointId}` === key);
    const review = pointReviewByKey.get(key);
    if (!review) {
      missingKeys.push(key);
      reviewReasons.push(`${key} 未被局部视觉复查结果覆盖，保留人工复核。`);
      continue;
    }
    reviewedKeys.add(key);
    const suppliedIds = localReviewEvidenceLineIds(normalized.evidence, review.evidenceLineIds);
    const fallbackIds = localReviewEvidenceLineIds(normalized.evidence, target.evidenceLineIds);
    const evidenceLineIds = review.evidenceLineIds.length ? suppliedIds : fallbackIds;
    const hasVisualEvidence = evidenceLineIds.length > 0;
    const hasMissingAudit = review.status === "not_present" && hasAuditableNotPresentEvidence(normalized.evidence.lines, evidenceLineIds);
    const accepted = !review.requiresReview
      && (review.status === "satisfied" || review.status === "not_satisfied" ? hasVisualEvidence : review.status === "not_present" ? hasMissingAudit : false);
    const nextDecision: RubricDecision = accepted
      ? {
          ...(original ?? {
            subquestionId: target.subquestionId,
            pointId,
            evidenceLineIds: [],
            evidenceQuote: "",
            reason: "",
            confidence: 0,
            requiresReview: true,
            awardedScore: 0
          }),
          status: review.status,
          evidenceLineIds,
          evidenceQuote: review.evidenceQuote,
          reason: review.reason,
          confidence: review.confidence,
          requiresReview: false,
          reviewReason: undefined,
          decisionSource: "unreadable_local_review",
          awardedScore: review.status === "satisfied" ? point.score : 0
        }
      : {
          ...(original ?? {
            subquestionId: target.subquestionId,
            pointId,
            evidenceLineIds: [],
            evidenceQuote: "",
            reason: "",
            confidence: 0,
            requiresReview: true,
            awardedScore: 0
          }),
          status: "unreadable",
          evidenceLineIds,
          evidenceQuote: review.evidenceQuote || original?.evidenceQuote || "",
          reason: `局部视觉复查后仍无法可靠确认：${review.reason}`,
          confidence: Math.min(review.confidence, 0.49),
          requiresReview: true,
          reviewReason: review.reason,
          decisionSource: "unreadable_local_review",
          awardedScore: 0
        };
    const index = decisionIndex.get(key);
    if (index !== undefined) nextDecisions[index] = nextDecision;
    else nextDecisions.push(nextDecision);
    results.push({
      key,
      subquestionId: target.subquestionId,
      pointId,
      status: nextDecision.status,
      confidence: nextDecision.confidence,
      requiresReview: nextDecision.requiresReview
    });
    if (!accepted) reviewReasons.push(`${key} 局部视觉复查后仍需人工复核：${review.reason}`);
  }

  return {
    normalized: { ...normalized, finalAnswers: nextFinalAnswers, decisions: nextDecisions },
    reviewedKeys: [...reviewedKeys],
    missingKeys,
    results,
    reviewReasons
  };
}

async function runAgentLocalReview(
  config: ModelConfigInput,
  agentConfig: ResponsesAgentConfigInput,
  input: LargeQuestionGradingInput,
  normalized: ReturnType<typeof normalizeAgentOutput>,
  images: readonly AgentImageRecord[],
  width: number,
  height: number,
  artifacts: GradingAgentArtifactSource[],
  operationId: string,
  round: number
): Promise<AgentLocalReviewOutcome> {
  const targets = buildAgentLocalReviewTargets(input, normalized);
  const model = agentConfig.model;
  const baseAudit = {
    model,
    baseUrl: agentConfig.baseUrl,
    targetKeys: targets.map((target) => target.key),
    cropCount: 0,
    cropArtifactFileNames: [] as string[],
    results: [] as ResponsesAgentLocalReviewAudit["results"]
  };
  if (!targets.length) {
    return {
      normalized,
      audit: { status: "not_needed", durationMs: 0, reviewedKeys: [], ...baseAudit },
      reviewReasons: []
    };
  }

  const studentImage = images.find((image) => image.role === "student");
  const gridImage = images.find((image) => image.role === "grid");
  if (!studentImage) throw new Error("Responses Agent 局部复查缺少学生答卷整页图");
  const cropImages: AgentLocalReviewImage[] = [];
  const cropArtifactFileNames: string[] = [];
  const lineIdsBySubquestion = new Map<string, Set<string>>();
  for (const target of targets) {
    const lineIds = lineIdsBySubquestion.get(target.subquestionId) ?? new Set<string>();
    target.evidenceLineIds.forEach((lineId) => lineIds.add(lineId));
    lineIdsBySubquestion.set(target.subquestionId, lineIds);
  }
  for (const [subquestionId, lineIds] of lineIdsBySubquestion) {
    const crop = await createAgentLocalReviewCrop(
      studentImage.buffer,
      width,
      height,
      normalized.evidence,
      [...lineIds],
      `local-review-${subquestionId}`,
      `局部复查 ${subquestionId}`
    );
    if (!crop) continue;
    const artifactFileName = `responses-agent-local-review-${subquestionId}.webp`;
    cropImages.push(crop);
    cropArtifactFileNames.push(artifactFileName);
    artifacts.push({ fileName: artifactFileName, mimeType: "image/webp", category: "agent_region", buffer: crop.buffer });
  }
  if (!cropImages.length) {
    return {
      normalized,
      audit: { status: "not_needed", durationMs: 0, reviewedKeys: [], ...baseAudit },
      reviewReasons: []
    };
  }
  const reviewImages: AgentLocalReviewImage[] = [
    { imageId: studentImage.imageId, label: "学生答卷整页（局部复查上下文）", buffer: studentImage.buffer },
    ...(gridImage ? [{ imageId: gridImage.imageId, label: gridImage.label, buffer: gridImage.buffer }] : []),
    ...cropImages
  ];
  const startedAt = performance.now();
  logProgress(operationId, "model", "responses_agent_local_review_started", "主结果命中不确定或缺少证据，已强制启动局部视觉复查", {
    model,
    targetKeys: targets.map((target) => target.key),
    cropCount: cropImages.length,
    cropArtifactFileNames
  });
  try {
    const response = await callResponsesAgent({
      config: { ...config, responsesAgent: agentConfig },
      baseUrl: agentConfig.baseUrl,
      apiKey: agentConfig.apiKey!,
      model,
      instructions: `你是学生答卷局部复查模型。你只负责重新观察目标区域并返回严格结构化复查结论，不负责修改评分标准或编造学生答案。

${SCORE_POINT_EVIDENCE_PROTOCOL}

最终答案复查规则：correct、incorrect、missing 必须有图片可审计依据；无法确认时必须是 uncertain 且 requiresReview=true。评分点复查规则：satisfied、not_satisfied、not_present 必须有对应的可定位视觉依据；无法确认时必须是 unreadable 且 requiresReview=true。`,
      input: buildAgentLocalReviewInput(input, normalized, targets, reviewImages),
      images: reviewImages.map((image) => ({
        mimeType: "image/webp" as const,
        base64: image.buffer.toString("base64"),
        label: image.label,
        imageId: image.imageId
      })),
      schemaName: "responses_agent_uncertain_local_review",
      schema: unreadableLocalReviewJsonSchema,
      validate: (value) => unreadableLocalReviewSchema.parse(value),
      reasoningEffort: agentConfig.reasoningEffort,
      operationId,
      round
    });
    throwIfOperationCancelled(operationId);
    if (!response.data) throw new Error("局部视觉复查模型未返回结构化结论");
    const parsed = unreadableLocalReviewSchema.parse(response.data);
    const applied = applyAgentLocalReview(input, normalized, targets, parsed);
    const audit: ResponsesAgentLocalReviewAudit = {
      status: "completed",
      ...baseAudit,
      ...(response.responseId ? { responseId: response.responseId } : {}),
      durationMs: Math.round(performance.now() - startedAt),
      reviewedKeys: applied.reviewedKeys,
      cropCount: cropImages.length,
      cropArtifactFileNames,
      results: applied.results,
      rawResponse: response.raw
    };
    logProgress(operationId, "grading", "responses_agent_local_review_completed", "局部视觉复查完成，已将可确认结论回写评分输入", {
      model,
      targetKeys: audit.targetKeys,
      reviewedKeys: audit.reviewedKeys,
      missingKeys: applied.missingKeys,
      results: audit.results,
      durationMs: audit.durationMs
    }, applied.missingKeys.length || applied.reviewReasons.length ? "warning" : "success");
    return { normalized: applied.normalized, audit, reviewReasons: applied.reviewReasons };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    const durationMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    const audit: ResponsesAgentLocalReviewAudit = {
      status: "failed",
      ...baseAudit,
      durationMs,
      reviewedKeys: [],
      cropCount: cropImages.length,
      cropArtifactFileNames,
      results: [],
      error: message
    };
    logProgress(operationId, "grading", "responses_agent_local_review_failed", "局部视觉复查失败，保留不确定结论并需要人工复核", {
      model,
      targetKeys: audit.targetKeys,
      cropCount: cropImages.length,
      error: message
    }, "warning");
    return {
      normalized,
      audit,
      reviewReasons: [`Responses Agent 局部视觉复查失败：${message}`]
    };
  }
}

function buildInitialInput(
  input: LargeQuestionGradingInput,
  images: AgentImageRecord[]
): unknown[] {
  const text = [
    "请批改这份大题答卷。输出前先通读学生整页图；只有看不清时调用只读局部工具，工具返回后继续判断。",
    `题目文字：${input.questionText?.trim() || "题目内容见题目图片"}`,
    `参考答案文字：${input.referenceText?.trim() || "参考答案内容见参考答案图片"}`,
    `锁定评分标准 JSON：${JSON.stringify(input.rubric)}`,
    `学生小问 ID：${input.rubric.subquestions.map((item) => item.id).join("、")}`,
    "所有 evidenceLineIds、sourceImageId 和 sourceToolCallIds 必须来自当前输入或工具回传，不能臆造。"
  ].join("\n\n");
  return [{
    role: "user",
    content: [
      { type: "input_text", text },
      ...images.flatMap((image) => [
        { type: "input_text", text: `[${image.imageId}] ${image.label}` },
        { type: "input_image", image_url: `data:image/webp;base64,${image.buffer.toString("base64")}`, detail: "high" }
      ])
    ]
  }];
}

function independentVerifierIsNeeded(data: ResponsesAgentGrade, reviewReasons: readonly string[]): boolean {
  return data.review_required
    || data.review_items.length > 0
    || data.finalAnswerJudgements.some((item) => item.status === "uncertain" || item.confidence < 0.75)
    || data.decisions.some((item) => item.requiresReview || item.status === "unreadable" || item.status === "insufficient_evidence")
    || reviewReasons.length > 0;
}

function buildVerifierInput(
  input: LargeQuestionGradingInput,
  images: AgentImageRecord[],
  data: ResponsesAgentGrade
): unknown[] {
  const candidate = {
    finalAnswerJudgements: data.finalAnswerJudgements.map((item) => ({
      subquestionId: item.subquestionId,
      status: item.status,
      studentAnswer: item.studentAnswer,
      evidenceLineIds: item.evidenceLineIds,
      confidence: item.confidence,
      reason: item.reason
    })),
    decisions: data.decisions.map((item) => ({
      subquestionId: item.subquestionId,
      pointId: item.pointId,
      status: item.status,
      evidenceLineIds: item.evidenceLineIds,
      evidenceQuote: item.evidenceQuote,
      requiresReview: item.requiresReview,
      reason: item.reason
    })),
    transcription: data.transcription.lines.map((line) => ({
      id: line.id,
      subquestionId: line.subquestionId,
      text: line.text,
      region: line.region,
      status: line.status,
      confidence: line.confidence
    })),
    reviewItems: data.review_items
  };
  const text = [
    "请独立审验这份大题批改候选，不要重新计分，不要修改评分标准。",
    `题目文字：${input.questionText?.trim() || "题目内容见题目图片"}`,
    `参考答案文字：${input.referenceText?.trim() || "参考答案内容见参考答案图片"}`,
    `锁定评分标准 JSON：${JSON.stringify(input.rubric)}`,
    `主教师 Agent 候选（仅作待核对对象，不是事实）：${JSON.stringify(candidate)}`,
    "请直接查看图片核对候选；仅在发现真实冲突或证据不足时标记 review_required。"
  ].join("\n\n");
  return [{
    role: "user",
    content: [
      { type: "input_text", text },
      ...images.flatMap((image) => [
        { type: "input_text", text: `[${image.imageId}] ${image.label}` },
        { type: "input_image", image_url: `data:image/webp;base64,${image.buffer.toString("base64")}`, detail: "high" }
      ])
    ]
  }];
}

function normalizeVerifierConflicts(
  data: ResponsesAgentVerifier,
  validEvidenceLineIds: ReadonlySet<string>
): { conflicts: ResponsesAgentVerifierConflict[]; invalidEvidenceConflictCount: number } {
  let invalidEvidenceConflictCount = 0;
  const conflicts = data.conflicts.map((conflict) => {
    const uniqueEvidenceLineIds = [...new Set(conflict.evidenceLineIds.map((id) => id.trim()).filter(Boolean))];
    const validIds = uniqueEvidenceLineIds.filter((id) => validEvidenceLineIds.has(id));
    const invalidIds = uniqueEvidenceLineIds.filter((id) => !validEvidenceLineIds.has(id));
    const missingEvidence = uniqueEvidenceLineIds.length === 0;
    if (invalidIds.length > 0 || missingEvidence) invalidEvidenceConflictCount += 1;
    const evidenceWarning = missingEvidence
      ? "独立审验冲突未提供有效 evidenceLineIds"
      : invalidIds.length > 0
        ? `独立审验冲突引用了不存在或未通过来源审计的视觉转录行：${invalidIds.join("、")}`
        : "";
    return {
      subquestionId: conflict.subquestionId,
      ...(conflict.pointId ? { pointId: conflict.pointId } : {}),
      kind: conflict.kind,
      primaryStatus: conflict.primaryStatus,
      verifierStatus: conflict.verifierStatus,
      evidenceLineIds: validIds,
      reason: evidenceWarning ? `${conflict.reason}；${evidenceWarning}` : conflict.reason
    };
  });
  return { conflicts, invalidEvidenceConflictCount };
}

async function runIndependentVerifier(
  config: ModelConfigInput,
  agentConfig: ResponsesAgentConfigInput,
  input: LargeQuestionGradingInput,
  images: AgentImageRecord[],
  data: ResponsesAgentGrade,
  validEvidenceLineIds: ReadonlySet<string>,
  operationId: string,
  round: number
): Promise<ResponsesAgentVerifierAudit> {
  const baseUrl = agentConfig.verifierBaseUrl?.trim() || agentConfig.baseUrl;
  const apiKey = agentConfig.verifierApiKey?.trim() || agentConfig.apiKey?.trim() || "";
  const model = agentConfig.verifierModel?.trim() || agentConfig.model;
  const startedAt = performance.now();
  if (!apiKey) {
    return {
      status: "failed",
      model,
      baseUrl,
      durationMs: Math.round(performance.now() - startedAt),
      reviewRequired: true,
      conflicts: [],
      error: "独立高风险审验模型未配置 API Key"
    };
  }
  try {
    const response = await callResponsesAgent({
      config: {
        ...config,
        responsesAgent: {
          ...agentConfig,
          baseUrl,
          apiKey,
          model,
          independentVerifierEnabled: false
        }
      },
      baseUrl,
      apiKey,
      model,
      instructions: LARGE_QUESTION_RESPONSES_AGENT_VERIFIER_SYSTEM,
      input: buildVerifierInput(input, images, data),
      images: images.map(toModelImage),
      schemaName: "responses_agent_independent_verifier",
      schema: responsesAgentVerifierJsonSchema,
      validate: (value) => responsesAgentVerifierSchema.parse(value),
      reasoningEffort: agentConfig.verifierReasoningEffort ?? agentConfig.reasoningEffort,
      operationId,
      round
    });
    const verifierData = response.data;
    if (!verifierData) throw new Error("独立审验模型未返回结构化意见");
    const normalizedConflicts = normalizeVerifierConflicts(verifierData, validEvidenceLineIds);
    const conflicts = normalizedConflicts.conflicts;
    return {
      status: "completed",
      model,
      baseUrl,
      ...(response.responseId ? { responseId: response.responseId } : {}),
      durationMs: Math.round(performance.now() - startedAt),
      verdict: verifierData.verdict,
      reviewRequired: verifierData.review_required || verifierData.verdict !== "agree" || conflicts.length > 0 || normalizedConflicts.invalidEvidenceConflictCount > 0,
      summary: verifierData.summary,
      conflicts,
      rawResponse: response.raw
    };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return {
      status: "failed",
      model,
      baseUrl,
      durationMs: Math.round(performance.now() - startedAt),
      reviewRequired: true,
      conflicts: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function maxAgentLimits(config: ResponsesAgentConfigInput | undefined) {
  return {
    maxToolRounds: Math.min(3, Math.max(0, Math.floor(config?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS))),
    maxRegions: Math.min(6, Math.max(0, Math.floor(config?.maxRegions ?? DEFAULT_MAX_REGIONS)))
  };
}

function emptyFallbackResult(input: LargeQuestionGradingInput, model: string, durationMs: number, audit: ResponsesAgentAudit, reason: string): GradingResult {
  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence: { lines: [], finalAnswers: [], ambiguities: [] },
    finalAnswerJudgements: [],
    decisions: [],
    appliedDeductions: [],
    modelName: model,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs,
    unreadableReviewThreshold: 0.5,
    operationId: undefined,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.status = "needs_review";
  result.reviewReasons = [...new Set([...result.reviewReasons, reason])];
  result.gradingPipeline = "large_question_responses_agent";
  result.responsesAgentAudit = audit;
  result.teacherCommentary = createFallbackTeacherCommentary(result);
  return result;
}

export async function gradeLargeQuestionResponsesAgent(
  config: ModelConfigInput,
  input: LargeQuestionGradingInput,
  operationId: string
): Promise<AgentGradeResult> {
  const agentConfig = config.responsesAgent;
  if (!agentConfig?.baseUrl?.trim() || !agentConfig.model?.trim() || !agentConfig.apiKey?.trim()) {
    throw new Error("Responses Agent 链路未完整配置 Base URL、模型和 API Key");
  }
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const limits = maxAgentLimits(agentConfig);
  const artifacts: GradingAgentArtifactSource[] = [];
  const images: AgentImageRecord[] = [];
  const reviewReasons: string[] = [];
  let width = 0;
  let height = 0;
  let studentImage: AgentImageRecord;
  try {
    const prepared = await preprocessResponsesAgentImage({ imageBuffer: input.imageBuffer, mimeType: input.mimeType, grayscale: true });
    width = prepared.audit.width ?? 0;
    height = prepared.audit.height ?? 0;
    studentImage = { imageId: "student-page", role: "student", label: "学生答卷整页（灰度增强 WebP q90）", buffer: prepared.buffer, mimeType: "image/webp", audit: prepared.audit };
    images.push(studentImage);
    artifacts.push({ fileName: "responses-agent-student-page.webp", mimeType: "image/webp", category: "agent_region", buffer: prepared.buffer });
    for (let index = 0; index < (input.questionImages ?? []).length; index += 1) {
      const image = input.questionImages![index]!;
      const preparedMaterial = await preprocessResponsesAgentImage({ imageBuffer: Buffer.from(image.base64, "base64"), mimeType: image.mimeType, grayscale: false });
      const record: AgentImageRecord = { imageId: `question-${index + 1}`, role: "question", label: image.label ?? `题目图片 ${index + 1}`, buffer: preparedMaterial.buffer, mimeType: "image/webp", audit: preparedMaterial.audit };
      images.push(record);
      artifacts.push({ fileName: `responses-agent-question-${index + 1}.webp`, mimeType: "image/webp", category: "agent_region", buffer: preparedMaterial.buffer });
    }
    for (let index = 0; index < (input.referenceImages ?? []).length; index += 1) {
      const image = input.referenceImages![index]!;
      const preparedMaterial = await preprocessResponsesAgentImage({ imageBuffer: Buffer.from(image.base64, "base64"), mimeType: image.mimeType, grayscale: false });
      const record: AgentImageRecord = { imageId: `reference-${index + 1}`, role: "reference", label: image.label ?? `参考答案图片 ${index + 1}`, buffer: preparedMaterial.buffer, mimeType: "image/webp", audit: preparedMaterial.audit };
      images.push(record);
      artifacts.push({ fileName: `responses-agent-reference-${index + 1}.webp`, mimeType: "image/webp", category: "agent_region", buffer: preparedMaterial.buffer });
    }
    const gridBuffer = await createGridImage(studentImage.buffer, width, height);
    const grid: AgentImageRecord = { imageId: "student-grid", role: "grid", label: "学生答卷确定性网格索引（WebP q90，仅用于定位）", buffer: gridBuffer, mimeType: "image/webp" };
    images.push(grid);
    artifacts.push({ fileName: "responses-agent-student-grid.webp", mimeType: "image/webp", category: "agent_region", buffer: gridBuffer });
  } catch (error) {
    const audit: ResponsesAgentAudit = {
      provider: "openai_responses",
      workflow: "responses_agent",
      store: false,
      model: agentConfig.model,
      baseUrl: agentConfig.baseUrl,
      startedAt,
      durationMs: Math.round(performance.now() - startedAtMs),
      maxToolRounds: limits.maxToolRounds,
      maxRegions: limits.maxRegions,
      rounds: [],
      inputImages: [],
      transcriptionLineCount: 0,
      finalAnswerCount: 0,
      finalBasis: [],
      reviewReasons: [error instanceof Error ? error.message : String(error)]
    };
    const result = emptyFallbackResult(input, agentConfig.model, audit.durationMs, audit, audit.reviewReasons[0]!);
    return { result, artifactSource: { preprocessedStudentAnswer: { buffer: input.imageBuffer, mimeType: input.mimeType, fileName: input.fileName }, questionImages: input.questionImages ?? [], referenceImages: input.referenceImages ?? [], questionText: input.questionText, referenceText: input.referenceText, rubric: input.rubric } };
  }
  const agentRoute = config.modelRoutes?.large_question_responses_agent;
  const instructions = applyModelRouteSystemPrompt(getBuiltInSystemPrompt("large_question_responses_agent"), agentRoute);
  const agentImages = images.map(toModelImage);
  let inputItems = buildInitialInput(input, images);
  const usedRegions = new Set<string>();
  const regionIdsByKey = new Map<string, string>();
  const rounds: ResponsesAgentRoundAudit[] = [];
  let allToolCalls: ResponsesAgentToolCallAudit[] = [];
  let finalData: ResponsesAgentGrade | undefined;
  let totalToolRounds = 0;
  let lastResponseReasoningCount = 0;
  for (let attempt = 1; attempt <= limits.maxToolRounds + 1; attempt += 1) {
    throwIfOperationCancelled(operationId);
    const toolsAllowed = totalToolRounds < limits.maxToolRounds;
    let response;
    try {
      response = await callResponsesAgent({
        config: { ...config, responsesAgent: agentConfig },
        baseUrl: agentConfig.baseUrl,
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        instructions,
        input: inputItems,
        images: agentImages,
        // Once the tool-round budget is exhausted, omit both fields entirely.
        // Sending tool_choice:"none" still changes the provider contract and
        // some Responses-compatible gateways reject a strict final schema
        // when a tool declaration is present.
        ...(toolsAllowed ? { tools: responseToolDefinitions(), toolChoice: "auto" } : {}),
        schemaName: "responses_agent_large_question_grade",
        schema: responsesAgentGradeJsonSchema,
        validate: (value) => responsesAgentGradeSchema.parse(value),
        reasoningEffort: agentConfig.reasoningEffort,
        operationId,
        round: attempt
      });
    } catch (error) {
      if (isOperationCancelled(error)) throw error;
      reviewReasons.push(`Responses Agent 第 ${attempt} 轮调用失败：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    lastResponseReasoningCount += response.reasoningItemCount;
    const toolCalls = response.functionCalls;
    rounds.push({
      round: attempt,
      ...(response.responseId ? { responseId: response.responseId } : {}),
      ...(response.status ? { status: response.status } : {}),
      durationMs: response.durationMs,
      outputItemTypes: response.outputItems.flatMap((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string" ? [(item as { type: string }).type] : []),
      functionCallIds: toolCalls.map((call) => call.callId),
      toolCalls: [],
      rawResponse: response.raw
    });
    if (["incomplete", "failed", "cancelled"].includes(String(response.status ?? "").toLowerCase())) {
      reviewReasons.push(`Responses Agent 第 ${attempt} 轮返回不可用状态 ${response.status}，该轮结果已作废。`);
      break;
    }
    if (response.data) {
      finalData = response.data;
      break;
    }
    if (!toolCalls.length) {
      reviewReasons.push(`Responses Agent 第 ${attempt} 轮未返回工具调用或最终结构化结果。`);
      break;
    }
    if (!toolsAllowed) {
      reviewReasons.push(`Responses Agent 在工具额度用尽后仍请求工具，已拒绝该请求并需要人工复核。`);
      break;
    }
    const toolExecutions = await Promise.all(toolCalls.map(async (call) => {
      const executionStartedAt = performance.now();
      const execution = await executeTool(call, studentImage.buffer, width, height, usedRegions, regionIdsByKey, limits.maxRegions, artifacts);
      return { ...execution, audit: addDuration(execution.audit, performance.now() - executionStartedAt) };
    }));
    const executedAudits = toolExecutions.map((execution) => execution.audit);
    rounds[rounds.length - 1]!.toolCalls = executedAudits;
    allToolCalls = [...allToolCalls, ...executedAudits];
    if (toolExecutions.some((execution) => execution.audit.status === "failed" || execution.audit.status === "rejected" || execution.regions.some((region) => region.error))) {
      reviewReasons.push(`Responses Agent 第 ${attempt} 轮局部工具存在真实失败、越界或拒绝，需人工复核。`);
    }
    try {
      inputItems = [
        // Responses requires the complete prior output item list, including
        // reasoning items, to be replayed before matching function outputs.
        ...inputItems,
        ...response.outputItems,
        ...buildFunctionCallOutputs(response.outputItems, toolCalls, toolExecutions)
      ];
    } catch (error) {
      reviewReasons.push(error instanceof Error ? error.message : String(error));
      break;
    }
    totalToolRounds += 1;
  }
  if (limits.maxToolRounds > 0 && totalToolRounds >= limits.maxToolRounds) {
    reviewReasons.push(`Responses Agent 已达到局部工具轮次上限 ${limits.maxToolRounds}，即使最终结构化结果合法也需要人工复核。`);
  }
  if (limits.maxRegions > 0 && usedRegions.size >= limits.maxRegions) {
    reviewReasons.push(`Responses Agent 已达到局部区域上限 ${limits.maxRegions}，即使最终结构化结果合法也需要人工复核。`);
  }
  let durationMs = Math.round(performance.now() - startedAtMs);
  const inputImageAudit = images.map((image) => ({
    label: image.label,
    mimeType: "image/webp" as const,
    sha256: sha256(image.buffer),
    bytes: image.buffer.length,
    role: image.role,
    ...(image.audit ? { audit: image.audit } : {}),
    artifactFileName: `responses-agent-${image.imageId}.webp`
  }));
  const initialImageIds = new Set(
    images
      .filter((image) => image.role === "student" || image.role === "grid")
      .map((image) => image.imageId)
  );
  const regionSources = buildRegionSources(allToolCalls);
  // Normalize and validate the primary Agent output before deciding whether a
  // high-risk verifier is needed.  This makes local evidence/source failures
  // (including a correct answer with no usable evidence) first-class verifier
  // triggers instead of discovering them only after the verifier was skipped.
  let normalized: ReturnType<typeof normalizeAgentOutput> | undefined;
  let localReviewAudit: ResponsesAgentLocalReviewAudit | undefined;
  if (finalData) {
    try {
      normalized = normalizeAgentOutput(finalData, input, width, height, initialImageIds, regionSources, reviewReasons);
    } catch (error) {
      reviewReasons.push(`Responses Agent 结果本地校验失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    reviewReasons.push("Responses Agent 未得到合法最终结构化结果，不能自动发布确定分数。");
  }
  if (normalized) {
    try {
      const localReview = await runAgentLocalReview(config, agentConfig, input, normalized, images, width, height, artifacts, operationId, rounds.length + 1);
      normalized = localReview.normalized;
      localReviewAudit = localReview.audit;
      reviewReasons.push(...localReview.reviewReasons);
      durationMs = Math.round(performance.now() - startedAtMs);
    } catch (error) {
      if (isOperationCancelled(error)) throw error;
      const localReviewTargets = buildAgentLocalReviewTargets(input, normalized);
      const message = error instanceof Error ? error.message : String(error);
      localReviewAudit = {
        status: "failed",
        model: agentConfig.model,
        baseUrl: agentConfig.baseUrl,
        durationMs: 0,
        targetKeys: localReviewTargets.map((target) => target.key),
        reviewedKeys: [],
        cropCount: 0,
        cropArtifactFileNames: [],
        results: [],
        error: message
      };
      reviewReasons.push(`Responses Agent 局部视觉复查失败：${message}`);
    }
  }
  if (finalData && agentConfig.backendGuardrailsEnabled) {
    for (const judgement of finalData.finalAnswerJudgements) {
      if (judgement.status === "incorrect" || judgement.status === "missing") {
        reviewReasons.push(`后端高风险兜底：${judgement.subquestionId} 被主 Agent 判定为 ${judgement.status}，已额外标记复核${agentConfig.independentVerifierEnabled ? "并触发独立审验" : ""}。`);
      }
    }
  }
  const agentAudit: ResponsesAgentAudit = {
    provider: "openai_responses",
    workflow: "responses_agent",
    store: false,
    model: agentConfig.model,
    baseUrl: agentConfig.baseUrl,
    startedAt,
    durationMs,
    maxToolRounds: limits.maxToolRounds,
    maxRegions: limits.maxRegions,
    rounds,
    inputImages: inputImageAudit,
    transcriptionLineCount: normalized?.evidence.lines.length ?? finalData?.transcription.lines.length ?? 0,
    finalAnswerCount: finalData?.finalAnswerJudgements.length ?? 0,
    finalBasis: finalData?.final_basis ?? [],
    reviewReasons: [...new Set(reviewReasons)],
    reasoningItemCount: lastResponseReasoningCount,
    ...(localReviewAudit ? { localReview: localReviewAudit } : {})
  };
  if (finalData && agentConfig.backendGuardrailsEnabled && agentConfig.independentVerifierEnabled && independentVerifierIsNeeded(finalData, reviewReasons)) {
    throwIfOperationCancelled(operationId);
    const validEvidenceLineIds = collectValidTranscriptionLineIds(finalData, initialImageIds, regionSources);
    const verifierAudit = await runIndependentVerifier(config, agentConfig, input, images, finalData, validEvidenceLineIds, operationId, rounds.length + 1);
    agentAudit.independentVerifier = verifierAudit;
    if (verifierAudit.status === "failed") {
      reviewReasons.push(`独立高风险审验模型调用失败：${verifierAudit.error ?? "未知错误"}`);
    } else if (verifierAudit.reviewRequired) {
      reviewReasons.push(verifierAudit.verdict === "conflict"
        ? `独立高风险审验发现 ${verifierAudit.conflicts.length || 1} 项冲突，需要人工复核。`
        : `独立高风险审验无法完全确认候选结果，需要人工复核。`);
      for (const conflict of verifierAudit.conflicts) {
        reviewReasons.push(`独立审验冲突 ${conflict.subquestionId}${conflict.pointId ? `:${conflict.pointId}` : ""}：${conflict.reason}`);
      }
    }
  }
  agentAudit.reviewReasons = [...new Set(reviewReasons)];
  agentAudit.transcriptionLineCount = normalized?.evidence.lines.length ?? agentAudit.transcriptionLineCount;
  if (!normalized) {
    const result = emptyFallbackResult(input, agentConfig.model, durationMs, agentAudit, agentAudit.reviewReasons[0] ?? "Responses Agent 结果不可用，需要人工复核");
    return {
      result,
      artifactSource: {
        preprocessedStudentAnswer: { buffer: studentImage.buffer, mimeType: "image/webp", fileName: input.fileName },
        questionImages: images.filter((image) => image.role === "question").map(imageSource),
        referenceImages: images.filter((image) => image.role === "reference").map(imageSource),
        questionText: input.questionText,
        referenceText: input.referenceText,
        rubric: input.rubric,
        agentArtifacts: artifacts
      }
    };
  }
  const result = calculateGrade({
    id: input.id,
    studentId: input.studentId,
    fileName: input.fileName,
    rubric: input.rubric,
    evidence: normalized.evidence,
    finalAnswerJudgements: normalized.finalAnswers,
    decisions: normalized.decisions,
    appliedDeductions: normalized.deductions,
    modelName: agentConfig.model,
    gradingMode: "vision_direct",
    evidenceValidationMode: "direct_visual",
    durationMs,
    unreadableReviewThreshold: config.unreadableReviewThreshold,
    operationId,
    previousResultId: input.previousResultId,
    regradedAt: input.regradedAt,
    regradeReason: input.regradeReason
  });
  result.gradingPipeline = "large_question_responses_agent";
  result.responsesAgentAudit = agentAudit;
  if (reviewReasons.length) {
    result.reviewReasons = [...new Set([...result.reviewReasons, ...reviewReasons])];
    result.status = "needs_review";
  }
  result.teacherCommentary = createFallbackTeacherCommentary(result);
  logProgress(operationId, "grading", "responses_agent_completed", `Responses Agent 大题批改完成：${result.score}/${result.maxScore}`, {
    model: agentConfig.model,
    rounds: rounds.length,
    toolRounds: totalToolRounds,
    uniqueRegions: usedRegions.size,
    transcriptionLines: normalized.evidence.lines.length,
    finalAnswers: normalized.finalAnswers.length,
    status: result.status,
    scoreResolved: result.scoreResolved,
    durationMs
  }, result.status === "needs_review" ? "warning" : "success");
  return {
    result,
    artifactSource: {
      preprocessedStudentAnswer: { buffer: studentImage.buffer, mimeType: "image/webp", fileName: input.fileName },
      questionImages: images.filter((image) => image.role === "question").map(imageSource),
      referenceImages: images.filter((image) => image.role === "reference").map(imageSource),
      questionText: input.questionText,
      referenceText: input.referenceText,
      rubric: input.rubric,
      agentArtifacts: artifacts
    }
  };
}
