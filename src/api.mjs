// OpenAI-compatible public API.
import { HttpError, clientIp, errorPayload, json, readJson, text } from "./util.mjs";
import { bearerToken, looksLikeJwt, verifyApiKey } from "./auth.mjs";
import { settings } from "./config.mjs";
import { FALLBACK_MODEL, callMe, chatCompletion, getModels, listAccountViews, resetOtherSessions, resolveAccount, resolveModelId, tokenStatus } from "./upstream.mjs";
import { acquire, checkRate, release } from "./limit.mjs";
import { pushLog, updateAccount, updateKey } from "./store.mjs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,x-api-key,x-session-id",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
  "access-control-expose-headers": "x-abltx-key,x-abltx-model,x-abltx-account,x-abltx-hint,x-ratelimit-remaining,retry-after",
};

let reqCounter = 0;

function authorized(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const key = verifyApiKey(token);
  if (key) return { kind: "key", key, token };
  if (settings().allowRawJwt && looksLikeJwt(token)) return { kind: "jwt", key: null, token };
  return null;
}

function limitKeyOf(auth) {
  return auth.kind === "key" ? auth.key.id : "jwt";
}

/** Which upstream account should serve this request. */
function accountRefFor(req, url, auth) {
  const fromHeader = req.headers["x-abltx-account"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const fromQuery = url.searchParams.get("account");
  if (fromQuery) return fromQuery;
  if (auth?.key?.accountId) return auth.key.accountId;
  return undefined;
}

function checkLimits(auth) {
  const cfg = settings();
  const id = limitKeyOf(auth);
  const rpm = auth.kind === "key" ? auth.key.rpm || cfg.rpm : cfg.rpm;
  const rate = checkRate(id, rpm);
  if (!rate.ok) {
    throw new HttpError(429, "rate_limit_exceeded", `rate limit: ${rate.limit} requests/minute`, {
      "retry-after": String(rate.retryAfter),
    });
  }
  if (!acquire(id, cfg.maxConcurrent)) {
    throw new HttpError(429, "too_many_concurrent", `more than ${cfg.maxConcurrent} concurrent requests for this key`);
  }
  return { id, rate };
}

function log(auth, entry) {
  pushLog({
    id: ++reqCounter,
    at: new Date().toISOString(),
    keyId: auth?.key?.id || null,
    keyName: auth?.key?.name || (auth?.kind === "jwt" ? "raw jwt" : "anonymous"),
    account: entry.account || null,
    accountId: entry.accountId || null,
    ...entry,
  });
  const key = auth?.key;
  if (key) {
    key.requests = (key.requests || 0) + 1;
    key.lastUsedAt = new Date().toISOString();
    key.promptTokens = (key.promptTokens || 0) + (entry.promptTokens || 0);
    key.completionTokens = (key.completionTokens || 0) + (entry.completionTokens || 0);
    updateKey(key.id, {});
  }
  if (entry.accountId) {
    const acc = resolveAccount(entry.accountId).account;
    if (acc) {
      updateAccount(acc.id, {
        requests: (acc.requests || 0) + 1,
        lastUsedAt: new Date().toISOString(),
        promptTokens: (acc.promptTokens || 0) + (entry.promptTokens || 0),
        completionTokens: (acc.completionTokens || 0) + (entry.completionTokens || 0),
      });
    }
  }
}

let lastSessionReset = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * free-pi allows only a handful of concurrent CLI sessions per account. When a
 * stale session blocks us (409 concurrent_session) we free the others once and
 * retry, so an API client never sees a puzzling error.
 */
async function completionWithRecovery(body, account) {
  const first = await chatCompletion(body, { account });
  if (first.res.status !== 409) return first;
  const raw = await first.res.text();
  if (!/concurrent_session/.test(raw)) {
    return { res: new Response(raw, { status: 409, headers: { "content-type": "application/json" } }) };
  }
  if (Date.now() - lastSessionReset > 60_000) {
    lastSessionReset = Date.now();
    try {
      await resetOtherSessions(account);
    } catch {}
    await sleep(1200);
  } else {
    await sleep(1500);
  }
  return await chatCompletion(body, { account });
}

/* --------------------------------- routes -------------------------------- */

export async function handleApi(req, res, url) {
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  if (path === "/healthz" || path === "/api/health") {
    const t = tokenStatus();
    json(res, 200, {
      ok: t.present && !t.expired,
      version: "1.0.0",
      upstream: t,
      models: (await getModels()).data.length,
    }, CORS_HEADERS);
    return true;
  }

  const auth = authorized(req);
  const accountRef = accountRefFor(req, url, auth);

  if (path === "/v1/accounts" || path === "/accounts") {
    json(
      res,
      200,
      {
        object: "list",
        data: listAccountViews().map((a) => ({
          id: a.id,
          label: a.label,
          handle: a.handle,
          source: a.source,
          active: a.active,
          expired: a.expired,
          expires_in_days: a.expiresInDays,
          balance: a.balance,
        })),
        selected: resolveAccount(accountRef).id,
      },
      CORS_HEADERS,
    );
    return true;
  }

  if (path === "/v1/models" || path === "/models") {
    if (auth && !settings().exposeModels) throw new HttpError(403, "models_hidden", "model list disabled");
    const { data, latest } = await getModels();
    const created = Math.floor(Date.now() / 1000);
    json(
      res,
      200,
      {
        object: "list",
        data: data.map((m) => ({
          id: m.id,
          object: "model",
          created,
          owned_by: "free-pi",
          root: m.id,
          parent: null,
          permission: [],
          name: m.name,
          section: m.section,
          usage_multiplier: m.usageMultiplier,
          premium: m.premium,
          context_window: 1048576,
          max_output_tokens: 8192,
        })),
        meta: { upstream: "free-pi", client_version: latest, auth: auth ? auth.kind : "none" },
      },
      CORS_HEADERS,
    );
    return true;
  }

  const modelMatch = /^\/v1\/models\/(.+)$/.exec(path);
  if (modelMatch && req.method === "GET") {
    const { data } = await getModels();
    const wanted = decodeURIComponent(modelMatch[1]);
    const hit = data.find((m) => m.id === wanted || m.statsId === wanted);
    if (!hit) throw new HttpError(404, "model_not_found", `unknown model: ${wanted}`);
    json(res, 200, { id: hit.id, object: "model", owned_by: "free-pi", name: hit.name, usage_multiplier: hit.usageMultiplier }, CORS_HEADERS);
    return true;
  }

  if (path === "/v1/me" || path === "/v1/usage") {
    if (!auth) throw new HttpError(401, "unauthorized", "missing API key");
    const resolved = selector(auth, accountRef);
    const t = tokenStatus(resolved);
    const me = t.present ? await callMe(resolved.token || resolved.account?.token) : { ok: false };
    const key = auth.key;
    json(
      res,
      200,
      {
        key: key ? { id: key.id, name: key.name, requests: key.requests, last_used_at: key.lastUsedAt, rpm: key.rpm } : { name: "raw jwt" },
        account: { id: t.id, label: t.label, source: t.source, expired: t.expired || false },
        upstream: me.ok && me.body
          ? {
              handle: me.body.handle,
              remaining_usd_today: me.body.remaining_usd_today,
              cap_usd_today: me.body.cap_usd_today,
              remaining_credits_today: me.body.remaining_credits_today,
              refill_at: me.body.refill_at,
              tier: me.body.tier,
            }
          : { error: "upstream /me unavailable" },
      },
      CORS_HEADERS,
    );
    return true;
  }

  if (path === "/v1/chat/completions" || path === "/chat/completions" || path === "/v1/completions") {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
    if (!auth) throw new HttpError(401, "unauthorized", "missing or invalid API key (Authorization: Bearer abltx_sk_...)");
    return handleChat(req, res, path, auth, accountRef);
  }

  return false;
}

/** Turn "who serves this request" into a concrete token source. */
function selector(auth, ref) {
  if (auth.kind === "jwt") return { kind: "raw", id: "raw", label: "raw jwt", token: auth.token };
  return resolveAccount(ref);
}

/* ---------------------------------- chat --------------------------------- */

async function handleChat(req, res, path, auth, accountRef) {
  const started = Date.now();
  const cfg = settings();
  const limits = checkLimits(auth);
  const keyId = limits.id;

  let body;
  try {
    body = await readJson(req, 8 * 1024 * 1024);
  } catch (err) {
    release(keyId);
    throw err;
  }

  const legacy = path.endsWith("/completions") && !path.includes("chat");
  if (legacy) {
    const prompt = body.prompt ?? body.input ?? "";
    body = {
      ...body,
      messages: Array.isArray(prompt)
        ? [{ role: "user", content: prompt.join("\n") }]
        : [{ role: "user", content: String(prompt) }],
    };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    release(keyId);
    throw new HttpError(400, "bad_request", "`messages` is required and must be a non-empty array");
  }

  body.model = await resolveModelId(body.model);
  const stream = body.stream === true;
  if (stream && !body.stream_options) body.stream_options = { include_usage: true };

  let upstreamRes;
  const accountUsed = selector(auth, accountRef);
  try {
    ({ res: upstreamRes } = await completionWithRecovery(body, accountUsed));
  } catch (err) {
    release(keyId);
    const t = tokenStatus();
    log(auth, { path, model: body.model, status: 503, ms: Date.now() - started, account: accountUsed.label, accountId: accountUsed.id, error: err.message });
    throw new HttpError(err.status || 503, err.code || "upstream_unreachable", err.message, {
      hint: t.present ? undefined : "paste a free-pi token in the panel (/panel → Upstream)",
    });
  }

  if (!upstreamRes.ok) {
    const raw = await upstreamRes.text().catch(() => "");
    release(keyId);
    log(auth, { path, model: body.model, status: upstreamRes.status, ms: Date.now() - started, account: accountUsed.label, accountId: accountUsed.id, error: raw.slice(0, 300) });
    const headers = { ...CORS_HEADERS, "content-type": upstreamRes.headers.get("content-type") || "application/json" };
    if (upstreamRes.status === 401) headers["x-abltx-hint"] = "upstream token rejected by free-pi";
    if (/hourly_ceiling|allowance_exhausted/.test(raw)) headers["x-abltx-hint"] = "daily free-pi allowance used up, slow lane active";
    const retryAfter = upstreamRes.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    res.writeHead(upstreamRes.status, headers);
    res.end(raw || JSON.stringify(errorPayload("upstream_error", "upstream error")));
    return true;
  }

  const headers = {
    ...CORS_HEADERS,
    "x-abltx-key": auth.key?.name || "raw-jwt",
    "x-abltx-model": body.model,
    "x-abltx-account": encodeURIComponent(accountUsed.label),
    "x-ratelimit-remaining": String(limits.rate.remaining ?? ""),
  };

  if (!stream) {
    const payload = await upstreamRes.json().catch(() => null);
    release(keyId);
    if (!payload) {
      log(auth, { path, model: body.model, status: 502, ms: Date.now() - started, error: "bad upstream json" });
      throw new HttpError(502, "bad_upstream_response", "upstream returned invalid JSON");
    }
    log(auth, {
      path,
      model: payload.model || body.model,
      status: 200,
      ms: Date.now() - started,
      account: accountUsed.label,
      accountId: accountUsed.id,
      promptTokens: payload.usage?.prompt_tokens || 0,
      completionTokens: payload.usage?.completion_tokens || 0,
      client: clientIp(req),
    });
    const out = JSON.stringify(payload);
    res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(out) });
    res.end(out);
    return true;
  }

  // ---- streaming: tee the SSE stream so we can read usage at the end ------
  res.writeHead(200, {
    ...headers,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let usage = null;
  let aborted = false;

  req.on("close", () => {
    if (res.writableEnded) return;
    aborted = true;
    reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
      if (aborted) break;
      seen += decoder.decode(value, { stream: true });
      if (seen.length > 200_000) seen = seen.slice(-100_000);
      if (seen.includes("total_tokens")) {
        const all = [...seen.matchAll(/"usage":\s*(\{[^{}]*"total_tokens"[^{}]*\})/g)];
        if (all.length) {
          try {
            usage = JSON.parse(all[all.length - 1][1]);
          } catch {}
        }
      }
    }
  } catch (err) {
    if (!aborted) log(auth, { path, model: body.model, status: 499, ms: Date.now() - started, error: "stream: " + err.message });
  } finally {
    release(keyId);
    if (!res.writableEnded) res.end();
  }

  if (!aborted) {
    log(auth, {
      path,
      model: body.model,
      status: 200,
      stream: true,
      ms: Date.now() - started,
      account: accountUsed.label,
      accountId: accountUsed.id,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens: usage?.completion_tokens || 0,
      client: clientIp(req),
    });
  }
  return true;
}

/* ------------------------------ CLI landing ------------------------------ */

export function apiLanding() {
  return [
    "abltx — free-pi as an API.",
    "",
    "You are seeing plain text because the request looks like it came from a CLI",
    "(curl/wget/...). The dashboard itself needs a browser + login cookie:",
    "",
    "  dashboard : open " + "http://<host>:<port>/" + " in a browser and sign in",
    "  API       : works fine from curl, no cookies needed",
    "",
    "Endpoints:",
    "  GET  /v1/models              (no auth required)",
    "  GET  /v1/accounts            (accounts + which one is active)",
    "  POST /v1/chat/completions    (Authorization: Bearer abltx_sk_...)",
    "  GET  /v1/me                  (key + allowance)",
    "  GET  /healthz",
    "",
    "Example:",
    "  curl -s http://127.0.0.1:8787/v1/chat/completions \\",
    '    -H "Authorization: Bearer $ABLTX_KEY" -H "content-type: application/json" \\',
    `    -d '{"model":"${FALLBACK_MODEL}","messages":[{"role":"user","content":"hi"}]}'`,
    "",
  ].join("\n");
}

export function sendApi404(res, url) {
  text(res, 404, `abltx: no API route for ${url.pathname}\n\n` + apiLanding(), CORS_HEADERS);
}
