import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EncryptedCookieVault,
  isAuthenticationUrl,
  isRestorableTargetUrl,
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
  it("keeps only Zhixue cookies, including subdomains", () => {
    expect(selectZhixueCookies([
      authCookie,
      { ...authCookie, name: "root", domain: ".zhixue.com" },
      { ...authCookie, name: "unrelated", domain: "example.com" }
    ]).map((cookie) => cookie.name)).toEqual(["SSO_R_SESSION_ID", "root"]);
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
    expect(isRestorableTargetUrl("https://www.zhixue.com/")).toBe(false);
    expect(isRestorableTargetUrl("javascript:alert(1)")).toBe(false);
  });
});
