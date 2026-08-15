import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScorePointGuidance } from "./ScorePointGuidance";

describe("ScorePointGuidance", () => {
  it("renders generated common responses, alternative methods and equivalents", () => {
    const html = renderToStaticMarkup(<ScorePointGuidance defaultOpen point={{
      commonResponses: ["p=p_0+mg/S", "pS=p_0S+mg"],
      alternativeMethods: ["先对活塞受力平衡，再求气体压强"],
      acceptedEquivalents: ["p-p_0=mg/S"]
    }} />);

    expect(html).toContain("作答形式辅助");
    expect(html).toContain("4 项");
    expect(html).toContain("常见作答");
    expect(html).toContain("其他解法");
    expect(html).toContain("等价情况");
    expect(html).toContain("不是答案白名单");
    expect(html).toContain("open");
  });

  it("does not render an empty panel for legacy score points", () => {
    expect(renderToStaticMarkup(<ScorePointGuidance point={{}} />)).toBe("");
  });
});
