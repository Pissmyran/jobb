import http from "node:http";

// Only application routes reach Wrangler. Its development endpoints are not
// protected by the Worker's authentication, even when they share its port.
const appPaths = [
  /^\/$/,
  /^\/login$/,
  /^\/auth\/(?:login|logout)$/,
  /^\/assets\/(?:auth\.css|dashboard\.css|dashboard\.js)$/,
  /^\/api\/(?:health|ready|dashboard|configuration)$/,
  /^\/api\/reports\/\d{4}-\d{2}\/(?:export\.txt|email)$/,
  /^\/api\/applications\/[^/]+\/(?:recheck|not-submitted)$/,
  /^\/api\/runs\/[^/]+(?:\/stop)?$/,
];

export function createIngress(runtimePort) {
  return http.createServer((req, res) => {
    // Accept only origin-form targets and forward the same normalized path we
    // check. Strip Miniflare's internal headers, including MF-Original-URL.
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (!appPaths.some((pattern) => pattern.test(url.pathname))) {
      res.writeHead(404).end();
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !name.startsWith("mf-")),
    );
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: runtimePort,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}
