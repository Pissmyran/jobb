import { spawn } from "node:child_process";
import { createIngress } from "./ingress.mjs";

const runtimePort = 18787;
const publicPort = Number(process.env.PORT || 8787);
if (
  !Number.isInteger(publicPort) ||
  publicPort < 1 ||
  publicPort > 65535 ||
  publicPort === runtimePort
) {
  throw new Error("PORT must be a valid port other than 18787, reserved for the local runtime.");
}

const children = [];
const ingress = createIngress(runtimePort);
function stop(code) {
  ingress.close();
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
ingress.on("error", (error) => {
  console.error(`[ingress] ${error.message}`);
  stop(1);
});
ingress.listen(publicPort, "0.0.0.0", () => {
  const env = { ...process.env, X_LOCAL_EXPLORER: "false", JOBB_RUNTIME_PORT: String(runtimePort) };
  for (const args of [
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--persist-to",
      "/data",
      "--config",
      "wrangler.container.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      String(runtimePort),
      "--test-scheduled",
      "--env-file",
      process.argv[2],
      "--show-interactive-dev-session=false",
    ],
    ["docker/scheduler.mjs"],
  ]) {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    children.push(child);
    child.on("error", (error) => {
      console.error(error.message);
      stop(1);
    });
    child.on("exit", (code, signal) => {
      if (process.exitCode === undefined) {
        console.error(`[server] child exited (${signal || code})`);
        stop(1);
      }
    });
  }
});
