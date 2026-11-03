import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../tools/docs-site.mjs", import.meta.url));

function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "jobb-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "zensical.toml"),
    'repo_url = "https://example.com/repo"\nnav = [{ "Target" = "target.md" }]\n',
  );
  writeFileSync(join(dir, "docs", "source.md"), content);
  writeFileSync(join(dir, "docs", "target.md"), "Target");
  writeFileSync(join(dir, "docs", "agents", "ignored.md"), "Ignored");
  return dir;
}

function build(dir, ...args) {
  execFileSync(process.execPath, [script, ...args], { cwd: dir, timeout: 10000 });
}

test("site and wiki rewrite links while preserving malformed links and fenced text", (t) => {
  const input = [
    '[page](target.md#part "Title")',
    "[repo](../package.json) [external](https://example.com/a) [anchor](#part)",
    '[bad](missing "unclosed [good](target.md)',
    '[bad](missing "bad [good](target.md "title")',
    "[empty]() [invalid](target.md title)",
    "```md",
    "[code](target.md)",
    "```",
  ].join("\n");
  const dir = fixture(t, input);
  build(dir);
  build(dir, "--wiki", "wiki");

  const expected = (target) =>
    [
      `[page](${target}#part "Title")`,
      "[repo](https://example.com/repo/blob/main/package.json) [external](https://example.com/a) [anchor](#part)",
      `[bad](missing "unclosed [good](${target})`,
      `[bad](missing "bad [good](${target} "title")`,
      "[empty]() [invalid](target.md title)",
      "```md",
      "[code](target.md)",
      "```",
    ].join("\n");
  assert.equal(readFileSync(join(dir, "site-docs", "source.md"), "utf8"), expected("target.md"));
  assert.equal(readFileSync(join(dir, "wiki", "source.md"), "utf8"), expected("Target"));
  assert.throws(() => readFileSync(join(dir, "site-docs", "agents", "ignored.md")));
});

test("long malformed links do not stall the documentation build", (t) => {
  const input = `${"](x".repeat(100000)}\n${'](x " '.repeat(100000)}`;
  const dir = fixture(t, input);
  build(dir);
  assert.equal(readFileSync(join(dir, "site-docs", "source.md"), "utf8"), input);
});
