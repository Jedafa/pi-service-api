// Password hashing, cookie sessions with CSRF, and API keys.
import { scryptSync, randomBytes, createHash } from "node:crypto";
import { newId, randomToken, safeEqual, sha256 } from "./util.mjs";
import { addKey, addSession, dropSession, findKeyByHash, listSessions, updateKey } from "./store.mjs";

export const SESSION_COOKIE = "abltx_session";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return safeEqual(candidate, hash);
}

/* -------------------------------- sessions ------------------------------- */

export function createSession(ttlMs) {
  const session = {
    id: randomToken(24),
    csrf: randomToken(16),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    ip: null,
  };
  addSession(session);
  return session;
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const found = listSessions().find((s) => s.id === sessionId);
  if (!found) return null;
  if (found.expiresAt <= Date.now()) {
    dropSession(sessionId);
    return null;
  }
  return found;
}

export function destroySession(sessionId) {
  if (sessionId) dropSession(sessionId);
}

export function pruneSessions() {
  const now = Date.now();
  for (const s of [...listSessions()]) if (s.expiresAt <= now) dropSession(s.id);
}

/* --------------------------------- API keys ------------------------------ */

export function generateApiKey() {
  return "abltx_sk_" + randomBytes(24).toString("hex");
}

export function createApiKey({ name = "default", rpm = 0, note = "" } = {}) {
  const plain = generateApiKey();
  const hash = sha256(plain);
  const record = addKey({
    name: String(name).slice(0, 60) || "default",
    note: String(note).slice(0, 200),
    prefix: plain.slice(0, 14),
    last4: plain.slice(-4),
    rpm: Number(rpm) || 0,
    hash,
  });
  return { key: plain, record, raw: hash };
}

export function verifyApiKey(plain, { touch = true } = {}) {
  if (!plain) return null;
  const hash = sha256(plain);
  const record = findKeyByHash(hash);
  if (!record || record.enabled === false) return null;
  if (touch) {
    record.lastUsedAt = new Date().toISOString();
    updateKey(record.id, {});
  }
  return record;
}

export function looksLikeJwt(value) {
  return typeof value === "string" && value.split(".").length === 3 && value.length > 40;
}

export function bearerToken(req) {
  const auth = req.headers.authorization || req.headers["x-api-key"] || "";
  const m = /^bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  if (auth && !/^bearer/i.test(auth)) return auth.trim();
  return "";
}

export function keyIdForLog(key) {
  return key ? key.id : "raw-jwt";
}

export function digest(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

export { newId };
