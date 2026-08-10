import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureStableUserData, recoverAffectedLegacyCookies, selectNewestLegacyUserData } from "./userData.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hengzhun-user-data-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createBrowserState(userDataPath: string, modifiedAt: Date, marker = "cookie-db") {
  const partition = path.join(userDataPath, "Partitions", "hengzhun-target");
  const network = path.join(partition, "Network");
  mkdirSync(network, { recursive: true });
  writeFileSync(path.join(network, "Cookies"), marker, "utf8");
  writeFileSync(path.join(userDataPath, "Local State"), `local-state:${marker}`, "utf8");
  utimesSync(path.join(network, "Cookies"), modifiedAt, modifiedAt);
  utimesSync(partition, modifiedAt, modifiedAt);
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("stable Electron user data", () => {
  it("selects the most recently updated legacy browser partition", () => {
    const root = temporaryDirectory();
    const older = path.join(root, "Electron");
    const newer = path.join(root, "physics-grading-console");
    createBrowserState(older, new Date("2026-08-09T10:00:00Z"), "older");
    createBrowserState(newer, new Date("2026-08-09T11:00:00Z"), "newer");

    expect(selectNewestLegacyUserData([older, newer])).toBe(newer);
  });

  it("migrates the latest partition and Local State into one fixed directory", () => {
    const appDataPath = temporaryDirectory();
    const source = path.join(appDataPath, "Electron");
    createBrowserState(source, new Date("2026-08-09T12:00:00Z"), "active-login");
    mkdirSync(path.join(source, "Local Storage", "leveldb"), { recursive: true });
    writeFileSync(path.join(source, "Local Storage", "leveldb", "000003.log"), "saved-start-url", "utf8");
    let configuredName = "";
    let configuredPath = "";
    const fakeApp = {
      getPath: (name: string) => {
        expect(name).toBe("appData");
        return appDataPath;
      },
      setName: (name: string) => { configuredName = name; },
      setPath: (name: string, value: string) => {
        expect(name).toBe("userData");
        configuredPath = value;
      }
    } as Parameters<typeof configureStableUserData>[0];

    const result = configureStableUserData(fakeApp);
    const targetCookie = path.join(result.path, "Partitions", "hengzhun-target", "Network", "Cookies");

    expect(configuredName).toBe("Hengzhun Grading Workbench");
    expect(configuredPath).toBe(path.join(appDataPath, "HengzhunGradingWorkbench"));
    expect(result.migratedFrom).toBe(source);
    expect(readFileSync(targetCookie, "utf8")).toBe("active-login");
    expect(readFileSync(path.join(result.path, "Local State"), "utf8")).toBe("local-state:active-login");
    expect(readFileSync(path.join(result.path, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("saved-start-url");
    expect(existsSync(path.join(source, "Partitions", "hengzhun-target"))).toBe(true);
  });

  it("repairs an incomplete first migration exactly once and keeps a backup", () => {
    const root = temporaryDirectory();
    const stable = path.join(root, "HengzhunGradingWorkbench");
    const legacy = path.join(root, "Electron");
    createBrowserState(stable, new Date("2026-08-10T01:00:00Z"), "deviceId-only");
    createBrowserState(legacy, new Date("2026-08-10T00:00:00Z"), `cookies:${"SSO_R_SESSION_ID"}`);
    const stableCookie = path.join(stable, "Partitions", "hengzhun-target", "Network", "Cookies");

    expect(recoverAffectedLegacyCookies(stable, legacy)).toBe(true);
    expect(readFileSync(stableCookie, "utf8")).toContain("SSO_R_SESSION_ID");
    expect(readFileSync(`${stableCookie}.pre-session-recovery-v2.bak`, "utf8")).toBe("deviceId-only");
    expect(recoverAffectedLegacyCookies(stable, legacy)).toBe(false);
  });

  it("does not replace a healthy stable authentication cookie", () => {
    const root = temporaryDirectory();
    const stable = path.join(root, "HengzhunGradingWorkbench");
    const legacy = path.join(root, "Electron");
    createBrowserState(stable, new Date("2026-08-10T01:00:00Z"), `new:${"SSO_R_SESSION_ID"}`);
    createBrowserState(legacy, new Date("2026-08-10T00:00:00Z"), `old:${"SSO_R_SESSION_ID"}`);
    const stableCookie = path.join(stable, "Partitions", "hengzhun-target", "Network", "Cookies");

    expect(recoverAffectedLegacyCookies(stable, legacy)).toBe(false);
    expect(readFileSync(stableCookie, "utf8")).toBe("new:SSO_R_SESSION_ID");
  });
});
