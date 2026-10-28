// Config + on-disk settings. Password is stored hashed; a first-run password is
// generated and written to data/first-run-password.txt.
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, randomToken } from "./util.mjs";
import { hashPassword } from "./auth.mjs";

export const VERSION = "1.0.0";

export const config = {
  host: process.env.ABLTX_HOST || "127.0.0.1",
  port: Number(process.env.ABLTX_PORT || 8787),
  publicUrl: process.env.ABLTX_PUBLIC_URL || "",
  secureCookies: process.env.ABLTX_SECURE_COOKIES === "1",
  sessionTtlDays: Number(process.env.ABLTX_SESSION_TTL_DAYS || 14),
  upstreamBase: (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, ""),
  credentialsPath:
    process.env.FREEPI_CREDENTIALS || join(process.env.HOME || "/root", ".free-pi", "agent", "credentials.json"),
  clientVersion: process.env.ABLTX_CLIENT_VERSION || "0.6.9",
  maxBodyBytes: Number(process.env.ABLTX_MAX_BODY_BYTES || 8 * 1024 * 1024),
};

export const defaults = {
  // security
  passwordHash: "",
  // limits
  rpm: 120,
  maxConcurrent: 6,
  corsOrigin: "*",
  // behaviour
  exposeModels: true,
  allowRawJwt: true,
  logBodyBytes: 0,
  // ui
  panelTitle: "abltx",
  upstreamSessionId: "abltx-" + randomToken(6),
};

const configFile = join(DATA_DIR, "config.json");

let state = { ...defaults };
let passwordFreshlyGenerated = false;

export function loadConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  let saved = {};
  if (existsSync(configFile)) {
    try {
      saved = JSON.parse(readFileSync(configFile, "utf8"));
      state = { ...defaults, ...saved };
    } catch (err) {
      console.error("[abltx] config.json is unreadable, using defaults:", err.message);
    }
  }
  // the upstream session id must stay stable across restarts, otherwise every
  // boot claims a fresh free-pi session slot and the account hits its limit
  if (!saved.upstreamSessionId) {
    state.upstreamSessionId = process.env.ABLTX_SESSION_ID || "abltx-" + randomToken(6);
    saveConfig();
  }
  if (!state.passwordHash) {
    const password = process.env.ABLTX_PASSWORD || randomToken(6);
    state.passwordHash = hashPassword(password);
    saveConfig();
    const hint = join(DATA_DIR, "first-run-password.txt");
    writeFileSync(hint, password + "\n", { mode: 0o600 });
    try {
      chmodSync(hint, 0o600);
    } catch {}
    passwordFreshlyGenerated = true;
    state.__firstRunPassword = password;
  }
  return state;
}

export function saveConfig() {
  mkdirSync(DATA_DIR, { recursive: true });
  const clean = { ...state };
  delete clean.__firstRunPassword;
  writeFileSync(configFile, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

export function settings() {
  return state;
}

export function updateSettings(patch) {
  Object.assign(state, patch);
  saveConfig();
  return state;
}

export function wasPasswordGenerated() {
  return passwordFreshlyGenerated;
}
