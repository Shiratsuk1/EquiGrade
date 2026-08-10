import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地开发端口"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const includeElectron = process.argv[2] === "electron";
const token = randomBytes(32).toString("hex");
const [apiPort, webPort] = await Promise.all([findFreePort(), findFreePort()]);
const concurrentlyPackage = fileURLToPath(import.meta.resolve("concurrently/package.json"));
const concurrentlyEntry = path.join(path.dirname(concurrentlyPackage), "dist", "bin", "concurrently.js");
const argumentsList = includeElectron
  ? [concurrentlyEntry, "-k", "-n", "api,web,electron", "-c", "green,cyan,magenta", "npm:dev:api", "npm:dev:web", "npm:electron:run"]
  : [concurrentlyEntry, "-k", "-n", "api,web", "-c", "green,cyan", "npm:dev:api", "npm:dev:web"];

const child = spawn(process.execPath, argumentsList, {
  env: {
    ...process.env,
    HENGZHUN_API_TOKEN: token,
    PORT: String(apiPort),
    VITE_PORT: String(webPort)
  },
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error("无法启动本地开发服务", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
