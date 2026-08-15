import { describe, expect, it } from "vitest";
import { assertAllowedImageResource } from "./targetImagePolicy.js";

function allows(resource: string, document: string) {
  expect(() => assertAllowedImageResource(new URL(resource), new URL(document))).not.toThrow();
}

function rejects(resource: string, document: string) {
  expect(() => assertAllowedImageResource(new URL(resource), new URL(document))).toThrow("受信任的智学网域名");
}

describe("target image resource policy", () => {
  it("allows same-origin images", () => {
    allows("https://example.com/answer.jpg", "https://example.com/grading");
  });

  it("allows the official Zhixue answer-image storage host from a Zhixue grading page", () => {
    allows(
      "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/scDV2dv_marking/scanFile/answer.jpg",
      "https://www.zhixue.com/webmarking/example/"
    );
  });

  it("rejects the answer-image storage host when the requesting page is not Zhixue", () => {
    rejects(
      "https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/scDV2dv_marking/scanFile/answer.jpg",
      "https://evil.example/grading"
    );
  });

  it("rejects lookalike and unrelated OSS hosts", () => {
    rejects("https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com.evil.example/answer.jpg", "https://www.zhixue.com/webmarking/example/");
    rejects("https://other-bucket.oss-cn-hangzhou.aliyuncs.com/answer.jpg", "https://www.zhixue.com/webmarking/example/");
  });
});
