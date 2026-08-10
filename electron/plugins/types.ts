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
};

export type ExtractedAnswer = {
  pageKey: string;
  sourcePageKey?: string;
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
  expectedImageHash?: string;
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
  writeScore(payload: ScoreWritePayload): Promise<void>;
  testScoreWrite(payload: ScoreWritePayload): Promise<PipelineWriteTestResult>;
  submitScore(): Promise<void>;
  verifySubmission(payload: ScoreWritePayload): Promise<void>;
  goToNext(): Promise<void>;
  detectPageChange(previousPageKey: string): Promise<PageTransition>;
  isBatchComplete(): boolean;
  currentPageKey(): string | undefined;
}

export type RuntimeUpdate = Partial<Omit<PluginStatus, "updatedAt">> & {
  phase?: PluginPhase;
};
