import type { AdapterSelectors } from "./types.js";

export const DEFAULT_GRADING_SELECTORS: AdapterSelectors = {
  answerCard: "[data-grading-answer-card]",
  answerImage: "[data-grading-answer-image], [data-grading-answer-media] img, img",
  scoreInput: "[data-grading-score]",
  submitButton: "[data-grading-submit]",
  nextButton: "[data-grading-next]",
  previousButton: "[data-grading-previous]",
  batchComplete: "[data-grading-batch-complete]"
};
