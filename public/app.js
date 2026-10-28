// abltx panel — vanilla ESM, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) node.append(k.nodeType ? k : String(k));
  return node;
};

const state = {
  csrf: sessionStorage.getItem("abltx_csrf") || "",
  data: null,
  view: location.hash.slice(1) || "overview",
  chat: [],
  busy: false,
};

/* ------------------------------- transport ------------------------------- */

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/panel/api/" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "x-abltx-csrf": state.csrf }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error("нужен вход");
  }
  if (!res.ok) throw new Error(payload.error?.message || payload.error || `HTTP ${res.status}`);
  return payload;
}

function toast(message, kind = "ok") {
  const node = el("div", { className: "toast " + kind, textContent: message });
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

function copy(value) {
  navigator.clipboard.writeText(value).then(
    () => toast("Скопировано"),
    () => toast("Не удалось скопировать", "bad"),
  );
}

function copyLine(value, label) {
  return el(
    "div",
    { className: "copyline" },
    el("code", { textContent: value }),
    el("button", { className: "tiny", textContent: "copy", onclick: () => copy(value), title: label }),
  );
}

/* --------------------------------- auth ---------------------------------- */

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}

async function login(event) {
  event.preventDefault();
  const password = $("#password").value;
  $("#login-error").hidden = true;
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "не пускает");
    state.csrf = payload.csrf;
    sessionStorage.setItem("abltx_csrf", payload.csrf);
    $("#password").value = "";
    await boot();
  } catch (err) {
    const box = $("#login-error");
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function logout() {
  await api("logout", { method: "POST" }).catch(() => {});
  sessionStorage.removeItem("abltx_csrf");
  showLogin();
}

/* --------------------------------- views --------------------------------- */

const views = {
  overview: renderOverview,
  accounts: renderAccounts,
  models: renderModels,
  keys: renderKeys,
  playground: renderPlayground,
  logs: renderLogs,
  settings: renderSettings,
  docs: renderDocs,
};

const titles = {
  overview: ["Обзор", "Статус free-pi, адрес API и быстрый старт"],
  accounts: ["Аккаунты free-pi", "Вход через браузер, несколько аккаунтов, переключение в один клик"],
  models: ["Модели", "Каталог моделей, доступных через ваш ключ"],
  keys: ["API-ключи", "Ключи для клиентов: OpenAI SDK, curl, ваши приложения"],
  playground: ["Плейграунд", "Чат прямо в панели, без ключа"],
  logs: ["Логи", "Последние запросы к API"],
  settings: ["Настройки", "Лимиты, upstream-токен, пароль"],
  docs: ["Документация", "Как подключиться из curl, Python и Node"],
};

function setView(name) {
  state.view = name;
  location.hash = name;
  for (const btn of document.querySelectorAll("#nav button")) btn.classList.toggle("active", btn.dataset.view === name);
  const [title, sub] = titles[name] || titles.overview;
  $("#view-title").textContent = title;
  $("#view-sub").textContent = sub;
  const view = $("#view");
  view.replaceChildren();
  (views[name] || renderOverview)(view);
}

function keySnippet(key) {
  return `export OPENAI_BASE_URL=${state.data.baseUrl}/v1
export OPENAI_API_KEY=${key || "<ваш abltx_sk_...>"}
curl -s $OPENAI_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"${state.data.models[0]?.id || "deepseek-v4-flash"}","messages":[{"role":"user","content":"привет"}]}'`;
}

function upstreamBanner(view) {
  const up = state.data.upstream;
  if (up.present && up.reachable && !up.expired) {
    if (!state.data.accounts?.length) {
      const hint = el("div", { className: "banner ok" },
        el("span", { textContent: "☺" }),
        el("span", { textContent: "Токен берётся из файла free-pi-cli. Чтобы больше не зависеть от файла — войдите в браузере:" }),
        el("button", { className: "tiny", textContent: "Войти через браузер", onclick: () => { setView("accounts"); startLoginFlow("browser", ""); } }),
      );
      view.append(hint);
    }
    return;
  }
  const text = !up.present
    ? "Нет аккаунта free-pi. Нажмите «Войти через браузер» — откроется freepi.ai, как в CLI."
    : up.expired
      ? "Токен аккаунта истёк. Войдите заново на вкладке «Аккаунты»."
      : "free-pi недоступен для проверки (или токен отклонён).";
  view.append(
    el("div", { className: "banner" + (up.expired || !up.present ? " bad" : "") },
      el("span", { textContent: "⚠" }),
      el("span", { textContent: text }),
      el("button", { className: "tiny", textContent: "Войти", onclick: () => { setView("accounts"); startLoginFlow("browser", ""); } }),
    ),
  );
}

function renderOverview(view) {
  upstreamBanner(view);
  const up = state.data.upstream;
  const first = state.data.keys[0];
  const grid = el("div", { className: "grid three" });

  grid.append(
    el(
      "div",
      { className: "card" },
      el("div", { className: "stat-label", textContent: "Остаток сегодня" }),
      el("div", { className: "stat", textContent: up.remaining_usd_today != null ? `$${Number(up.remaining_usd_today).toFixed(3)}` : "—" }),
      el("p", {
        className: "hint",
        textContent: up.refill_at ? `сброс ${new Date(up.refill_at).toLocaleString()}` : "данные с api.freepi.ai",
      }),
    ),
    el(
      "div",
      { className: "card" },
      el("div", { className: "stat-label", textContent: "Аккаунт" }),
      el("div", { className: "stat", textContent: state.data.activeLabel || "—" }),
      el("div", { className: "row", style: "margin-top:6px" },
        el("span", { className: "hint", textContent: `${up.handle || "без имени"} · аккаунтов: ${state.data.accounts?.length ?? 0}` }),
        el("button", { className: "tiny ghost", textContent: "сменить", onclick: () => setView("accounts") }),
      ),
      up.lane === "slow" || up.lane === "fallback" ? el("p", { className: "hint", textContent: `⚠ дневной лимит выбран — режим ${up.lane} lane` }) : "",
      up.cap_usd_today != null ? el("p", { className: "hint", textContent: `${up.tier || ""}${up.tier ? " · " : ""}refill ${up.refill_at ? new Date(up.refill_at).toLocaleString() : "—"}` }) : "",
    ),
    el(
      "div",
      { className: "card" },
      el("div", { className: "stat-label", textContent: "Токен free-pi" }),
      el("div", { className: "stat", textContent: up.present ? `${up.expiresInDays} дн.` : "нет" }),
      el("p", { className: "hint", textContent: `источник: ${up.source} · моделей: ${state.data.models.length}` }),
    ),
  );
  view.append(grid);

  const start = el("div", { className: "card" });
  start.append(
    el("h3", { textContent: "Подключение за 10 секунд" }),
    el("p", { className: "card-sub", textContent: "Любой OpenAI-совместимый клиент. Дашборд в браузере, API — из curl и кода." }),
    el("div", { className: "field" }, el("label", { textContent: "Base URL" }), copyLine(`${state.data.baseUrl}/v1`)),
    el("div", { className: "field" }, el("label", { textContent: "API-ключ" }), copyLine(first ? first.prefix + "…" + first.last4 : "создайте на вкладке API-ключи")),
    el("pre", { className: "code", textContent: keySnippet() }),
  );
  view.append(start);

  const recent = el("div", { className: "card" });
  recent.append(
    el("div", { className: "row between" }, el("h3", { textContent: "Последние запросы" }), el("button", { className: "tiny ghost", textContent: "все логи", onclick: () => setView("logs") })),
    logTable(state.data.logs.slice(0, 8)),
  );
  view.append(recent);
}

function logTable(logs) {
  if (!logs?.length) return el("p", { className: "muted", textContent: "Пока пусто." });
  const table = el("table");  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { textContent: "время" }),
        el("th", { textContent: "ключ" }),
        el("th", { textContent: "аккаунт" }),
        el("th", { textContent: "модель" }),
        el("th", { textContent: "статус" }),
        el("th", { textContent: "токены" }),
        el("th", { textContent: "мс" }),
      ),
    ),
  );
  const body = el("tbody");
  for (const l of logs) {
    body.append(
      el(
        "tr",
        {},
        el("td", { className: "muted", textContent: new Date(l.at).toLocaleTimeString() }),
        el("td", { textContent: l.keyName || "—" }),
        el("td", { className: "muted", textContent: l.account || l.keyAccount || "—" }),
        el("td", { className: "mono", textContent: l.model || "—" }),
        el("td", {}, el("span", { className: "tag " + (l.status < 400 ? "ok" : "bad"), textContent: String(l.status) }), l.stream ? el("span", { className: "muted", textContent: " stream" }) : ""),
        el("td", { className: "muted", textContent: `${l.promptTokens || 0}/${l.completionTokens || 0}` }),
        el("td", { className: "muted", textContent: String(l.ms ?? "") }),
      ),
    );
  }
  table.append(body);
  return el("div", { className: "table-wrap" }, table);
}

function renderAccounts(view) {
  const accounts = state.data.accounts || [];

  const add = el("div", { className: "card" });
  const label = el("input", { placeholder: "подпись, напр. «аккаунт 2 / работа»" });
  const box = el("div", { className: "grid two" },
    el("div", { className: "field" }, el("label", { textContent: "Название (чтобы различать аккаунты)" }), label),
    el("div", { className: "field" }, el("label", { textContent: "Аккаунтов сейчас" }), el("div", { className: "mono", style: "padding:11px 13px", textContent: String(accounts.length) })),
  );
  add.append(
    el("h3", { textContent: "Добавить аккаунт free-pi" }),
    el("p", { className: "card-sub", textContent: "Вход такой же, как в CLI: откроется страница freepi.ai, вы жмёте «Разрешить» — дашборд сам сохранит токен и подтянет баланс. Терминал и файлы не нужны." }),
    box,
    el("div", { className: "row" },
      el("button", { className: "primary", textContent: "Войти через браузер ↗", onclick: () => startLoginFlow("browser", label.value) }),
      el("button", { className: "ghost", textContent: "GitHub device-code", onclick: () => startLoginFlow("device", label.value) }),
      el("button", { className: "ghost", textContent: "Импорт из файла free-pi-cli", onclick: async () => {
        try {
          await api("accounts/import-file", { method: "POST" });
          toast("Токен из файла добавлен");
          refresh();
        } catch (err) { toast(err.message, "bad"); }
      } }),
    ),
    el("details", { style: "margin-top:14px" },
      el("summary", { className: "muted", textContent: "Вставить JWT вручную" }),
      el("div", { className: "field", style: "margin-top:10px" }, el("textarea", { id: "manual-token", placeholder: "eyJhbGciOi..." })),
      el("button", { className: "tiny", textContent: "Сохранить токен", onclick: async () => {
        try {
          await api("accounts", { method: "POST", body: { token: $("#manual-token").value.trim(), label: label.value } });
          toast("Аккаунт добавлен");
          refresh();
        } catch (err) { toast(err.message, "bad"); }
      } }),
    ),
    el("div", { id: "login-status", hidden: true, style: "margin-top:14px" }),
  );
  view.append(add);

  const table = el("div", { className: "card" });
  table.append(el("h3", { textContent: "Аккаунты" }));
  const wrap = el("div", { className: "table-wrap" });
  const tbl = el("table");
  tbl.append(el("thead", {}, el("tr", {}, ...["активный", "название", "аккаунт", "остаток сегодня", "токен", "запросы", ""].map((h) => el("th", { textContent: h })))));
  const body = el("tbody");
  for (const a of accounts) {
    const use = el("input", { type: "radio", name: "active-account", checked: a.active, style: "width:16px;height:16px;accent-color:var(--accent)" });
    use.onchange = async () => {
      await api(`accounts/${a.id}/activate`, { method: "POST" });
      toast(`Активный аккаунт: ${a.label}`);
      refresh();
    };
    const rename = el("button", { className: "tiny ghost", textContent: "✎" });
    rename.onclick = async () => {
      const next = prompt("Новое название", a.label);
      if (!next) return;
      await api(`accounts/${a.id}`, { method: "PATCH", body: { label: next } });
      refresh();
    };
    const del = el("button", { className: "tiny danger", textContent: "удалить" });
    del.onclick = async () => {
      if (!confirm(`Удалить аккаунт «${a.label}»?`)) return;
      await api(`accounts/${a.id}`, { method: "DELETE" });
      toast("Удалён");
      refresh();
    };
    const bal = a.balance?.remaining_usd_today;
    const actions = el("div", { className: "row" },
      el("button", { className: "tiny ghost", textContent: "обновить", onclick: async () => {
        await api(`accounts/${a.id}/refresh`, { method: "POST" });
        toast("Данные обновлены");
        refresh();
      } }),
      a.readOnly ? "" : rename,
      a.readOnly ? "" : del,
    );
    const row = el("tr", {},
      el("td", {}, use),
      el("td", {}, el("span", { textContent: a.label }), a.readOnly ? el("span", { className: "muted", textContent: " (токен из файла free-pi-cli)" }) : ""),
      el("td", {}, el("div", { className: "mono", textContent: a.handle || a.subject?.slice(0, 8) || "—" }), el("span", { className: "muted", textContent: a.source })),
      el("td", { textContent: bal != null ? `$${Number(bal).toFixed(3)}` : "—" }),
      el("td", {}, el("span", { className: "tag " + (a.expired ? "bad" : "ok"), textContent: a.expired ? "истёк" : `${a.expiresInDays} дн.` }), a.balance?.lane && a.balance.lane !== "standard" ? el("span", { className: "tag premium", textContent: a.balance.lane }) : ""),
      el("td", { className: "muted", textContent: String(a.requests ?? "—") }),
      el("td", { className: "right" }, actions),
    );
    body.append(row);
  }
  if (!accounts.length) body.append(el("tr", {}, el("td", { colSpan: 7, className: "muted", textContent: "Пока нет аккаунтов." })));
  tbl.append(body);
  wrap.append(tbl);
  table.append(wrap);
  view.append(table);
}

async function startLoginFlow(mode, label) {
  const box = $("#login-status");
  box.hidden = false;
  box.replaceChildren(el("p", { textContent: mode === "device" ? "Готовлю device-code…" : "Открываю free-pi…" }));
  let login;
  try {
    const res = await api("accounts/login/start", { method: "POST", body: { mode, label } });
    login = res.login;
  } catch (err) {
    box.replaceChildren(el("p", { className: "error", textContent: err.message }));
    return;
  }
  if (login.status === "error") {
    box.replaceChildren(el("p", { className: "error", textContent: login.error || "не удалось начать вход" }));
    return;
  }
  if (login.url && mode === "browser") window.open(login.url, "_blank", "noopener");

  const code = el("div", { className: "stat mono", textContent: login.code || "…" });
  const link = el("a", { href: login.url, target: "_blank", rel: "noopener", textContent: login.url });
  const status = el("p", { className: "hint", textContent: mode === "browser"
    ? "Открыл вкладку freepi.ai — войдите через GitHub и подтвердите код (он должен совпадать)."
    : "Откройте ссылку на github.com/login/device и введите код ниже." });
  box.replaceChildren(
    el("h3", { textContent: mode === "browser" ? "Подтверждение в браузере" : "GitHub device-code" }),
    code,
    el("p", { className: "field" }, link),
    status,
    el("button", { className: "tiny ghost", textContent: "отменить", onclick: async () => {
      await api(`accounts/login/${login.id}`, { method: "DELETE" });
      box.hidden = true;
    } }),
  );
  if (login.url) copy(login.url);

  clearInterval(state.loginTimer);
  state.loginTimer = setInterval(async () => {
    let res;
    try {
      res = await api(`accounts/login/${login.id}`);
    } catch {
      return;
    }
    const st = res.login;
    if (st.status === "waiting") return;
    clearInterval(state.loginTimer);
    if (st.status === "done") {
      status.textContent = `Готово: аккаунт «${st.account?.label || ""}» добавлен и выбран активным.`;
      status.className = "hint";
      code.textContent = "✓";
      toast("Аккаунт добавлен");
      await refresh();
    } else {
      status.textContent = st.status === "denied" ? "Вход отменён в браузере." : st.status === "expired" ? "Код истёк, попробуйте снова." : `Ошибка: ${st.error || st.status}`;
      status.className = "error";
    }
  }, 2500);
}

function renderModels(view) {
  upstreamBanner(view);
  view.append(
    el("div", { className: "banner ok" }, el("span", { textContent: "ℹ" }), el("span", { textContent: "Значение в поле model — это id из таблицы. Префикс free-pi/ тоже принимается. Цена указана в «?x usage» — так модель списывает дневной лимит." })),
  );
  const main = el("div", { className: "grid two" });
  for (const m of state.data.models) {
    const tags = el("div", { className: "row" });
    if (m.section === "defense") tags.append(el("span", { className: "tag defense", textContent: "defense" }));
    if (m.premium) tags.append(el("span", { className: "tag premium", textContent: "premium" }));
    if (m.usageMultiplier !== 1) tags.append(el("span", { className: "tag", textContent: `~${m.usageMultiplier}x usage` }));
    else tags.append(el("span", { className: "tag ok", textContent: "1x usage" }));
    const card = el("div", { className: "card" });
    card.append(
      el("div", { className: "row between" }, el("strong", { textContent: m.label }), tags),
      el("div", { className: "field", style: "margin-top:12px" }, el("label", { textContent: "model id" }), copyLine(m.id)),
      el("p", { className: "hint", textContent: `upstream: ${m.statsId} · context 1M · max output 8192` }),
    );
    main.append(card);
  }
  view.append(main);
}

function renderKeys(view) {
  const form = el("form", { className: "card" });
  form.append(
    el("h3", { textContent: "Новый ключ" }),
    el("p", { className: "card-sub", textContent: "Ключ показывается один раз. Хранится только его SHA-256." }),
    el("div", { className: "grid two" },
      el("div", { className: "field" }, el("label", { textContent: "Название" }), el("input", { name: "name", placeholder: "ноутбук / бот / коллега", required: true })),
      el("div", { className: "field" }, el("label", { textContent: "Лимит, запросов в минуту (0 = общий)" }), el("input", { name: "rpm", type: "number", min: "0", value: "0" })),
    ),
    el("button", { className: "primary", type: "submit", textContent: "Создать ключ" }),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = await api("keys", { method: "POST", body: { name: fd.get("name"), rpm: Number(fd.get("rpm") || 0) } });
    toast("Ключ создан");
    state.data.keys.unshift(payload.record);
    const box = $("#fresh-key");
    box.replaceChildren(
      el("h3", { textContent: "Скопируйте ключ сейчас" }),
      copyLine(payload.key),
      el("p", { className: "hint", textContent: "Он больше не будет показан полностью." }),
    );
    box.hidden = false;
    form.reset();
    renderTable($("#keys-table"), state.data.keys);
  };
  view.append(form);

  const fresh = el("div", { className: "card", hidden: true, id: "fresh-key" });
  view.append(fresh);

  const table = el("div", { className: "card", id: "keys-table" });
  table.append(el("h3", { textContent: "Существующие ключи" }));
  renderTable(table, state.data.keys);
  view.append(table);
}

function renderTable(container, keys) {
  container.querySelectorAll(".table-wrap, table, p.muted").forEach((n) => n.remove());
  container.append(logKeysTable(keys, container));
}

function logKeysTable(keys, container) {
  if (!keys.length) return el("p", { className: "muted", textContent: "Ключей пока нет." });
  const rerender = () => renderTable(container, state.data.keys);
  const table = el("table");
  table.append(
    el("thead", {}, el("tr", {}, ...["название", "ключ", "аккаунт", "rpm", "запросы", "токены", "последний раз", ""].map((h) => el("th", { textContent: h })))),
  );
  const body = el("tbody");
  for (const k of keys) {
    const del = el("button", { className: "tiny danger", textContent: "удалить" });
    del.onclick = async () => {
      if (!confirm(`Удалить ключ «${k.name}»?`)) return;
      await api("keys/" + k.id, { method: "DELETE" });
      state.data.keys = state.data.keys.filter((x) => x.id !== k.id);
      rerender();
      toast("Удалён");
    };
    const toggle = el("button", { className: "tiny ghost", textContent: k.enabled ? "off" : "on" });
    toggle.onclick = async () => {
      const rec = await api("keys/" + k.id, { method: "PATCH", body: { enabled: !k.enabled } });
      Object.assign(k, rec.record);
      rerender();
    };
    const picker = el("select");
    picker.style.width = "auto";
    picker.append(el("option", { value: "", textContent: "— активный" }));
    for (const a of state.data.accounts || []) picker.append(el("option", { value: a.id, textContent: a.label, selected: k.accountId === a.id }));
    picker.onchange = async () => {
      const rec = await api("keys/" + k.id, { method: "PATCH", body: { accountId: picker.value || null } });
      Object.assign(k, rec.record);
      toast(picker.value ? "Ключ привязан к аккаунту" : "Ключ использует активный аккаунт");
    };
    body.append(
      el(
        "tr",
        {},
        el("td", { textContent: k.name }),
        el("td", { className: "mono", textContent: k.prefix + "…" + k.last4 }),
        el("td", {}, picker),
        el("td", { textContent: k.rpm ? String(k.rpm) : "общий" }),
        el("td", { textContent: String(k.requests) }),
        el("td", { className: "muted", textContent: `${k.promptTokens}/${k.completionTokens}` }),
        el("td", { className: "muted", textContent: k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—" }),
        el("td", { className: "right" }, el("div", { className: "row" }, toggle, del)),
      ),
    );
  }
  table.append(body);
  return el("div", { className: "table-wrap" }, table);
}

/* ------------------------------- playground ------------------------------- */

function renderPlayground(view) {
  const wrap = el("div", { className: "chat" });
  const controls = el("div", { className: "card" });
  const modelSelect = el("select", { name: "model" });
  for (const m of state.data.models) modelSelect.append(el("option", { value: m.id, textContent: m.label }));
  const system = el("textarea", { name: "system", placeholder: "System prompt (необязательно)" });
  const temp = el("input", { name: "temperature", type: "number", step: "0.1", min: "0", max: "2", value: "0.7" });
  controls.append(
    el("div", { className: "grid two" },
      el("div", { className: "field" }, el("label", { textContent: "Модель" }), modelSelect),
      el("div", { className: "field" }, el("label", { textContent: "Temperature" }), temp),
    ),
    el("div", { className: "field" }, el("label", { textContent: "System" }), system),
    el("div", { className: "row" }, el("button", { className: "tiny ghost", id: "chat-clear", textContent: "Очистить историю" })),
  );

  const log = el("div", { className: "chat-log", id: "chat-log" });
  const form = el("form", { className: "row" });
  const input = el("textarea", { name: "prompt", placeholder: "Спросите что-нибудь… (Ctrl+Enter — отправить)", required: true, style: "flex:1" });
  form.append(input, el("button", { className: "primary", type: "submit", textContent: "Отправить ▶" }));

  wrap.append(controls, log, form);
  view.append(wrap);
  paintChat(log);

  $("#chat-clear").onclick = () => {
    state.chat = [];
    paintChat(log);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    sendChat(input, log, { model: modelSelect.value, system: system.value, temperature: Number(temp.value) });
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  };
}

function paintChat(log) {
  log.replaceChildren();
  if (!state.chat.length) log.append(el("p", { className: "muted", textContent: "История пуста. Плейграунд ходит в free-pi напрямую — ключ не нужен." }));
  for (const m of state.chat) {
    log.append(
      el("div", { className: "msg " + m.role }, el("div", { className: "who", textContent: m.role === "user" ? "вы" : m.role === "assistant" ? "модель" : "reasoning" }), el("div", { textContent: m.content })),
    );
  }
  log.scrollTop = log.scrollHeight;
}

async function sendChat(input, log, opts) {
  const prompt = input.value.trim();
  if (!prompt || state.busy) return;
  input.value = "";
  state.chat.push({ role: "user", content: prompt });
  paintChat(log);
  state.busy = true;

  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  for (const m of state.chat) if (m.role !== "reasoning") messages.push({ role: m.role, content: m.content });

  const bubble = el("div", { className: "msg assistant" }, el("div", { className: "who", textContent: "модель" }), el("div", { textContent: "…" }));
  log.append(bubble);
  const target = bubble.lastChild;
  let text = "";
  let reasoning = "";

  try {
    const res = await fetch("/panel/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-abltx-csrf": state.csrf },
      body: JSON.stringify({ model: opts.model, messages, temperature: opts.temperature, stream: true }),
    });
    if (!res.ok || !res.body) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error?.message || payload.body?.error?.message || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (delta.content) {
          text += delta.content;
          target.textContent = text;
        }
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    target.textContent = "⚠ " + err.message;
    state.busy = false;
    return;
  }
  state.chat.push({ role: "assistant", content: text || "(пусто)" });
  if (reasoning) state.chat.push({ role: "reasoning", content: reasoning });
  state.busy = false;
  paintChat(log);
}

function renderLogs(view) {
  const card = el("div", { className: "card" });
  card.append(
    el("div", { className: "row between" }, el("h3", { textContent: `Последние ${state.data.logs.length} запросов` }), el("button", { className: "tiny ghost", textContent: "обновить", onclick: refresh })),
    logTable(state.data.logs),
  );
  view.append(card);
}

function renderSettings(view) {
  const up = state.data.upstream;
  const tokenCard = el("div", { className: "card" });
  tokenCard.append(
    el("h3", { textContent: "Upstream и аккаунты free-pi" }),
    el("p", { className: "card-sub", textContent: `Аккаунтов: ${state.data.accounts?.length ?? 0}, активный: ${state.data.activeLabel || "—"}. Добавление и переключение — на вкладке «Аккаунты».` }),
    el("div", { className: "row" },
      el("button", { className: "primary", textContent: "Открыть аккаунты", onclick: () => setView("accounts") }),
      el("button", { className: "ghost", textContent: "Обновить каталог моделей", onclick: async () => {
        const r = await api("upstream/refresh-models", { method: "POST" });
        toast(`Моделей: ${r.count}`);
        refresh();
      } }),
      el("button", { className: "ghost", textContent: "Освободить чужие сессии free-pi", onclick: async () => {
        const r = await api("upstream/reset-sessions", { method: "POST" });
        toast(r.released ? "Сессии освобождены" : "Занятых сессий не было", r.ok ? "ok" : "bad");
      } }),
      el("button", { className: "ghost", textContent: "Импорт токена из файла free-pi-cli", onclick: async () => {
        try {
          await api("accounts/import-file", { method: "POST" });
          toast("Токен из файла добавлен");
          refresh();
        } catch (err) { toast(err.message, "bad"); }
      } }),
    ),
  );

  const s = state.data.settings;
  const limits = el("div", { className: "card" });
  const rpm = el("input", { type: "number", min: "1", value: String(s.rpm) });
  const conc = el("input", { type: "number", min: "1", value: String(s.maxConcurrent) });
  limits.append(
    el("h3", { textContent: "Лимиты API" }),
    el("div", { className: "grid two" },
      el("div", { className: "field" }, el("label", { textContent: "Запросов в минуту (по умолчанию)" }), rpm),
      el("div", { className: "field" }, el("label", { textContent: "Одновременных запросов" }), conc),
    ),
    el("div", { className: "row" },
      el("button", { className: "primary", textContent: "Сохранить", onclick: async () => {
        await api("settings", { method: "POST", body: { rpm: Number(rpm.value), maxConcurrent: Number(conc.value) } });
        toast("Сохранено");
        refresh();
      } }),
      el("button", { className: "ghost", textContent: "Сбросить кэш моделей", onclick: async () => {
        await api("upstream/refresh-models", { method: "POST" });
        toast("Каталог обновлён");
        refresh();
      } }),
    ),
  );

  const pass = el("div", { className: "card" });
  const cur = el("input", { type: "password", autocomplete: "current-password" });
  const next = el("input", { type: "password", autocomplete: "new-password" });
  pass.append(
    el("h3", { textContent: "Пароль панели" }),
    el("div", { className: "grid two" },
      el("div", { className: "field" }, el("label", { textContent: "Текущий" }), cur),
      el("div", { className: "field" }, el("label", { textContent: "Новый (мин. 6 символов)" }), next),
    ),
    el("button", { className: "primary", textContent: "Сменить пароль", onclick: async () => {
      await api("password", { method: "POST", body: { current: cur.value, next: next.value } });
      toast("Пароль обновлён");
      cur.value = next.value = "";
    } }),
  );

  view.append(tokenCard, limits, pass);
}

function renderDocs(view) {
  const base = state.data.baseUrl;
  const key = state.data.keys[0] ? `${state.data.keys[0].prefix}…${state.data.keys[0].last4}` : "abltx_sk_...";
  const model = state.data.models[0]?.id || "deepseek-v4-flash";
  const card = el("div", { className: "card" });
  card.append(
    el("h3", { textContent: "Важно" }),
    el("p", { className: "card-sub", textContent: "Дашборд требует cookie (вход в браузере). curl/wget по адресу / получает текстовую шпаргалку, а /v1/* работает с Bearer-ключом без cookie и CSRF." }),
    el("div", { className: "field" }, el("label", { textContent: "Base URL" }), copyLine(`${base}/v1`)),
    el("div", { className: "field" }, el("label", { textContent: "Модели" }), copyLine(`${base}/v1/models`)),
  );
  view.append(card);

  const blocks = [
    ["curl", `curl -s ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"привет"}]}'`],
    ["curl (стрим)", `curl -N -s ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"model":"${model}","stream":true,"messages":[{"role":"user","content":"считай до 5"}]}'`],
    ["Python (официальный SDK)", `from openai import OpenAI
client = OpenAI(base_url="${base}/v1", api_key="${key}")
r = client.chat.completions.create(model="${model}", messages=[{"role":"user","content":"привет"}])
print(r.choices[0].message.content)`],
    ["Node (SDK)", `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${base}/v1", apiKey: process.env.ABLTX_KEY });
const r = await client.chat.completions.create({ model: "${model}", messages: [{ role: "user", content: "привет" }] });
console.log(r.choices[0].message.content);`],
    ["Проверка баланса", `curl -s ${base}/v1/me -H "Authorization: Bearer ${key}"`],
  ];
  for (const [title, code] of blocks) {
    const card = el("div", { className: "card" });
    card.append(el("div", { className: "row between" }, el("h3", { textContent: title }), el("button", { className: "tiny ghost", textContent: "copy", onclick: () => copy(code) })), el("pre", { className: "code", textContent: code }));
    view.append(card);
  }
  const other = el("div", { className: "card" });
  other.append(
    el("h3", { textContent: "Совместимость" }),
    el("p", { className: "card-sub", textContent: "Поддерживаются /v1/models, /v1/chat/completions (stream и non-stream, вызовы инструментов, reasoning_content), /v1/completions (legacy prompt) и /v1/me. Можно прислать и сам JWT free-pi вместо ключа — тогда действуют общие лимиты." }),
    el("p", { className: "hint", textContent: "Расход дневного лимита зависит от модели: множители вида ~41x видны на вкладке «Модели»." }),
  );
  view.append(other);
}

/* ---------------------------------- boot -------------------------------- */

function renderMeter() {
  const up = state.data?.upstream;
  const box = $("#meter");
  box.replaceChildren();
  const pill = $("#token-pill");
  pill.className = "pill " + (up?.present && !up.expired ? "ok" : "bad");
  pill.textContent = state.data?.accounts?.length
    ? `☺ ${state.data.activeLabel} · ${up?.expiresInDays ?? "?"}д`
    : up?.present ? `файл free-pi-cli · ${up.expiresInDays}д` : "нет аккаунта";
  if (up?.remaining_usd_today == null || up?.cap_usd_today == null) return;
  const left = Number(up.remaining_usd_today);
  const cap = Number(up.cap_usd_today) || 1;
  const pct = Math.max(0, Math.min(100, (left / cap) * 100));
  box.append(
    el("div", { className: "track" }, el("div", { className: "fill", style: `width:${pct}%` })),
    el("div", { className: "label", textContent: `$${left.toFixed(3)} из $${cap.toFixed(3)} осталось` }),
  );
}

async function refresh() {
  state.data = await api("state");
  renderMeter();
  setView(state.view);
}

async function boot() {
  try {
    state.data = await api("state");
  } catch {
    return;
  }
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderMeter();
  setView(state.view);
  setInterval(() => api("state").then((d) => { state.data = d; renderMeter(); }).catch(() => {}), 20_000);
}

$("#login-form").addEventListener("submit", login);
$("#logout").addEventListener("click", logout);
for (const btn of document.querySelectorAll("#nav button")) btn.addEventListener("click", () => setView(btn.dataset.view));
addEventListener("hashchange", () => setView(location.hash.slice(1) || "overview"));

boot();
