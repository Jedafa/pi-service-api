#!/usr/bin/env node
// abltx — free-pi behind an OpenAI-compatible API, with a cookie-protected web panel.
import http from "node:http";
import { spawn } from "node:child_process";
import { config, loadConfig, settings, wasPasswordGenerated } from "./src/config.mjs";
import { flushNow, pushLog } from "./src/store.mjs";
import { HttpError, clientIp, errorPayload, json, text } from "./src/util.mjs";
import { handleApi, sendApi404 } from "./src/api.mjs";
import { handlePanel, sendHtml404 } from "./src/panel.mjs";
import { pruneSessions } from "./src/auth.mjs";
import { tokenStatus, getModels, callMe, migrateLegacyToken, listAccountViews } from "./src/upstream.mjs";
import { pruneLogins } from "./src/logins.mjs";

const VERSION = "1.0.0";
loadConfig();
// import the token that free-pi-cli left on disk, so an existing install works at once
const imported = migrateLegacyToken();
if (imported) console.log(`[abltx] импортировал токен free-pi-cli как аккаунт «${imported.label}»`);

const loginAttempts = new Map();

function throttleLogin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= 12) {
    loginAttempts.set(ip, list);
    return false;
  }
  list.push(now);
  loginAttempts.set(ip, list);
  return true;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return text(res, 400, "bad request target\n");
  }
  const path = url.pathname;

  try {
    if (req.method === "POST" && path === "/login" && !throttleLogin(req)) {
      return json(res, 429, { error: "too many login attempts, wait a minute" });
    }

    const apiish = path.startsWith("/v1") || path === "/models" || path === "/healthz" || path === "/chat";
    if (apiish && (await handleApi(req, res, url))) return;

    if (await handlePanel(req, res, url)) return;

    if (apiish) return sendApi404(res, url);
    if (path.startsWith("/panel/api/")) return json(res, 404, errorPayload("not_found", `no panel route ${path}`));
    return sendHtml404(res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const payload = err instanceof HttpError ? errorPayload(err.code, err.message) : errorPayload("internal_error", err.message);
    if (status >= 500) console.error("[abltx]", err.message);
    if (res.headersSent) {
      res.end();
    } else if (path.startsWith("/v1") || path.startsWith("/panel/api") || path === "/models") {
      const extra = err instanceof HttpError && err.extra ? err.extra : {};
      json(res, status, payload, extra);
    } else {
      text(res, status, `abltx: ${status} ${payload.error.message}\n`);
    }
    if (!(status === 401 && path.startsWith("/panel/api"))) {
      pushLog({
        id: `${started}-err`,
        at: new Date().toISOString(),
        keyName: "-",
        path,
        status,
        ms: Date.now() - started,
        error: payload.error.message,
        client: clientIp(req),
      });
    }
  } finally {
    const label = `${req.method} ${path} -> ${res.statusCode}`;
    if (process.env.ABLTX_QUIET !== "1") console.log(`[abltx] ${label} ${Date.now() - started}ms`);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

function banner() {
  const url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const lines = [
    "",
    `  abltx v${VERSION} — free-pi as an API`,
    `  panel   ${url}/            (cookie login, blocked for curl)`,
    `  api     ${url}/v1/chat/completions`,
    `  models  ${url}/v1/models`,
    `  upstream ${config.upstreamBase}  ${describeToken()}`,
    `  аккаунтов: ${listAccountViews().length} (вход через браузер — вкладка «Аккаунты»)`,
    "",
  ];
  if (wasPasswordGenerated()) {
    lines.push(
      "",
      "  FIRST RUN: generated a panel password.",
      "    login page -> http://%host%:%port%/login",
      `    password   -> ${settings().__firstRunPassword}`,
      "    (also saved in data/first-run-password.txt)",
    );
  }
  lines.push("", "  Ctrl+C to stop", "");
  console.log(lines.join("\n").replaceAll("%host%", config.host === "0.0.0.0" ? "127.0.0.1" : config.host).replaceAll("%port%", String(config.port)));
}

function describeToken() {
  const t = tokenStatus();
  if (!t.present) return "нет аккаунта — добавьте в панели → «Аккаунты»";
  if (t.expired) return `аккаунт «${t.label}» истёк`;
  return `аккаунт «${t.label}», ${t.expiresInDays} дн.`;
}

const timer = setInterval(() => {
  pruneSessions();
  pruneLogins();
}, 10 * 60_000);
timer.unref?.();

server.listen(config.port, config.host, () => {
  banner();
  // warm the caches so the first panel load is instant
  Promise.allSettled([getModels().catch(() => {}), callMe().catch(() => {})]);
  if (process.argv.includes("--open") && process.platform === "linux") {
    spawn("xdg-open", [`http://127.0.0.1:${config.port}/`], { detached: true, stdio: "ignore" }).unref();
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[abltx] ${sig} — flushing state`);
    flushNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

export { server };
