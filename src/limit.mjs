// Per-key sliding-window rate limit + concurrency gate.
const windows = new Map();
const inflight = new Map();

export function checkRate(keyId, rpm) {
  if (!rpm || rpm <= 0) return { ok: true, remaining: Infinity };
  const now = Date.now();
  const bucket = windows.get(keyId) ?? [];
  const fresh = bucket.filter((t) => now - t < 60_000);
  if (fresh.length >= rpm) {
    windows.set(keyId, fresh);
    const retryAfter = Math.ceil((60_000 - (now - fresh[0])) / 1000);
    return { ok: false, retryAfter: Math.max(1, retryAfter), limit: rpm };
  }
  fresh.push(now);
  windows.set(keyId, fresh);
  return { ok: true, remaining: rpm - fresh.length };
}

export function acquire(keyId, max) {
  const used = inflight.get(keyId) ?? 0;
  if (max && used >= max) return false;
  inflight.set(keyId, used + 1);
  return true;
}

export function release(keyId) {
  const used = inflight.get(keyId) ?? 1;
  if (used <= 1) inflight.delete(keyId);
  else inflight.set(keyId, used - 1);
}

export function stats(keyId) {
  return { inflight: inflight.get(keyId) ?? 0, window: (windows.get(keyId) ?? []).length };
}

export function reset() {
  windows.clear();
  inflight.clear();
}
