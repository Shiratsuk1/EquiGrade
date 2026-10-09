import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EncryptedCookieVault,
  isAuthenticationUrl,
  isRestorableTargetUrl,
  PipelineTaskStore,
  selectTargetCookies,
  selectZhixueCookies,
  TargetNavigationStore,
  toCookieSetDetails,
  type CookieVaultCrypto,
  type PersistedTargetCookie
} from "./sessionPersistence.js";

const temporaryDirectories: string[] = [];
const crypto: CookieVaultCrypto = {
  available: () => true,
  encrypt: (plainText) => Buffer.from(`encrypted:${Buffer.from(plainText).toString("base64")}`, "utf8"),
  decrypt: (cipherText) => Buffer.from(cipherText.toString("utf8").slice("encrypted:".length), "base64").toString("utf8")
};

const authCookie: PersistedTargetCookie = {
  name: "SSO_R_SESSION_ID",
  value: "private-session-value",
  domain: "www.zhixue.com",
  hostOnly: true,
  path: "/",
  secure: false,
  httpOnly: false,
  sameSite: "unspecified",
  expirationDate: 1786389671
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hengzhun-session-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("target session persistence", () => {
  it("keeps only target-system cookies, including Ruiya subdomains", () => {
    expect(selectZhixueCookies([
      authCookie,
      { ...authCookie, name: "root", domain: ".zhixue.com" },
      { ...authCookie, name: "ruiya", domain: "ruiya.onlyets.com" },
      { ...authCookie, name: "onlyets-root", domain: ".onlyets.com" },
      { ...authCookie, name: "unrelated", domain: "example.com" }
    ]).map((cookie) => cookie.name)).toEqual(["SSO_R_SESSION_ID", "root", "ruiya", "onlyets-root"]);
    expect(selectTargetCookies([{ ...authCookie, name: "ruiya", domain: "ruiya.onlyets.com" }])).toHaveLength(1);
  });

  it("restores host-only, persistent and session cookies without changing their scope", () => {
    expect(toCookieSetDetails(authCookie)).toMatchObject({
      url: "http://www.zhixue.com/",
      name: "SSO_R_SESSION_ID",
      expirationDate: 1786389671
    });
    expect(toCookieSetDetails(authCookie)).not.toHaveProperty("domain");
    expect(toCookieSetDetails({ ...authCookie, expirationDate: undefined })).not.toHaveProperty("expirationDate");
    expect(toCookieSetDetails({ ...authCookie, domain: ".zhixue.com", hostOnly: false })).toHaveProperty("domain", ".zhixue.com");
  });

  it("round-trips encrypted cookies without writing plaintext credentials", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "cookies.bin");
    const vault = new EncryptedCookieVault(filePath, crypto);
    expect(await vault.save([authCookie])).toBe(1);
    expect((await readFile(filePath)).includes(Buffer.from(authCookie.value))).toBe(false);
    expect(await vault.load()).toEqual([authCookie]);
  });

  it("does not let a login redirect replace the last usable grading page", async () => {
    const directory = await temporaryDirectory();
    const store = new TargetNavigationStore(path.join(directory, "last-target.json"));
    const gradingUrl = "https://www.zhixue.com/htm-container-web/index.html#/marking/personal";
    expect(await store.save(gradingUrl)).toBe(true);
    expect(await store.save("https://www.zhixue.com/login.html")).toBe(false);
    expect(await store.load()).toBe(gradingUrl);
    expect(isAuthenticationUrl("https://www.zhixue.com/sso/login")).toBe(true);
    expect(isAuthenticationUrl("https://ruiya.onlyets.com/LoginOut.aspx")).toBe(true);
    expect(isRestorableTargetUrl("https://www.zhixue.com/")).toBe(false);
    expect(isRestorableTargetUrl("https://ruiya.onlyets.com/")).toBe(false);
    expect(isRestorableTargetUrl("https://ruiya.onlyets.com/mark/v6/view/task-token")).toBe(true);
    expect(isRestorableTargetUrl("javascript:alert(1)")).toBe(false);
  });

  it("persists and restores the mounted grading template selection", async () => {
    const directory = await temporaryDirectory();
    const store = new PipelineTaskStore(path.join(directory, "pipeline-task.json"));
    await store.save({
      mode: "production",
      templateId: "template-123",
      targetUrl: "https://ruiya.onlyets.com/mark/v6/view/task-token"
    });

    expect(await store.load()).toEqual({
      mode: "production",
      templateId: "template-123",
      targetUrl: "https://ruiya.onlyets.com/mark/v6/view/task-token"
    });
  });

  it("accepts the built-in test task and rejects unsafe or incomplete selections", async () => {
    const directory = await temporaryDirectory();
    const store = new PipelineTaskStore(path.join(directory, "pipeline-task.json"));
    await store.save({ mode: "test", targetUrl: "http://127.0.0.1:8788/zhixue-mock?embedded=1" });
    expect(await store.load()).toEqual({ mode: "test", targetUrl: "http://127.0.0.1:8788/zhixue-mock?embedded=1" });
    await expect(store.save({ mode: "production", targetUrl: "https://ruiya.onlyets.com/mark/v6/view/task-token" })).rejects.toThrow("缺少评分模板");
    await expect(store.save({ mode: "test", targetUrl: "javascript:alert(1)" })).rejects.toThrow("不可持久化");
  });
});
