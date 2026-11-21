import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../tools/docs-site.mjs", import.meta.url));
const maxBytes = 10 * 1024 * 1024;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jobb-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(
    join(dir, "zensical.toml"),
    'repo_url = "https://example.com/repo"\nnav = [{ "Guide" = "guide.md" }]\n',
  );
  return dir;
}

function build(dir, wiki = false) {
  return spawnSync(process.execPath, [script, ...(wiki ? ["--wiki", "wiki"] : [])], {
    cwd: dir,
    encoding: "utf8",
    timeout: 5000,
  });
}

test("site and wiki preserve normal Markdown and rewrite links", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "README.md"), "# Home\n[Guide](docs/guide.md)\n");
  writeFileSync(join(dir, "docs/guide.md"), "# Guide\nHej världen\n");
  writeFileSync(join(dir, "docs/image.txt"), "asset");
  mkdirSync(join(dir, "docs/agents"));
  writeFileSync(join(dir, "docs/agents/internal.md"), "internal");

  for (const wiki of [false, true]) {
    const result = build(dir, wiki);
    assert.equal(result.status, 0, result.stderr);
    const out = join(dir, wiki ? "wiki" : "site-docs");
    assert.match(
      readFileSync(join(out, wiki ? "Home.md" : "index.md"), "utf8"),
      wiki ? /\[Guide\]\(Guide\)/ : /\[Guide\]\(guide\.md\)/,
    );
    assert.equal(
      readFileSync(join(out, wiki ? "Guide.md" : "guide.md"), "utf8"),
      "# Guide\nHej världen\n",
    );
    if (!wiki) assert.equal(readFileSync(join(out, "image.txt"), "utf8"), "asset");
  }
});

test(
  "rejects Markdown symlinks, including an endless device, in both outputs",
  { skip: process.platform !== "linux" },
  (t) => {
    const dir = fixture(t);
    for (const target of ["/dev/zero", join(dir, "plain.txt")]) {
      writeFileSync(join(dir, "plain.txt"), "safe text");
      const link = join(dir, "docs/device.md");
      symlinkSync(target, link);
      for (const wiki of [false, true]) {
        const result = build(dir, wiki);
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ELOOP/);
      }
      rmSync(link);
    }
  },
);

test(
  "rejects non-regular Markdown files without waiting for a writer",
  { skip: process.platform !== "linux" },
  (t) => {
    const dir = fixture(t);
    const fifo = join(dir, "docs/pipe.md");
    const created = spawnSync("mkfifo", [fifo]);
    assert.equal(created.status, 0, String(created.stderr));
    const result = build(dir);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not a regular Markdown file/);
  },
);

test("accepts the byte limit and rejects larger Markdown in both outputs", (t) => {
  const dir = fixture(t);
  const page = join(dir, "docs/large.md");
  writeFileSync(page, Buffer.alloc(maxBytes, "a"));
  const atLimit = build(dir);
  assert.equal(atLimit.status, 0, atLimit.stderr);
  assert.equal(readFileSync(join(dir, "site-docs/large.md")).length, maxBytes);
  writeFileSync(page, Buffer.alloc(maxBytes + 1, "a"));
  for (const wiki of [false, true]) {
    const result = build(dir, wiki);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Markdown file exceeds 10485760 bytes/);
  }
});
