// Pending web sign-ins (browser connect flow + GitHub device code) for the panel.
import { newId, HttpError } from "./util.mjs";
import { createAccount, pollLogin, startBrowserLogin, startDeviceLogin, submitLoginConsent } from "./upstream.mjs";

const pending = new Map();
const TTL_MS = 20 * 60_000;

export function startLogin({ mode = "browser", label = "" } = {}) {
  const id = newId();
  const created = Date.now();
  const login = {
    id,
    mode,
    label: label.trim() || `аккаунт ${new Date().toLocaleDateString()}`,
    createdAt: created,
    expiresAt: created + TTL_MS,
    status: "starting",
    error: null,
    nextPollAt: 0,
    account: null,
  };
  pending.set(id, login);
  login.ready = (async () => {
    try {
      const started = mode === "device" ? await startDeviceLogin() : await startBrowserLogin();
      Object.assign(login, {
        status: "waiting",
        sessionId: started.sessionId,
        pollSecret: started.pollSecret,
        code: started.code || started.confirmCode,
        confirmCode: started.confirmCode || started.code,
        url: started.url,
        interval: started.interval,
        deadline: created + (started.expiresIn || 600) * 1000,
        nextPollAt: Date.now() + (started.interval || 2) * 1000,
      });
      login.expiresAt = login.deadline;
    } catch (err) {
      login.status = "error";
      login.error = err.message;
    }
  })();
  return login;
}

export function getLogin(id) {
  const login = pending.get(id);
  if (!login) throw new HttpError(404, "login_not_found", `unknown login ${id}`);
  return login;
}

export function cancelLogin(id) {
  const login = pending.get(id);
  if (!login) return false;
  pending.delete(id);
  return true;
}

/** Advance one pending login; returns the login (status: waiting|done|error|expired|denied). */
export async function pollLoginState(id) {
  const login = getLogin(id);
  await login.ready;
  if (["done", "error", "expired", "denied"].includes(login.status)) return login;
  if (Date.now() > login.expiresAt) {
    login.status = "expired";
    return login;
  }
  if (Date.now() < login.nextPollAt) return login;

  const out = await pollLogin(login);
  if (out.status === "token") {
    login.status = "done";
    login.account = createAccount({ token: out.token, label: login.label, source: login.mode === "device" ? "device" : "browser" });
    return login;
  }
  if (out.status === "consent") {
    login.nextPollAt = Date.now() + 1500;
    await submitLoginConsent(login.sessionId).catch(() => {});
    return login;
  }
  if (out.status === "denied" || out.status === "expired") {
    login.status = out.status;
    return login;
  }
  login.nextPollAt = Date.now() + (out.retryAfter > 0 ? out.retryAfter : login.interval || 2) * 1000;
  if (out.error) login.lastNote = out.error;
  return login;
}

export function loginView(login) {
  return {
    id: login.id,
    mode: login.mode,
    label: login.label,
    status: login.status,
    error: login.error,
    code: login.code,
    url: login.url,
    expiresAt: login.expiresAt,
    account: login.account,
  };
}

export function pruneLogins() {
  const now = Date.now();
  for (const [id, login] of pending) {
    if (now - login.createdAt > 60 * 60_000) pending.delete(id);
  }
}
