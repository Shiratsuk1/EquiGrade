import type { AdapterManifest } from "./types.js";

export const MOCK_ADAPTER_MANIFEST: AdapterManifest = {
  id: "mock-grading",
  name: "内置复杂阅卷测试站",
  version: "1.0.0",
  description: "适配项目内置的一题一页阅卷测试站点。",
  matchPatterns: ["http://localhost:*/mock-grading*", "http://127.0.0.1:*/mock-grading*"]
};

export const ZHIXUE_ADAPTER_MANIFEST: AdapterManifest = {
  id: "zhixue-grading",
  name: "智学网阅卷适配器",
  version: "1.0.0",
  description: "适配智学网个人阅卷页的答卷图像、分步写分、提交和翻页流程。",
  matchPatterns: ["https://www.zhixue.com/*", "https://zhixue.com/*", "https://*.zhixue.com/*"]
};

export const GENERIC_ADAPTER_MANIFEST: AdapterManifest = {
  id: "generic-data-attributes",
  name: "通用阅卷网页适配器",
  version: "1.0.0",
  description: "通过稳定的 data-grading-* 属性接入一题一页阅卷网页。",
  matchPatterns: ["http://*/*", "https://*/*"]
};
