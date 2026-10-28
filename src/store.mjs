// Tiny JSON-backed store with debounced atomic writes.
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, newId } from "./util.mjs";

mkdirSync(DATA_DIR, { recursive: true });

const files = {
  keys: { path: join(DATA_DIR, "keys.json"), fallback: { keys: [] } },
  sessions: { path: join(DATA_DIR, "sessions.json"), fallback: { sessions: [] } },
  accounts: { path: join(DATA_DIR, "accounts.json"), fallback: { accounts: [], activeId: "" } },
};

const memory = new Map();
const dirty = new Set();
let timer = null;

function load(name) {
  if (memory.has(name)) return memory.get(name);
  const spec = files[name];
  let value = structuredClone(spec.fallback);
  if (existsSync(spec.path)) {
    try {
      value = { ...value, ...JSON.parse(readFileSync(spec.path, "utf8")) };
    } catch (err) {
      console.error(`[abltx] ${name}.json unreadable, starting empty:`, err.message);
    }
  }
  memory.set(name, value);
  return value;
}

function flush() {
  timer = null;
  for (const name of dirty) {
    const spec = files[name];
    const value = memory.get(name);
    const tmp = spec.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, spec.path);
  }
  dirty.clear();
}

function touch(name) {
  dirty.add(name);
  if (timer) return;
  timer = setTimeout(flush, 200);
  timer.unref?.();
}

export function flushNow() {
  if (timer) clearTimeout(timer);
  flush();
}

/* ---------------------------------- keys --------------------------------- */

export function listKeys() {
  return load("keys").keys;
}

export function findKeyByHash(hash) {
  return listKeys().find((k) => k.hash === hash) || null;
}

export function findKeyById(id) {
  return listKeys().find((k) => k.id === id) || null;
}

export function addKey(record) {
  const db = load("keys");
  const key = {
    id: newId(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    enabled: true,
    ...record,
  };
  db.keys.push(key);
  touch("keys");
  return key;
}

export function updateKey(id, patch) {
  const key = findKeyById(id);
  if (!key) return null;
  Object.assign(key, patch);
  touch("keys");
  return key;
}

export function removeKey(id) {
  const db = load("keys");
  const before = db.keys.length;
  db.keys = db.keys.filter((k) => k.id !== id);
  if (db.keys.length === before) return false;
  touch("keys");
  return true;
}

/* -------------------------------- sessions ------------------------------- */

export function listSessions() {
  return load("sessions").sessions;
}

export function addSession(record) {
  const db = load("sessions");
  db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
  db.sessions.push(record);
  touch("sessions");
  return record;
}

export function dropSession(id) {
  const db = load("sessions");
  db.sessions = db.sessions.filter((s) => s.id !== id);
  touch("sessions");
}

/* -------------------------------- accounts ------------------------------- */

export function listAccounts() {
  return load("accounts").accounts;
}

export function findAccount(id) {
  return listAccounts().find((a) => a.id === id) || null;
}

export function findAccountByToken(token) {
  return listAccounts().find((a) => a.token === token) || null;
}

export function addAccount(record) {
  const db = load("accounts");
  const account = {
    id: newId(),
    addedAt: new Date().toISOString(),
    label: "free-pi",
    source: "manual",
    handle: null,
    subject: null,
    expiresAt: null,
    balance: null,
    lastCheckAt: null,
    enabled: true,
    ...record,
  };
  db.accounts.push(account);
  if (!db.activeId) db.activeId = account.id;
  touch("accounts");
  return account;
}

export function updateAccount(id, patch) {
  const account = findAccount(id);
  if (!account) return null;
  Object.assign(account, patch);
  touch("accounts");
  return account;
}

export function removeAccount(id) {
  const db = load("accounts");
  const before = db.accounts.length;
  db.accounts = db.accounts.filter((a) => a.id !== id);
  if (db.accounts.length === before) return false;
  if (db.activeId === id) db.activeId = db.accounts[0]?.id || "";
  touch("accounts");
  return true;
}

export function getActiveAccountId() {
  return load("accounts").activeId;
}

export function setActiveAccountId(id) {
  const db = load("accounts");
  db.activeId = id;
  touch("accounts");
  return db.activeId;
}

/* ---------------------------------- logs --------------------------------- */

const logs = [];
const MAX_LOGS = 400;

export function pushLog(entry) {
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  if (process.env.ABLTX_LOG_FILE !== "0") {
    try {
      appendFileSync(join(DATA_DIR, "requests.jsonl"), JSON.stringify(entry) + "\n");
    } catch {}
  }
}

export function listLogs(limit = 100) {
  return logs.slice(0, Math.max(1, Math.min(limit, MAX_LOGS)));
}
