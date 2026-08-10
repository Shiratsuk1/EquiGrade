import { MOCK_ADAPTER_MANIFEST } from "./manifests.js";
import { createGenericAdapter } from "./genericAdapter.js";
import { DEFAULT_GRADING_SELECTORS } from "./selectors.js";

export function createMockAdapter() {
  return createGenericAdapter(MOCK_ADAPTER_MANIFEST, DEFAULT_GRADING_SELECTORS);
}
