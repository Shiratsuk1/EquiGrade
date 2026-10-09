import { describe, expect, it } from "vitest";
import { assertAllowedImageResource } from "./targetImagePolicy.js";

function allows(resource: string, document: string) {
  expect(() => assertAllowedImageResource(new URL(resource), new URL(document))).not.toThrow();
}

function rejects(resource: string, document: string) {
  expect(() => assertAllowedImageResource(new URL(resource), new URL(document))).toThrow("受信任的智学网或睿芽云域名");
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

  it("allows the Ruiya answer-image storage host from a Ruiya grading page", () => {
    allows(
      "https://alimarkpic.onlyets.com/pic2z/ruiya/answer.png",
      "https://ruiya.onlyets.com/mark/v6/view/example"
    );
  });

  it("allows the Ruiya OSS scan-image bucket used by real v6 grading pages", () => {
    allows(
      "https://ry-mark.oss-cn-beijing.aliyuncs.com/RuiYa/scan/3443/4369/12262/122628373/answer.png?Expires=4102415999&Signature=abc",
      "https://ruiya.onlyets.com/mark/v6/view/example"
    );
  });

  it("rejects the Ruiya OSS bucket when the requesting page is not Ruiya", () => {
    rejects(
      "https://ry-mark.oss-cn-beijing.aliyuncs.com/RuiYa/scan/answer.png",
      "https://evil.example/grading"
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
    rejects("https://alimarkpic.onlyets.com.evil.example/answer.jpg", "https://ruiya.onlyets.com/mark/v6/view/example");
    rejects("https://ry-mark.oss-cn-beijing.aliyuncs.com.evil.example/answer.png", "https://ruiya.onlyets.com/mark/v6/view/example");
    rejects("https://other-bucket.oss-cn-beijing.aliyuncs.com/answer.png", "https://ruiya.onlyets.com/mark/v6/view/example");
    rejects("http://ry-mark.oss-cn-beijing.aliyuncs.com/answer.png", "https://ruiya.onlyets.com/mark/v6/view/example");
    rejects("https://other.example/answer.jpg", "https://ruiya.onlyets.com/mark/v6/view/example");
  });

  it("rejects Zhixue built-in static UI / placeholder images", () => {
    expect(() => assertAllowedImageResource(
      new URL("https://static.zhixue.com/webmarking/mErl3fpkE/static/img/intellTip.f409616.png"),
      new URL("https://www.zhixue.com/webmarking/example/")
    )).toThrow("系统内置的静态提示或界面图片");
    expect(() => assertAllowedImageResource(
      new URL("https://static.zhixue.com/webmarking/mErl3fpkE/static/img/guide.92bb0f2.png"),
      new URL("https://www.zhixue.com/webmarking/example/")
    )).toThrow("系统内置的静态提示或界面图片");
  });
});
