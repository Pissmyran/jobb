import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createIngress } from "../docker/ingress.mjs";

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
}
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, ...options }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("container ingress forwards application requests and blocks runtime administration", async (t) => {
  const seen = [];
  const runtime = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    req.pipe(res);
  });
  await listen(runtime);
  const ingress = createIngress(runtime.address().port);
  await listen(ingress);
  t.after(() => {
    ingress.close();
    runtime.close();
  });
  const port = ingress.address().port;

  const result = await request(port, "/api/configuration?x=1", {
    method: "POST",
    headers: {
      host: "jobb.example.com",
      origin: "https://jobb.example.com",
      cookie: "session=test",
      "mf-original-url": "http://localhost/__scheduled",
      "mf-route-override": "other",
      "cf-access-jwt-assertion": "test",
    },
    body: "settings",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, "settings");
  assert.equal(seen[0].url, "/api/configuration?x=1");
  assert.equal(seen[0].headers.host, "jobb.example.com");
  assert.equal(seen[0].headers.origin, "https://jobb.example.com");
  assert.equal(seen[0].headers.cookie, "session=test");
  assert.equal(seen[0].headers["cf-access-jwt-assertion"], "test");
  assert.equal(seen[0].headers["mf-original-url"], undefined);
  assert.equal(seen[0].headers["mf-route-override"], undefined);
  for (const path of [
    "/cdn-cgi/local/explorer/api/d1",
    "/cdn-cgi/local/platform-proxy",
    "/cdn-cgi/local/scheduled",
    "/cdn-cgi/handler/scheduled",
    "/__scheduled",
    "/__cf_local/stream",
    "/api/../__scheduled",
    "/api/%2e%2e/__scheduled",
    "//localhost/__scheduled",
    "http://localhost/__scheduled",
  ]) {
    const before = seen.length;
    const response = await request(port, path, { headers: { host: "localhost" } });
    assert.ok([400, 404].includes(response.status), `${path}: ${response.status}`);
    assert.equal(seen.length, before, path);
  }
  for (const path of [
    "/",
    "/login",
    "/auth/login",
    "/auth/logout",
    "/assets/auth.css",
    "/assets/dashboard.css",
    "/assets/dashboard.js",
    "/api/health",
    "/api/ready",
    "/api/dashboard",
    "/api/runs/manual",
    "/api/runs/example/stop",
    "/api/applications/example%2Fid/recheck",
    "/api/reports/2026-10/export.txt",
    "/api/reports/2026-10/email",
  ]) {
    assert.equal((await request(port, path)).status, 200, path);
  }
});

test("container ingress fails closed when the runtime is unavailable", async (t) => {
  const runtime = http.createServer();
  await listen(runtime);
  const port = runtime.address().port;
  await new Promise((resolve) => runtime.close(resolve));
  const ingress = createIngress(port);
  await listen(ingress);
  t.after(() => ingress.close());
  assert.equal((await request(ingress.address().port, "/api/health")).status, 502);
});
