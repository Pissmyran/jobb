import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets") {
      return {
        url: "data:text/javascript,export const connect = (...args) => globalThis.__smtpTestConnect(...args)",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { smtpBinding } = await import("../docker/smtp.ts");
const encoder = new TextEncoder();
const message = { from: "sender@example.com", to: "recipient@example.com", subject: "Test" };

function socket(chunks, upgraded) {
  let controller;
  const writes = [];
  const result = {
    writes,
    closed: false,
    readable: new ReadableStream({
      start(stream) {
        controller = stream;
        for (const chunk of chunks)
          stream.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk));
      },
    }),
    startTls() {
      assert.ok(upgraded);
      return upgraded;
    },
    async close() {
      result.closed = true;
      controller.error(new Error("socket closed"));
    },
  };
  return result;
}

function sendThrough(server, port = "465") {
  globalThis.__smtpTestConnect = () => server;
  return smtpBinding({ SMTP_HOST: "smtp.example.com", SMTP_PORT: port }).send(message);
}

const remainingReplies = "250 sender\r\n250 recipient\r\n354 send\r\n250 queued\r\n";

test("handles fragmented multiline replies, UTF-8, and buffered replies", async () => {
  const greeting = `220 ${"x".repeat(506)}\r\n`;
  const multibyte = encoder.encode("å");
  const server = socket([
    greeting,
    "250-first\r",
    "\n250 second ",
    multibyte.slice(0, 1),
    multibyte.slice(1),
    "\r",
    `\n${remainingReplies}`,
  ]);
  const result = await sendThrough(server);
  assert.match(result.messageId, /^<.+@example\.com>$/);
  assert.ok(server.writes.some((line) => line === "DATA\r\n"));
  assert.ok(server.closed);
});

test("sends authenticated mail after STARTTLS", async () => {
  const secure = socket([
    `250 secure\r\n334 user\r\n334 password\r\n235 authenticated\r\n${remainingReplies}`,
  ]);
  const plaintext = socket(["220 hello\r\n250 hello\r\n220 ready\r\n"], secure);
  globalThis.__smtpTestConnect = () => plaintext;
  const result = await smtpBinding({
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASSWORD: "password",
  }).send(message);
  assert.match(result.messageId, /^<.+@example\.com>$/);
  assert.ok(secure.writes.includes("AUTH LOGIN\r\n"));
  assert.ok(secure.writes.includes(`${btoa("user")}\r\n`));
  assert.ok(secure.closed);
});

test("rejects a reply line over 512 bytes and closes the socket", async () => {
  const server = socket(["220-", "x".repeat(507), "\r\n"]);
  await assert.rejects(sendThrough(server), /för stort/);
  assert.ok(server.closed);
});

test("limits the total size of multiline replies", async () => {
  const line = `220-${"x".repeat(506)}\r\n`;
  const server = socket([line.repeat(128), "x"]);
  await assert.rejects(sendThrough(server), /för stort/);
  assert.ok(server.closed);
});

test("times out an incomplete final line and closes the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socket(["220 incomplete"]);
  const sending = sendThrough(server);
  const rejected = assert.rejects(sending, /för lång tid/);
  await Promise.resolve();
  t.mock.timers.tick(10 * 60 * 1000);
  await rejected;
  assert.deepEqual(server.writes, []);
  assert.ok(server.closed);
});

test("does not carry plaintext replies across STARTTLS", async () => {
  const secure = socket(["550 secure EHLO failed\r\n"]);
  const plaintext = socket(["220 hello\r\n250 hello\r\n220 ready\r\n250 forged\r\n"], secure);
  await assert.rejects(sendThrough(plaintext, "587"), /SMTP EHLO: 550 secure EHLO failed/);
  assert.ok(secure.closed);
});
