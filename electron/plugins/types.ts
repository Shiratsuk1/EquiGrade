import type {
  PipelineWriteTestResult,
  PluginCapabilities,
  PluginPhase,
  PluginStatus,
  TargetPageInspection
} from "../../shared/electron.js";

export type PreflightResult = {
  ok: boolean;
  issues: string[];
  capabilities: PluginCapabilities;
  pageKey?: string;
  questionLabel?: string;
};

export type ExtractedAnswer = {
  pageKey: string;
  sourcePageKey?: string;
  pageToken?: string;
  imageDataUrl: string;
  imageHash: string;
  imageMimeType: string;
  imageBytes: number;
  imageSource: string;
};

export type ScorePointValue = {
  id: string;
  score: number;
  maxScore: number;
};

export type ScoreSegmentValue = {
  id: string;
  title: string;
  score: number;
  maxScore: number;
  points: ScorePointValue[];
};

export type ScoreWritePayload = {
  score: number;
  maxScore: number;
  segments: ScoreSegmentValue[];
  expectedPageKey?: string;
  expectedPageToken?: string;
  expectedImageHash?: string;
  /** 是否属于存疑卷（若为 true 且站点支持，可在提交前勾选“优”等控件以便回评）。 */
  requiresReview?: boolean;
};

export type PageTransition = "changed" | "completed";
export type DiagnosticPageDirection = "previous" | "next";

export type DiagnosticScoreResult = {
  fieldId: string;
  score?: number;
};

export type DiagnosticNavigationResult = {
  previousPageKey?: string;
  pageKey?: string;
};

export type AdapterManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  matchPatterns: string[];
};

export type AdapterSelectors = {
  answerCard: string;
  answerImage: string;
  scoreInput: string;
  submitButton: string;
  nextButton: string;
  previousButton?: string;
  batchComplete: string;
};

export interface SiteAdapter {
  readonly manifest: AdapterManifest;
  matches(url: URL): boolean;
  preflight(): Promise<PreflightResult>;
  inspectSetup(): Promise<TargetPageInspection>;
  getCurrentAnswer(): Promise<ExtractedAnswer>;
  setDiagnosticScore(score: number | undefined): Promise<DiagnosticScoreResult>;
  navigateForDiagnostic(direction: DiagnosticPageDirection): Promise<DiagnosticNavigationResult>;
  /** 尝试勾选/切换卷面“优”控件（若适配器支持）。 */
  setExcellentMark?(checked?: boolean): Promise<boolean>;
  writeScore(payload: ScoreWritePayload): Promise<void>;
  testScoreWrite(payload: ScoreWritePayload): Promise<PipelineWriteTestResult>;
  submitScore(payload: ScoreWritePayload): Promise<void>;
  verifySubmission(payload: ScoreWritePayload): Promise<void>;
  goToNext(): Promise<void>;
  detectPageChange(previousPageKey: string): Promise<PageTransition>;
  isBatchComplete(): boolean;
  currentPageKey(): string | undefined;
  currentQuestionLabel?(): string | undefined;
}

export type RuntimeUpdate = Partial<Omit<PluginStatus, "updatedAt">> & {
  phase?: PluginPhase;
};
