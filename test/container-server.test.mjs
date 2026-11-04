import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverScript = fileURLToPath(new URL("../docker/server.mjs", import.meta.url));
const schedulerScript = pathToFileURL(
  fileURLToPath(new URL("../docker/scheduler.mjs", import.meta.url)),
).href;

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test(
  "container server keeps runtime and scheduler private and stops with its children",
  { timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jobb-server-"));
    await mkdir(path.join(dir, "node_modules/wrangler/bin"), { recursive: true });
    await mkdir(path.join(dir, "docker"));
    await writeFile(path.join(dir, "test.env"), "");
    await writeFile(
      path.join(dir, "node_modules/wrangler/bin/wrangler.js"),
      `
    const http = require('node:http');
    const fs = require('node:fs');
    const args = process.argv;
    if (args[args.indexOf('--ip') + 1] !== '127.0.0.1' || args[args.indexOf('--port') + 1] !== '18787' || !args.includes('--test-scheduled') || process.env.X_LOCAL_EXPLORER !== 'false') process.exit(1);
    http.createServer((req, res) => {
      if (req.url.startsWith('/__scheduled?')) fs.writeFileSync('scheduled', req.url);
      res.end('runtime');
    }).listen(18787, '127.0.0.1');
  `,
    );
    // Trigger the real scheduler once promptly, then keep it alive for the server.
    await writeFile(
      path.join(dir, "docker/scheduler.mjs"),
      `
    const original = globalThis.setTimeout;
    let count = 0;
    globalThis.setTimeout = (fn) => { if (count++ === 0) return original(fn, 500); };
    setInterval(() => {}, 1000);
    await import(${JSON.stringify(schedulerScript)});
  `,
    );
    const port = await freePort();
    const child = spawn(process.execPath, [serverScript, "test.env"], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: "inherit",
    });
    t.after(async () => {
      child.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    });
    let scheduled;
    for (let i = 0; i < 50 && !scheduled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      scheduled = await readFile(path.join(dir, "scheduled"), "utf8").catch(() => null);
    }
    assert.equal(scheduled, "/__scheduled?cron=0%209%2010-13%20*%20*");
    assert.equal(
      await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.text()),
      "runtime",
    );
    assert.equal(await fetch(`http://127.0.0.1:${port}/__scheduled`).then((r) => r.status), 404);
    child.kill("SIGTERM");
    const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)));
    assert.equal(code, 0);
  },
);
