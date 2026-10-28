// Small HTTP / crypto helpers. No dependencies.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const DATA_DIR = process.env.ABLTX_DATA || join(ROOT, "data");

export const CLI_UA = /^(curl|wget|httpie|HTTPie|python-requests|python-urllib|Go-http-client|okhttp|node|deno|bun|axios|postman|insomnia|libwww|java|powershell|Microsoft\.PowerShell|Paw|RestSharp|Faraday|Ruby)\b/i;

export function isCliClient(req) {
  const ua = req.headers["user-agent"];
  if (!ua) return true;
  return CLI_UA.test(ua.trim());
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function text(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function html(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "payload_too_large", "request body larger than " + limit + " bytes"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // tolerate application/x-www-form-urlencoded from no-JS forms
    if (raw.includes("=")) return Object.fromEntries(new URLSearchParams(raw));
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`Path=${opts.path || "/"}`);
  bits.push(`SameSite=${opts.sameSite || "Lax"}`);
  if (opts.httpOnly !== false) bits.push("HttpOnly");
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

export function newId() {
  return randomBytes(8).toString("hex");
}

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function errorPayload(code, message, type = "abltx_error", extra = {}) {
  return { error: { message, type, code, ...extra }, code, message };
}
