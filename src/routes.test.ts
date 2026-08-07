import { describe, expect, it } from "vitest";
import { parseRoute, routePath } from "./App";

describe("application routes", () => {
  it("maps each primary menu to a stable path", () => {
    expect(routePath({ view: "workspace" })).toBe("/grading");
    expect(routePath({ view: "models" })).toBe("/models");
    expect(routePath({ view: "history" })).toBe("/history");
    expect(routePath({ view: "logs" })).toBe("/logs");
  });

  it("parses direct menu URLs and normalizes the root page", () => {
    expect(parseRoute("/")).toEqual({ view: "workspace" });
    expect(parseRoute("/models")).toEqual({ view: "models" });
    expect(parseRoute("/history/")).toEqual({ view: "history" });
    expect(parseRoute("/logs")).toEqual({ view: "logs" });
    expect(parseRoute("/unknown/path")).toEqual({ view: "workspace" });
  });

  it("supports shareable template and result URLs with encoded IDs", () => {
    const route = {
      view: "workspace" as const,
      templateId: "template/with spaces",
      resultId: "result?1"
    };
    const path = routePath(route);
    expect(path).toBe("/grading/templates/template%2Fwith%20spaces/results/result%3F1");
    expect(parseRoute(path)).toEqual(route);
  });
});
