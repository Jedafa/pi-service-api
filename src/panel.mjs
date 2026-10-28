// Dashboard: cookie-authed HTML/JSON routes. The panel is cookie-only, the API is
// curl-friendly (see api.mjs).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, HttpError, ROOT, html, isCliClient, json, parseCookies, readJson, serializeCookie, text } from "./util.mjs";
import { SESSION_COOKIE, createApiKey, createSession, destroySession, getSession, hashPassword, verifyPassword } from "./auth.mjs";
import { settings, updateSettings, wasPasswordGenerated } from "./config.mjs";
import { callMe, chatCompletion, createAccount, getModels, importFileToken, listAccountViews, refreshAccount, resetOtherSessions, resolveAccount, submitLoginConsent, tokenStatus } from "./upstream.mjs";
import { listKeys, listLogs, removeKey, removeAccount, setActiveAccountId, updateAccount, updateKey, flushNow } from "./store.mjs";
import { cancelLogin, getLogin, loginView, pollLoginState, startLogin } from "./logins.mjs";
import { apiLanding } from "./api.mjs";

function useSecureCookies() {
  return Boolean(settings().secureCookies || process.env.ABLTX_SECURE_COOKIES === "1");
}

const PUBLIC_DIR = join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/* ------------------------------- page routes ----------------------------- */

export async function handlePanel(req, res, url) {
  const path = url.pathname;

  if (path.startsWith("/panel/api/")) return handlePanelApi(req, res, url, path);

  if (req.method === "POST" && path === "/login") return handleLogin(req, res);
  if (req.method === "GET" && path === "/login" && url.searchParams.has("password")) {
    // magic link: /login?password=...&next=/panel  (handy for headless browsers/tests)
    const ok = verifyPassword(url.searchParams.get("password"), settings().passwordHash);
    if (!ok) return serveStatic(res, "index.html");
    const ttl = settings().sessionTtlDays || 14;
    const session = createSession(ttl * 24 * 3600 * 1000);
    res.writeHead(303, {
      location: url.searchParams.get("next") || "/",
      "set-cookie": serializeCookie(SESSION_COOKIE, session.id, { maxAge: ttl * 24 * 3600, secure: useSecureCookies() }),
    });
    res.end();
    return true;
  }
  if (req.method === "POST" && (path === "/logout" || path === "/panel/logout")) {
    destroySession(parseCookies(req)[SESSION_COOKIE]);
    flushNow();
    res.writeHead(303, {
      location: "/",
      "set-cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: useSecureCookies() }),
    });
    res.end("logout\n");
    return true;
  }

  const staticFile = staticPath(path);
  if (staticFile) return serveStatic(res, staticFile);

  if (path === "/" || path === "/login" || path === "/dashboard" || path === "/panel") {
    const session = getPanelSession(req);
    // curl/wget on "/" gets a plain-text cheat sheet instead of HTML
    if (path === "/" && !session && isCliClient(req)) {
      text(res, 200, apiLanding());
      return true;
    }
    return serveStatic(res, "index.html");
  }

  return false;
}

function staticPath(path) {
  const map = {
    "/app.js": "app.js",
    "/styles.css": "styles.css",
    "/favicon.svg": "favicon.svg",
    "/logo.svg": "logo.svg",
    "/manifest.webmanifest": "manifest.webmanifest",
  };
  const name = map[path];
  if (!name) return null;
  return existsSync(join(PUBLIC_DIR, name)) ? name : null;
}

function serveStatic(res, name) {
  const file = join(PUBLIC_DIR, name);
  if (!existsSync(file)) throw new HttpError(404, "not_found", `missing asset ${name}`);
  const ext = name.slice(name.lastIndexOf("."));
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": name === "index.html" ? "no-store" : "public, max-age=60",
  });
  res.end(body);
  return true;
}

function getPanelSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  return getSession(sid);
}

/* --------------------------------- login --------------------------------- */

async function handleLogin(req, res) {
  const body = await readJson(req);
  const cfg = settings();
  const password = String(body.password ?? "");
  if (!verifyPassword(password, cfg.passwordHash)) {
    json(res, 401, { ok: false, error: "wrong password" });
    return true;
  }
  const ttl = (settings().sessionTtlDays || 14) * 24 * 3600 * 1000;
  const session = createSession(ttl);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": serializeCookie(SESSION_COOKIE, session.id, {
      maxAge: ttl / 1000,
      secure: useSecureCookies(),
    }),
  });
  res.end(JSON.stringify({ ok: true, csrf: session.csrf }));
  return true;
}

/* -------------------------------- panel API ------------------------------ */

async function handlePanelApi(req, res, url, path) {
  const session = getPanelSession(req);
  if (!session) {
    throw new HttpError(401, "panel_login_required", "panel session cookie missing or expired — sign in at /login (the /v1 API works without cookies)");
  }
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    const csrf = req.headers["x-abltx-csrf"] || url.searchParams.get("csrf");
    if (csrf !== session.csrf) throw new HttpError(403, "csrf_mismatch", "missing or wrong x-abltx-csrf header");
  }

  const route = path.slice("/panel/api/".length);

  if (route === "state" && method === "GET") {
    // keep every account's handle/balance fresh (at most once a minute per account)
    const stale = listAccountViews().filter(
      (a) => !a.expired && (!a.lastCheckAt || Date.now() - Date.parse(a.lastCheckAt) > 60_000),
    );
    if (stale.length) await Promise.allSettled(stale.slice(0, 6).map((a) => refreshAccount(a.id)));
    const accounts = listAccountViews();
    const active = resolveAccount();
    const t = tokenStatus(active);
    const models = (await getModels()).data;
    const me = t.present ? await callMe(t.token || active.account?.token) : { ok: false };
    if (me.ok && me.body && active.account) {
      updateAccount(active.account.id, {
        handle: me.body.handle ?? active.account.handle,
        balance: { remaining_usd_today: me.body.remaining_usd_today ?? null, cap_usd_today: me.body.cap_usd_today ?? null, remaining_credits_today: me.body.remaining_credits_today ?? null, refill_at: me.body.refill_at ?? null, tier: me.body.tier ?? null, lane: me.body.lane ?? null },
        lastCheckAt: new Date().toISOString(),
      });
    }
    flushNow();
    const cfg = settings();
    json(res, 200, {
      ok: true,
      upstream: {
        ...t,
        handle: me.ok ? me.body?.handle : active.account?.handle ?? null,
        remaining_usd_today: me.ok ? me.body?.remaining_usd_today : active.account?.balance?.remaining_usd_today ?? null,
        cap_usd_today: me.ok ? me.body?.cap_usd_today : active.account?.balance?.cap_usd_today ?? null,
        remaining_credits_today: me.ok ? me.body?.remaining_credits_today : active.account?.balance?.remaining_credits_today ?? null,
        refill_at: me.ok ? me.body?.refill_at : active.account?.balance?.refill_at ?? null,
        tier: me.ok ? me.body?.tier : active.account?.balance?.tier ?? null,
        lane: me.ok ? me.body?.lane : active.account?.balance?.lane ?? null,
        reachable: me.ok,
      },
      accounts,
      activeId: active.id,
      activeLabel: active.label,
      models,
      settings: {
        rpm: cfg.rpm,
        maxConcurrent: cfg.maxConcurrent,
        allowRawJwt: cfg.allowRawJwt,
        exposeModels: cfg.exposeModels,
        secureCookies: cfg.secureCookies,
      },
      baseUrl: publicBase(req),
      session: { createdAt: session.createdAt, expiresAt: session.expiresAt },
      keys: listKeys().map(publicKey),
      logs: listLogs(60),
      passwordGenerated: wasPasswordGenerated(),
    });
    return true;
  }

  if (route === "keys" && method === "GET") {
    json(res, 200, { ok: true, keys: listKeys().map(publicKey) });
    return true;
  }

  if (route === "keys" && method === "POST") {
    const body = await readJson(req);
    const { key, record } = createApiKey({ name: body.name, rpm: body.rpm, note: body.note });
    if (body.accountId) updateKey(record.id, { accountId: body.accountId });
    // dev convenience: the panel shows only prefix…last4, so keep the last full key on disk
    try {
      writeFileSync(join(DATA_DIR, "last-key.txt"), `${key}\n`, { mode: 0o600 });
    } catch {}
    flushNow();
    json(res, 201, { ok: true, key, record: publicKey(record) });
    return true;
  }

  const keyMatch = /^keys\/([a-f0-9]+)$/.exec(route);
  if (keyMatch) {
    const id = keyMatch[1];
    if (method === "DELETE") {
      const ok = removeKey(id);
      flushNow();
      json(res, ok ? 200 : 404, { ok });
      return true;
    }
    if (method === "PATCH" || method === "POST") {
      const body = await readJson(req);
      const rec = updateKey(id, {
        ...(body.name !== undefined ? { name: String(body.name).slice(0, 60) } : {}),
        ...(body.rpm !== undefined ? { rpm: Number(body.rpm) || 0 } : {}),
        ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
        ...(body.note !== undefined ? { note: String(body.note).slice(0, 200) } : {}),
        ...(body.accountId !== undefined ? { accountId: body.accountId || null } : {}),
      });
      flushNow();
      json(res, rec ? 200 : 404, { ok: Boolean(rec), record: rec ? publicKey(rec) : null });
      return true;
    }
  }

  if (route === "logs" && method === "GET") {
    json(res, 200, { ok: true, logs: listLogs(Number(url.searchParams.get("limit") || 100)) });
    return true;
  }

  if (route === "settings" && method === "POST") {
    const body = await readJson(req);
    const patch = {};
    for (const k of ["rpm", "maxConcurrent"]) if (body[k] !== undefined) patch[k] = Math.max(1, Number(body[k]) || 1);
    for (const k of ["allowRawJwt", "exposeModels", "secureCookies"]) if (body[k] !== undefined) patch[k] = Boolean(body[k]);
    if (body.panelTitle) patch.panelTitle = String(body.panelTitle).slice(0, 40);
    json(res, 200, { ok: true, settings: updateSettings(patch) });
    return true;
  }

  if (route === "password" && method === "POST") {
    const body = await readJson(req);
    if (!verifyPassword(String(body.current ?? ""), settings().passwordHash)) {
      throw new HttpError(403, "wrong_current_password", "current password is wrong");
    }
    const next = String(body.next ?? "");
    if (next.length < 6) throw new HttpError(400, "weak_password", "new password must be at least 6 characters");
    updateSettings({ passwordHash: hashPassword(next) });
    json(res, 200, { ok: true });
    return true;
  }

  if (route === "upstream/token" && method === "POST") {
    // legacy endpoints kept for compatibility: sets/creates the active account
    const body = await readJson(req);
    const token = String(body.token ?? "").trim();
    if (!token) {
      const active = resolveAccount();
      if (active.account) {
        removeAccount(active.account.id);
        flushNow();
      }
      json(res, 200, { ok: true, upstream: tokenStatus() });
      return true;
    }
    const account = createAccount({ token, label: body.label, source: "manual" });
    await refreshAccount(account.id).catch(() => {});
    flushNow();
    json(res, 200, { ok: true, upstream: tokenStatus(), account });
    return true;
  }

  if (route === "upstream/reload" && method === "POST") {
    const account = importFileToken();
    const t = tokenStatus();
    const me = t.present ? await callMe() : { ok: false };
    json(res, 200, { ok: t.present && me.ok, account, upstream: { ...t, reachable: me.ok } });
    return true;
  }

  if (route === "accounts" && method === "GET") {
    json(res, 200, { ok: true, accounts: listAccountViews() });
    return true;
  }

  if (route === "accounts" && method === "POST") {
    const body = await readJson(req);
    const token = String(body.token ?? "").trim();
    if (!token) throw new HttpError(400, "missing_token", "нужен JWT free-pi");
    const check = await callMe(token);
    if (!check.ok) throw new HttpError(400, "token_rejected", `free-pi отклонил токен (HTTP ${check.status})`);
    const account = createAccount({ token, label: body.label, source: "manual" });
    if (check.body?.handle) updateAccount(account.id, { handle: check.body.handle });
    await refreshAccount(account.id).catch(() => {});
    flushNow();
    json(res, 201, { ok: true, account });
    return true;
  }

  if (route === "accounts/import-file" && method === "POST") {
    const account = importFileToken();
    if (!account) throw new HttpError(404, "no_file_token", "в credentials.json free-pi-cli токена нет");
    flushNow();
    json(res, 200, { ok: true, account });
    return true;
  }

  if (route === "accounts/login/start" && method === "POST") {
    const body = await readJson(req);
    const login = startLogin({ mode: body.mode === "device" ? "device" : "browser", label: body.label });
    await login.ready;
    json(res, 200, { ok: login.status !== "error", login: loginView(login) });
    return true;
  }

  const loginMatch = /^accounts\/login\/([a-f0-9]+)$/.exec(route);
  if (loginMatch) {
    const id = loginMatch[1];
    if (method === "DELETE") {
      json(res, 200, { ok: cancelLogin(id) });
      return true;
    }
    const login = await pollLoginState(id);
    if (login.status === "done") {
      login.account = await refreshAccount(login.account.id).catch(() => login.account);
      flushNow();
    }
    const view = loginView(login);
    json(res, 200, { ok: true, login: view, accounts: login.status === "done" ? listAccountViews() : undefined });
    return true;
  }

  const accountMatch = /^accounts\/([a-f0-9]+)(?:\/(activate|refresh))?$/.exec(route);
  if (accountMatch) {
    const [, id, action] = accountMatch;
    if (action === "activate" && method === "POST") {
      setActiveAccountId(id);
      flushNow();
      json(res, 200, { ok: true, activeId: id });
      return true;
    }
    if (action === "refresh" && method === "POST") {
      const account = await refreshAccount(id);
      flushNow();
      json(res, account ? 200 : 404, { ok: Boolean(account), account });
      return true;
    }
    if (method === "DELETE") {
      json(res, removeAccount(id) ? 200 : 404, { ok: true });
      flushNow();
      return true;
    }
    if (method === "PATCH" || method === "POST") {
      const body = await readJson(req);
      const patch = {};
      if (body.label !== undefined) patch.label = String(body.label).slice(0, 40) || "free-pi";
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      const rec = updateAccount(id, patch);
      flushNow();
      json(res, rec ? 200 : 404, { ok: Boolean(rec) });
      return true;
    }
  }

  if (route === "upstream/refresh-models" && method === "POST") {
    const models = await getModels({ force: true });
    json(res, 200, { ok: true, count: models.data.length });
    return true;
  }

  if (route === "upstream/reset-sessions" && method === "POST") {
    const r = await resetOtherSessions();
    json(res, 200, { ok: r.ok, released: r.released });
    return true;
  }

  if (route === "chat" && method === "POST") {
    return panelChat(req, res);
  }

  if (route === "logout" && method === "POST") {
    destroySession(session.id);
    json(res, 200, { ok: true });
    return true;
  }

  throw new HttpError(404, "not_found", `no panel route for ${route} (${method})`);
}

function publicBase(req) {
  const cfg = settings();
  if (process.env.ABLTX_PUBLIC_URL) return process.env.ABLTX_PUBLIC_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || (cfg.secureCookies ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1";
  return `${proto}://${host}`;
}

function publicKey(k) {
  return {
    id: k.id,
    name: k.name,
    note: k.note || "",
    prefix: k.prefix,
    last4: k.last4,
    rpm: k.rpm || 0,
    accountId: k.accountId || null,
    enabled: k.enabled !== false,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    requests: k.requests || 0,
    promptTokens: k.promptTokens || 0,
    completionTokens: k.completionTokens || 0,
  };
}

/* ------------------------------- playground ------------------------------ */

async function panelChat(req, res) {
  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw new HttpError(400, "bad_request", "messages required");
  const upstreamBody = {
    model: body.model || "deepseek-v4-flash",
    messages,
    stream: body.stream !== false,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
  };
  for (const k of Object.keys(upstreamBody)) if (upstreamBody[k] === undefined) delete upstreamBody[k];
  if (upstreamBody.stream) upstreamBody.stream_options = { include_usage: true };

  const { res: up } = await chatCompletion(upstreamBody);
  if (!up.ok) {
    const raw = await up.text().catch(() => "");
    json(res, up.status, { error: "upstream", status: up.status, body: safeJson(raw) });
    return true;
  }
  if (!upstreamBody.stream) {
    json(res, 200, await up.json());
    return true;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const reader = up.body.getReader();
  req.on("close", () => {
    if (!res.writableEnded) reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
  return true;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 500);
  }
}

export function sendHtml404(res, url) {
  html(res, 404, `<h1>404</h1><pre>${url.pathname}</pre><p><a href="/">panel</a></p>`);
}
