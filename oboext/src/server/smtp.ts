import net from "node:net";
import tls from "node:tls";

export type SmtpSecurity = "TLS" | "STARTTLS" | "NONE";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  pass: string;

  from: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const ADDR_RE = /<([^>]+)>/;

function extractAddr(s: string): string {
  const m = ADDR_RE.exec(s);
  return (m ? m[1] : s).trim();
}

interface Reply {
  code: number;
  text: string;
}

function readReply(sock: net.Socket | tls.TLSSocket, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n").filter((l) => l.length > 0);
      for (const line of lines) {

        if (line.length >= 4 && line[3] === " ") {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), text: buf });
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP 应答超时"));
    }, timeoutMs);
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onErr);
    }
    sock.on("data", onData);
    sock.once("error", onErr);
  });
}

async function cmd(sock: net.Socket | tls.TLSSocket, command: string, expect: number): Promise<Reply> {
  sock.write(command + "\r\n");
  const reply = await readReply(sock, 12000);
  if (reply.code !== expect) {
    throw new Error(`SMTP 失败: ${command.split(/\s|$/)[0]} → ${reply.code} ${reply.text.trim()}`);
  }
  return reply;
}

export async function sendSmtpMail(cfg: SmtpConfig, mail: SendMailInput): Promise<void> {
  if (!cfg.host) throw new Error("SMTP 主机未配置");

  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s =
      cfg.security === "TLS"
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port });
    s.setTimeout(12000);
    s.once("connect", () => resolve(s));
    s.once("secureConnect", () => resolve(s as tls.TLSSocket));
    s.once("error", reject);
  });

  try {

    const greeting = await readReply(sock, 12000);
    if (greeting.code !== 220) throw new Error(`SMTP 问候异常: ${greeting.code}`);

    // 2) EHLO
    const ehlo = async () => cmd(sock, `EHLO ${process.env.HOSTNAME ?? "oboext"}`, 250);
    let banner = await ehlo();

    let active = sock;
    if (cfg.security === "STARTTLS") {
      if (!/STARTTLS/i.test(banner.text)) {
        throw new Error("服务器不支持 STARTTLS");
      }
      await cmd(sock, "STARTTLS", 220);
      active = await new Promise((resolve, reject) => {
        const tlsSock = tls.connect({ socket: sock as net.Socket, servername: cfg.host });
        tlsSock.once("secureConnect", () => resolve(tlsSock));
        tlsSock.once("error", reject);
      });
      banner = await cmd(active, `EHLO ${process.env.HOSTNAME ?? "oboext"}`, 250);
    }

    if (cfg.user) {
      const mechanisms = /AUTH[^\r\n]*/i.exec(banner.text)?.[0] ?? "";
      const usePlain = /PLAIN/i.test(mechanisms);
      const useLogin = /LOGIN/i.test(mechanisms);
      if (!usePlain && !useLogin) throw new Error("服务器不支持密码认证（AUTH）");
      if (usePlain) {
        const credential = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64");
        await cmd(active, `AUTH PLAIN ${credential}`, 235);
      } else {
        await cmd(active, "AUTH LOGIN", 334);
        await cmd(active, Buffer.from(cfg.user, "utf8").toString("base64"), 334);
        await cmd(active, Buffer.from(cfg.pass, "utf8").toString("base64"), 235);
      }
    }

    const fromAddr = extractAddr(cfg.from);
    await cmd(active, `MAIL FROM:<${fromAddr}>`, 250);
    await cmd(active, `RCPT TO:<${extractAddr(mail.to)}>`, 250);
    await cmd(active, "DATA", 354);

    const boundary = "oboemail-" + Date.now().toString(36);
    const headers = [
      `From: ${cfg.from.includes("<") ? cfg.from : fromAddr}`,
      `To: ${mail.to}`,
      `Subject: =?UTF-8?B?${Buffer.from(mail.subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "Date: " + new Date().toUTCString(),
      "",
      "",
    ].join("\r\n");
    const body =
      `--${boundary}\r\n` +
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from(mail.text, "utf8").toString("base64") +
      `\r\n--${boundary}\r\n` +
      "Content-Type: text/html; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from(mail.html, "utf8").toString("base64") +
      `\r\n--${boundary}--\r\n`;

    const dotted = (headers + body).replace(/^\./gm, "..");
    active.write(dotted + "\r\n.\r\n");
    await readReply(active, 15000).then((r) => {
      if (r.code !== 250) throw new Error(`SMTP 投递失败: ${r.code} ${r.text.trim()}`);
    });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      active.once("close", done);
      active.once("error", done);
      active.end("QUIT\r\n");
    });
  } finally {
    sock.destroy();
  }
}
