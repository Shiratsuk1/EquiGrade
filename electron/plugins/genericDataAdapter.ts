import { GENERIC_ADAPTER_MANIFEST } from "./manifests.js";
import { createGenericAdapter } from "./genericAdapter.js";
import { DEFAULT_GRADING_SELECTORS } from "./selectors.js";

export function createGenericDataAdapter() {
  return createGenericAdapter(GENERIC_ADAPTER_MANIFEST, DEFAULT_GRADING_SELECTORS);
}
