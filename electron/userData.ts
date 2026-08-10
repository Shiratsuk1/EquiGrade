import type { App } from "electron";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STABLE_USER_DATA_DIRECTORY = "HengzhunGradingWorkbench";
const TARGET_PARTITION_PATH = path.join("Partitions", "hengzhun-target");
const AUTH_COOKIE_NAME = "SSO_R_SESSION_ID";
const SESSION_RECOVERY_MARKER = "session-recovery-v2.json";

export type UserDataConfiguration = {
  path: string;
  migratedFrom?: string;
  recoveredCookiesFrom?: string;
};

function cookieDatabaseHasName(cookiePath: string, name: string) {
  if (!existsSync(cookiePath)) return false;
  return readFileSync(cookiePath).includes(Buffer.from(name, "utf8"));
}

export function recoverAffectedLegacyCookies(stablePath: string, legacyPath: string) {
  const markerPath = path.join(stablePath, SESSION_RECOVERY_MARKER);
  if (existsSync(markerPath)) return false;
  const stableCookiePath = path.join(stablePath, TARGET_PARTITION_PATH, "Network", "Cookies");
  const legacyCookiePath = path.join(legacyPath, TARGET_PARTITION_PATH, "Network", "Cookies");
  const stableHasAuthentication = cookieDatabaseHasName(stableCookiePath, AUTH_COOKIE_NAME);
  const legacyHasAuthentication = cookieDatabaseHasName(legacyCookiePath, AUTH_COOKIE_NAME);
  let recovered = false;

  if (!stableHasAuthentication && legacyHasAuthentication) {
    mkdirSync(path.dirname(stableCookiePath), { recursive: true });
    const backupPath = `${stableCookiePath}.pre-session-recovery-v2.bak`;
    if (existsSync(stableCookiePath) && !existsSync(backupPath)) copyFileSync(stableCookiePath, backupPath, constants.COPYFILE_EXCL);
    copyFileSync(legacyCookiePath, stableCookiePath);
    const legacyJournal = `${legacyCookiePath}-journal`;
    if (existsSync(legacyJournal)) copyFileSync(legacyJournal, `${stableCookiePath}-journal`);
    recovered = true;
  }

  mkdirSync(stablePath, { recursive: true });
  writeFileSync(markerPath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    legacyPath,
    stableHadAuthentication: stableHasAuthentication,
    legacyHadAuthentication: legacyHasAuthentication,
    recovered
  }, null, 2), "utf8");
  return recovered;
}

function browserStateTimestamp(userDataPath: string) {
  const partitionPath = path.join(userDataPath, TARGET_PARTITION_PATH);
  if (!existsSync(partitionPath)) return undefined;
  const cookiePath = path.join(partitionPath, "Network", "Cookies");
  return Math.max(
    statSync(partitionPath).mtimeMs,
    existsSync(cookiePath) ? statSync(cookiePath).mtimeMs : 0
  );
}

export function selectNewestLegacyUserData(candidates: string[]) {
  return candidates
    .map((candidate) => ({ candidate, timestamp: browserStateTimestamp(candidate) }))
    .filter((entry): entry is { candidate: string; timestamp: number } => entry.timestamp !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.candidate;
}

function migrateBrowserState(sourceUserData: string, targetUserData: string) {
  const sourcePartition = path.join(sourceUserData, TARGET_PARTITION_PATH);
  const targetPartition = path.join(targetUserData, TARGET_PARTITION_PATH);
  mkdirSync(targetUserData, { recursive: true });

  const sourceLocalState = path.join(sourceUserData, "Local State");
  const targetLocalState = path.join(targetUserData, "Local State");
  if (existsSync(sourceLocalState)) {
    if (existsSync(targetLocalState)) {
      const backup = `${targetLocalState}.pre-migration.bak`;
      if (!existsSync(backup)) copyFileSync(targetLocalState, backup, constants.COPYFILE_EXCL);
    }
    copyFileSync(sourceLocalState, targetLocalState);
  }
  cpSync(sourcePartition, targetPartition, { recursive: true, force: false, errorOnExist: false });

  const sourceHostLocalStorage = path.join(sourceUserData, "Local Storage");
  const targetHostLocalStorage = path.join(targetUserData, "Local Storage");
  if (existsSync(sourceHostLocalStorage) && !existsSync(targetHostLocalStorage)) {
    cpSync(sourceHostLocalStorage, targetHostLocalStorage, { recursive: true, force: false, errorOnExist: false });
  }

  const legacyEvents = path.join(sourceUserData, "pipeline-events.jsonl");
  const targetEvents = path.join(targetUserData, "pipeline-events.jsonl");
  if (existsSync(legacyEvents) && !existsSync(targetEvents)) copyFileSync(legacyEvents, targetEvents, constants.COPYFILE_EXCL);
  writeFileSync(path.join(targetUserData, "user-data-migration.json"), JSON.stringify({
    migratedAt: new Date().toISOString(),
    sourceUserData
  }, null, 2), "utf8");
}

export function configureStableUserData(app: Pick<App, "getPath" | "setName" | "setPath">): UserDataConfiguration {
  app.setName("Hengzhun Grading Workbench");
  const appDataPath = app.getPath("appData");
  const stablePath = path.join(appDataPath, STABLE_USER_DATA_DIRECTORY);
  const stableHasBrowserState = browserStateTimestamp(stablePath) !== undefined;
  let migratedFrom: string | undefined;
  let recoveredCookiesFrom: string | undefined;
  const legacyCandidates = [
    path.join(appDataPath, "Electron"),
    path.join(appDataPath, "physics-grading-console"),
    path.join(appDataPath, "衡准自动改卷工作台")
  ].filter((candidate) => path.resolve(candidate) !== path.resolve(stablePath));

  if (!stableHasBrowserState) {
    migratedFrom = selectNewestLegacyUserData(legacyCandidates);
    if (migratedFrom) migrateBrowserState(migratedFrom, stablePath);
  }

  const migrationMarker = path.join(stablePath, "user-data-migration.json");
  if (existsSync(migrationMarker)) {
    try {
      const migration = JSON.parse(readFileSync(migrationMarker, "utf8")) as { sourceUserData?: string };
      const recoverySource = migration.sourceUserData && existsSync(migration.sourceUserData)
        ? migration.sourceUserData
        : selectNewestLegacyUserData(legacyCandidates);
      if (recoverySource && recoverAffectedLegacyCookies(stablePath, recoverySource)) recoveredCookiesFrom = recoverySource;
    } catch {
      // A malformed legacy marker must not prevent the application from starting.
    }
  }

  mkdirSync(stablePath, { recursive: true });
  app.setPath("userData", stablePath);
  return { path: stablePath, migratedFrom, recoveredCookiesFrom };
}
