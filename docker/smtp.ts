// Container-only: an EmailBinding that sends over SMTP (cloudflare:sockets),
// so the monthly .txt can be e-mailed without Cloudflare Email Service.
// Supports STARTTLS (587) and direct TLS (465) with AUTH LOGIN.
import { connect } from "cloudflare:sockets";
import type { EmailBinding } from "../apps/web/src/notifier";

export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}

type Reply = { code: number; text: string };

const MAX_REPLY_LINE_BYTES = 512;
const MAX_REPLY_BYTES = 64 * 1024;
const REPLY_TIMEOUT_MS = 10 * 60 * 1000;

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
}

function base64Lines(text: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function address(value: string): string {
  const match = value.match(/<([^>]+)>/);
  const bare = (match ? match[1] : value).trim();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(bare)) throw new Error(`Ogiltig adress: ${value}`);
  return bare;
}

export function smtpBinding(env: SmtpEnv): EmailBinding {
  const host = env.SMTP_HOST!;
  const port = Number(env.SMTP_PORT || 587);
  return {
    async send(message) {
      const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map(address);
      const boundary = `jobb-${crypto.randomUUID()}`;
      const parts = [
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(message.text ?? "")}`,
        ...(message.attachments ?? []).map(
          (file) =>
            `--${boundary}\r\nContent-Type: ${file.type}; name="${file.filename}"\r\nContent-Disposition: attachment; filename="${file.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.content.replace(/.{1,76}/g, "$&\r\n").trimEnd()}`,
        ),
      ];
      const messageId = `<${crypto.randomUUID()}@${address(message.from).split("@")[1]}>`;
      const data = [
        `From: ${message.from}`,
        `To: ${recipients.join(", ")}`,
        `Subject: ${encodeHeader(message.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        ...parts,
        `--${boundary}--`,
      ].join("\r\n");

      let socket = connect(
        { hostname: host, port },
        { secureTransport: port === 465 ? "on" : "starttls", allowHalfOpen: false },
      );
      let writer = socket.writable.getWriter();
      let reader = socket.readable.getReader();
      let pending = new Uint8Array(0);
      let offset = 0;
      const decoder = new TextDecoder();
      const read = async (): Promise<Reply> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reply = async (): Promise<Reply> => {
          const lines: string[] = [];
          let line: number[] = [];
          let bytes = 0;
          for (;;) {
            if (offset === pending.length) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("SMTP-servern stängde anslutningen.");
              if (chunk.value.length > MAX_REPLY_BYTES)
                throw new Error("SMTP-svaret är för stort.");
              pending = chunk.value;
              offset = 0;
              if (!pending.length) continue;
            }
            const byte = pending[offset++];
            line.push(byte);
            if (++bytes > MAX_REPLY_BYTES || line.length > MAX_REPLY_LINE_BYTES) {
              throw new Error("SMTP-svaret är för stort.");
            }
            if (byte !== 10 || line[line.length - 2] !== 13) continue;
            const text = decoder.decode(new Uint8Array(line.slice(0, -2)));
            lines.push(text);
            if (/^\d{3} /.test(text)) {
              return { code: Number(text.slice(0, 3)), text: lines.join("\n") };
            }
            line = [];
          }
        };
        try {
          return await Promise.race([
            reply(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("SMTP-svaret tog för lång tid.")),
                REPLY_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const write = (line: string) => writer.write(new TextEncoder().encode(`${line}\r\n`));
      const expect = async (code: number, what: string) => {
        const reply = await read();
        if (reply.code !== code) throw new Error(`SMTP ${what}: ${reply.text}`);
      };

      try {
        await expect(220, "anslutning");
        await write("EHLO localhost");
        await expect(250, "EHLO");
        if (port !== 465) {
          await write("STARTTLS");
          await expect(220, "STARTTLS");
          writer.releaseLock();
          reader.releaseLock();
          socket = socket.startTls();
          pending = new Uint8Array(0);
          offset = 0;
          writer = socket.writable.getWriter();
          reader = socket.readable.getReader();
          await write("EHLO localhost");
          await expect(250, "EHLO");
        }
        if (env.SMTP_USER) {
          await write("AUTH LOGIN");
          await expect(334, "AUTH");
          await write(btoa(env.SMTP_USER));
          await expect(334, "AUTH användare");
          await write(btoa(env.SMTP_PASSWORD ?? ""));
          await expect(235, "inloggning");
        }
        await write(`MAIL FROM:<${address(message.from)}>`);
        await expect(250, "MAIL FROM");
        for (const to of recipients) {
          await write(`RCPT TO:<${to}>`);
          await expect(250, `RCPT TO ${to}`);
        }
        await write("DATA");
        await expect(354, "DATA");
        await write(`${data.replace(/\r\n\./g, "\r\n..")}\r\n.`);
        await expect(250, "meddelandet");
        await write("QUIT");
        return { messageId };
      } finally {
        await socket.close().catch(() => undefined);
      }
    },
  };
}
