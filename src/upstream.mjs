// Upstream free-pi client: accounts, model catalog, chat completions.
import { existsSync, readFileSync } from "node:fs";
import { DATA_DIR, HttpError } from "./util.mjs";
import { config, settings } from "./config.mjs";
import { addAccount, findAccount, getActiveAccountId, listAccounts, updateAccount } from "./store.mjs";

let modelsCache = { at: 0, data: [], notice: null, latest: config.clientVersion };
const MODEL_TTL = 60_000;

export const FALLBACK_MODEL = "deepseek-v4-flash";
export const FILE_ACCOUNT_ID = "file";

/* --------------------------------- token --------------------------------- */

export function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Token that `npx free-pi-cli` stored on this machine (used as a fallback account). */
export function readCredentialsToken() {
  try {
    const raw = JSON.parse(readFileSync(config.credentialsPath, "utf8"));
    return typeof raw.token === "string" && raw.token ? raw.token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a token source. `ref` may be an account id, a label, "file"/"local"
 * for the free-pi-cli file, or undefined for the active account.
 */
export function resolveAccount(ref) {
  const wants = typeof ref === "string" ? ref.trim() : "";
  const accounts = listAccounts();
  if (wants && wants !== "active" && wants !== FILE_ACCOUNT_ID && wants !== "local") {
    // header values arrive as latin1 bytes from Node, so try the utf8 reading too
    const variants = new Set([wants]);
    try {
      variants.add(Buffer.from(wants, "latin1").toString("utf8").trim());
    } catch {}
    for (const variant of variants) {
      if (!variant) continue;
      const hit =
        accounts.find((a) => a.id === variant) ||
        accounts.find((a) => a.label.toLowerCase() === variant.toLowerCase());
      if (hit) return { kind: "account", account: hit, id: hit.id, label: hit.label };
    }
  }
  if (wants === FILE_ACCOUNT_ID || wants === "local") return fileAccount();
  if (wants === "active" || !wants) {
    const active = accounts.find((a) => a.id === getActiveAccountId()) || accounts[0];
    if (active && active.enabled !== false) return { kind: "account", account: active, id: active.id, label: active.label };
    return fileAccount();
  }
  return fileAccount();
}

function fileAccount() {
  const token = readCredentialsToken();
  const claims = token ? decodeJwt(token) || {} : null;
  return {
    kind: "file",
    account: null,
    id: FILE_ACCOUNT_ID,
    label: "локальный free-pi-cli",
    token,
    subject: claims?.sub || null,
    expiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
  };
}

export function getToken(ref) {
  const resolved = typeof ref === "object" && ref ? ref : resolveAccount(ref);
  const token = resolved.token || resolved.account?.token;
  if (!token) {
    throw new HttpError(
      503,
      "no_upstream_token",
      `No free-pi token for account "${resolved.id}". Add one in the panel → «Аккаунты» (вход через браузер) or run "npx free-pi-cli@latest" once.`,
    );
  }
  return token;
}

export function tokenStatus(ref) {
  const resolved = typeof ref === "string" || ref === undefined ? resolveAccount(ref) : ref;
  const token = resolved.token || resolved.account?.token;
  if (!token) return { present: false, source: resolved.kind === "file" ? "free-pi-cli" : resolved.label, id: resolved.id, label: resolved.label };
  const claims = decodeJwt(token) || {};
  const exp = claims.exp ? claims.exp * 1000 : 0;
  return {
    present: true,
    source: resolved.kind === "file" ? "free-pi-cli" : resolved.account?.source || "panel",
    id: resolved.id,
    label: resolved.label,
    subject: claims.sub || null,
    expiresAt: exp ? new Date(exp).toISOString() : null,
    expiresInDays: exp ? Math.floor((exp - Date.now()) / 86_400_000) : null,
    expired: exp ? exp < Date.now() : false,
  };
}

/* -------------------------------- accounts ------------------------------- */

function accountView(a) {
  const claims = decodeJwt(a.token) || {};
  const exp = claims.exp ? claims.exp * 1000 : 0;
  return {
    id: a.id,
    label: a.label,
    source: a.source,
    handle: a.handle,
    subject: claims.sub || a.subject || null,
    addedAt: a.addedAt,
    lastCheckAt: a.lastCheckAt,
    lastUsedAt: a.lastUsedAt,
    requests: a.requests || 0,
    promptTokens: a.promptTokens || 0,
    completionTokens: a.completionTokens || 0,
    balance: a.balance,
    enabled: a.enabled !== false,
    expiresAt: exp ? new Date(exp).toISOString() : null,
    expiresInDays: exp ? Math.floor((exp - Date.now()) / 86_400_000) : null,
    expired: exp ? exp < Date.now() : false,
    active: a.id === getActiveAccountId(),
  };
}

export function listAccountViews() {
  const accounts = listAccounts();
  const views = accounts.map(accountView);
  const file = fileAccount();
  const fileAlreadySaved = accounts.some((a) => a.token === file.token);
  if (file.token && !fileAlreadySaved) {
    views.push({
      id: FILE_ACCOUNT_ID,
      label: file.label,
      source: "free-pi-cli",
      handle: null,
      subject: file.subject,
      addedAt: null,
      lastCheckAt: null,
      balance: null,
      enabled: true,
      expiresAt: file.expiresAt,
      expiresInDays: file.expiresAt ? Math.floor((Date.parse(file.expiresAt) - Date.now()) / 86_400_000) : null,
      expired: file.expiresAt ? Date.parse(file.expiresAt) < Date.now() : false,
      active: listAccounts().length === 0 || !listAccounts().some((a) => a.id === getActiveAccountId()),
      readOnly: true,
    });
  }
  return views;
}

function uniqueLabel(base) {
  const taken = new Set(listAccounts().map((a) => a.label.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base} #${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export function createAccount({ token, label, source = "manual" }) {
  const claims = decodeJwt(token) || {};
  const short = (claims.sub || "").slice(0, 6);
  const base = (label || "free-pi").slice(0, 40);
  const account = addAccount({
    token,
    label: uniqueLabel(base === "free-pi" && short ? `free-pi ${short}` : base),
    source,
    subject: claims.sub || null,
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
  });
  return accountView(account);
}

export async function refreshAccount(id) {
  if (id === FILE_ACCOUNT_ID) {
    const me = await callMe(readCredentialsToken(), { force: true });
    return { id: FILE_ACCOUNT_ID, handle: me.body?.handle ?? null, balance: me.ok ? balanceOf(me.body) : null };
  }
  const account = findAccount(id);
  if (!account) return null;
  const me = await callMe(account.token, { force: true });
  const patch = { lastCheckAt: new Date().toISOString() };
  if (me.ok && me.body) {
    patch.handle = me.body.handle ?? account.handle;
    patch.balance = balanceOf(me.body);
  }
  updateAccount(id, patch);
  return accountView(updateAccount(id, {}));
}

function balanceOf(body) {
  return {
    remaining_usd_today: body.remaining_usd_today ?? null,
    cap_usd_today: body.cap_usd_today ?? null,
    remaining_credits_today: body.remaining_credits_today ?? null,
    refill_at: body.refill_at ?? null,
    tier: body.tier ?? null,
    lane: body.lane ?? null,
  };
}

export { balanceOf };

/* --------------------------------- models -------------------------------- */

function parseModel(m) {
  const name = m.name || m.id;
  const mult = /~\s*([\d.]+)\s*x/i.exec(name);
  return {
    id: m.id,
    name,
    label: name.replace(/\s*·.*$/, ""),
    section: m.section === "defense" ? "defense" : "main",
    statsId: m.stats_id || m.id,
    usageMultiplier: mult ? Number(mult[1]) : 1,
    premium: /premium/i.test(name),
  };
}

export async function getModels({ force = false } = {}) {
  if (!force && modelsCache.data.length && Date.now() - modelsCache.at < MODEL_TTL) return modelsCache;
  let token = null;
  try {
    token = getToken();
  } catch {
    token = null;
  }
  const url = `${config.upstreamBase}/client-version`;
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);

  if (res?.ok) {
    const body = await res.json().catch(() => null);
    if (body?.models?.length) {
      modelsCache = {
        at: Date.now(),
        data: body.models.map(parseModel),
        notice: body.notice ?? null,
        latest: body.latest || config.clientVersion,
      };
      return modelsCache;
    }
  }
  if (!modelsCache.data.length) {
    modelsCache = {
      at: Date.now(),
      data: [parseModel({ id: FALLBACK_MODEL, name: "DeepSeek V4 Flash" })],
      notice: null,
      latest: config.clientVersion,
    };
  }
  return modelsCache;
}

export async function resolveModelId(requested) {
  const raw = String(requested || "").trim();
  const stripped = raw.replace(/^(free-pi|freepi|abltx)\//i, "");
  if (!stripped) return FALLBACK_MODEL;
  const { data } = await getModels();
  const hit =
    data.find((m) => m.id === stripped) ||
    data.find((m) => m.statsId === stripped) ||
    data.find((m) => m.label.toLowerCase() === stripped.toLowerCase());
  return hit ? hit.id : stripped;
}

/* ---------------------------------- calls -------------------------------- */

function upstreamHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": `abltx/1.0 free-pi-cli/${config.clientVersion}`,
    "x-client-version": config.clientVersion,
    "x-session-id": settings().upstreamSessionId || "abltx",
    ...extra,
  };
}

let meCache = { at: 0, data: null, token: null };
const ME_TTL = 15_000;

export async function callMe(token, { force = false } = {}) {
  token = token || getToken();
  if (!force && meCache.data && meCache.token === token && Date.now() - meCache.at < ME_TTL) return meCache.data;
  const res = await fetch(`${config.upstreamBase}/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res) return (meCache = { at: Date.now(), data: { ok: false, status: 0 }, token }).data;
  if (!res.ok) return (meCache = { at: Date.now(), data: { ok: false, status: res.status }, token }).data;
  const body = await res.json().catch(() => null);
  return (meCache = { at: Date.now(), data: { ok: true, status: res.status, body }, token }).data;
}

export async function chatCompletion(body, { signal, account } = {}) {
  const resolved = typeof account === "object" && account ? account : resolveAccount(account);
  const token = getToken(resolved);
  const res = await fetch(`${config.upstreamBase}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(token),
    body: JSON.stringify(body),
    signal,
  });
  return { res, token, account: resolved };
}

export async function upstreamJson(path, init = {}) {
  const token = getToken();
  const res = await fetch(`${config.upstreamBase}${path}`, {
    ...init,
    headers: upstreamHeaders(token, init.headers),
    signal: AbortSignal.timeout(10_000),
  });
  return res;
}

export async function resetOtherSessions(account) {
  const token = getToken(account);
  const res = await fetch(`${config.upstreamBase}/session/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, released: Boolean(body.released), status: res.status };
}

export function upstreamBase() {
  return config.upstreamBase;
}

/* --------------------------------- sign-in -------------------------------- */

export const CONSENT_VERSION = "4";

async function postJson(path, body) {
  const res = await fetch(`${config.upstreamBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/** Browser (connect) sign-in: returns a URL the user opens to authorize abltx. */
export async function startBrowserLogin() {
  const out = await postJson("/auth/connect/start", {
    consent_version: CONSENT_VERSION,
    client: { os: process.platform, cli_version: `abltx/${config.clientVersion}` },
  });
  if (!out.ok || !out.json?.connect_url) {
    throw new HttpError(out.status || 502, "login_start_failed", `free-pi refused to start sign-in (HTTP ${out.status})`);
  }
  return {
    sessionId: out.json.session_id,
    pollSecret: out.json.poll_secret,
    confirmCode: out.json.confirm_code,
    url: out.json.connect_url,
    interval: Math.max(1, out.json.interval || 2),
    expiresIn: out.json.expires_in || 600,
  };
}

/** GitHub device-code sign-in (no browser tab in this machine needed). */
export async function startDeviceLogin() {
  const out = await postJson("/auth/github/device", {});
  if (!out.ok || !out.json?.user_code) {
    throw new HttpError(out.status || 502, "login_start_failed", `free-pi refused to start device sign-in (HTTP ${out.status})`);
  }
  return {
    sessionId: out.json.session_id,
    code: out.json.user_code,
    url: out.json.verification_uri_complete || out.json.verification_uri,
    interval: Math.max(2, out.json.interval || 5),
    expiresIn: out.json.expires_in || 900,
  };
}

/** Polls a pending sign-in; returns { status, token? } */
export async function pollLogin({ mode, sessionId, pollSecret }) {
  const path = mode === "device" ? "/auth/token" : "/auth/connect/poll";
  const out = await postJson(path, { session_id: sessionId, ...(pollSecret ? { poll_secret: pollSecret } : {}) });
  if (out.ok) {
    if (out.json?.token) return { status: "token", token: out.json.token };
    if (out.json?.code === "consent_required") return { status: "consent" };
    return { status: "pending", retryAfter: out.json?.retry_after };
  }
  if (out.status === 403 && out.json?.code === "consent_required") return { status: "consent" };
  if (out.status === 403 && out.json?.code === "denied") return { status: "denied" };
  if (out.status === 410 || out.json?.code === "expired") return { status: "expired" };
  return { status: "pending", error: out.json?.message || out.text?.slice(0, 200) };
}

export async function submitLoginConsent(sessionId) {
  const out = await postJson("/auth/consent", { session_id: sessionId, consent_version: CONSENT_VERSION });
  return out.ok;
}

/** One-time import of the token that the CLI left on disk. */
export function importFileToken() {
  const token = readCredentialsToken();
  if (!token) return null;
  const claims = decodeJwt(token) || {};
  // match by token, not by source: the CLI file may now belong to another account
  const existing = listAccounts().find((a) => a.token === token);
  if (existing) {
    updateAccount(existing.id, { subject: claims.sub || existing.subject, lastCheckAt: null });
    return accountView(updateAccount(existing.id, {}));
  }
  return createAccount({ token, label: `free-pi-cli ${(claims.sub || "").slice(0, 6) || process.env.USER || "local"}`, source: "free-pi-cli" });
}

/** One-time import of the token that the CLI left on disk. */
export function migrateLegacyToken() {
  if (listAccounts().length) return null;
  return importFileToken();
}
