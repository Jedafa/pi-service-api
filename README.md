# pi-service-api

free-pi (`free-pi-cli`) → OpenAI-совместимый API + веб-панель. Кодовое имя проекта — **abltx**.

free-pi (`free-pi-cli`) превращён в **OpenAI-совместимый API** с **веб-панелью** — без терминала.

* вход в панель — по паролю + HttpOnly cookie, curl по `/` получает текстовую шпаргалку, а не HTML;
* API — обычные Bearer-ключи (`abltx_sk_...`), работает из curl, Python, Node, любого OpenAI-клиента;
* модели free-pi выведены в `/v1/models` (29 моделей, включая `defense`/`premium`), ключи, лимиты, логи и плейграунд — в панели;
* ноль зависимостей: только Node ≥ 22 и стандартная библиотека.

```
┌─ браузер ────────────────┐        ┌─ curl / SDK / бот ──────┐
│ /  панель (cookie+CSRF)  │        │ /v1/*  (Bearer abltx_sk)│
└───────────┬──────────────┘        └────────────┬───────────┘
            └────────��───► abltx ◄───────────────┘
                     https://api.freepi.ai
```

## Аккаунты

Вкладка **Аккаунты** — тот же вход, что в CLI, только в браузере:

1. «Войти через браузер ↗» — abltx открывает `freepi.ai/connect`, вы входите через GitHub и подтверждаете код (он должен совпасть с показанным); дашборд сам дёргает `/auth/connect/poll` и сохраняет токен.
2. «GitHub device-code» — если браузера нет: показывается код, его надо ввести на `github.com/login/device`.
3. «Импорт из файла free-pi-cli» / «Вставить JWT вручную» — на случай работы с другой машины.

Аккаунтов можно держать сколько угодно: у каждого своя подпись, баланс, срок токена и счётчик запросов. Активный выбирается радиокнопкой — новый аккаунт становится активным сразу.

Как выбирается аккаунт на уровне API:

1. заголовок `x-abltx-account: <id или название>`,
2. query-параметр `?account=<id или название>`,
3. привязка ключа (колонка «аккаунт» в API-ключах),
4. активный аккаунт из панели,
5. `free-pi-cli`-файл, если аккаунтов ещё нет.

```bash
curl -s http://127.0.0.1:8787/v1/accounts -H "Authorization: Bearer $ABLTX_KEY"
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $ABLTX_KEY" -H "x-abltx-account: аккаунт 2" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"привет"}]}'
```

Названия с кириллицей в заголовке тоже работают (abltx перечитывает latin1-байты как UTF-8); надёжнее — `?account=` или id аккаунта.

Аккаунт из файла `free-pi-cli` показывается отдельной строкой «токен из файла free-pi-cli» с кнопкой «добавить в abltx» — после этого он живёт в `data/accounts.json` и файл больше не нужен. Если дневной лимит одного аккаунта кончился (free-pi отвечает `hourly_ceiling`, slow lane), переключитесь на другой — abltx ничего не кэширует по лимитам.

Запросы баланса и моделей кэшируются на 15/60 секунд, чтобы панель открывалась мгновенно.

## Быстрый старт

```bash
cd abltx
node server.mjs            # или ./start.sh   (или двойной клик по abltx.desktop)
```

При первом запуске abltx сгенерирует пароль панели:

* печатает его в консоль,
* сохраняет в `data/first-run-password.txt`,
* меняется в панели → «Настройки», либо заранее: `ABLTX_PASSWORD=... node server.mjs`.

Дальше: `http://127.0.0.1:8787/` → вход → **Аккаунты → «Войти через браузер»** → потом **API-ключи** → создать ключ для клиента.

Аккаунты free-pi лежат в `data/accounts.json`. При первом запуске abltx импортирует токен, который оставил CLI (`~/.free-pi/agent/credentials.json`), — файлы вручную доставать больше не нужно; дальше аккаунты добавляются прямо из панели, и активный переключается одним кликом.

## Использование API

```bash
export ABLTX_KEY=abltx_sk_...
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $ABLTX_KEY" -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"привет"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=ABLTX_KEY)
print(client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "привет"}],
).choices[0].message.content)
```

Эндпоинты:

| метод | путь | авторизация | описание |
|---|---|---|---|
| GET | `/v1/models` | не нужна | список моделей (`usage_multiplier`, `section`, `premium`) |
| GET | `/v1/models/:id` | не нужна | одна модель |
| POST | `/v1/chat/completions` | `Bearer abltx_sk_...` | чат, `stream: true` поддерживается |
| POST | `/v1/completions` | ключ | legacy `prompt` → маппится в messages |
| GET | `/v1/me` | ключ | расход ключа + остаток дневного лимита free-pi |
| GET | `/v1/accounts` | не нужна | аккаунты и активный (`x-abltx-account` выбирает аккаунт для запроса) |
| GET | `/healthz` | не нужна | живость и статус токена |

Дополнительно: `model` можно писать как `deepseek-v4-flash`, как upstream-id (`deepseek/deepseek-v4-flash-0731`) или с префиксом `free-pi/` — всё нормализуется. Вместо ключа можно прислать сам JWT free-pi (если включено `allowRawJwt`) — тогда действуют общие лимиты.

## Панель

* **Обзор** — остаток дневного лимита, активный аккаунт, Base URL, ключ, последние запросы.
* **Аккаунты** — вход через браузер/device-code, несколько аккаунтов, переключение.
* **Модели** — каталог, множители расхода (`~41x usage` и т.п.), `defense`/`premium` метки.
* **API-ключи** — создание/отключение/удаление, личный rpm, привязка ключа к аккаунту, счётчики.
* **Плейграунд** — стриминговый чат прямо в панели, ключ не нужен.
* **Логи** — время, ключ, модель, статус, токены, длительность.
* **Настройки** — upstream-токен, общий rpm, лимит одновременных запросов, смена пароля.
* **Документация** — готовые сниппеты curl/Python/Node с вашим URL и ключом.

## Безопасность

* панель: пароль (scrypt), сессионная HttpOnly-cookie (`SameSite=Lax`), CSRF-заголовок на все изменяющие запросы, троттлинг логина (12 попыток/мин/IP);
* `GET /` от curl/wget отдаёт plain-text (панель доступна только браузеру с cookie), `/panel/api/*` без cookie отвечает `401` JSON, `/v1/*` — работает;
* ключи хранятся как SHA-256, полный ключ показывается один раз;
* наружу: `ABLTX_HOST=0.0.0.0`, за HTTPS — `ABLTX_SECURE_COOKIES=1` и `ABLTX_PUBLIC_URL=https://...`;
* лимиты: общий rpm, rpm на ключ, ограничение одновременных запросов.

## Конфигурация (env)

| переменная | по умолчанию | смысл |
|---|---|---|
| `ABLTX_PORT` | `8787` | порт |
| `ABLTX_HOST` | `127.0.0.1` | интерфейс (`0.0.0.0` — наружу) |
| `ABLTX_PASSWORD` | генерируется | пароль панели при первом запуске |
| `ABLTX_DATA` | `./data` | каталог состояния |
| `ABLTX_PUBLIC_URL` | из запроса | внешний адрес в сниппетах панели |
| `ABLTX_SECURE_COOKIES` | `0` | cookie только по HTTPS |
| `FREEPI_CREDENTIALS` | `~/.free-pi/agent/credentials.json` | где искать upstream-токен |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | upstream |
| `ABLTX_QUIET` | `0` | `1` — без строк запросов в консоли |

## Структура

```
server.mjs          http-сервер, роутинг, ошибки, баннер
src/api.mjs         /v1/* OpenAI-совместимый API (стрим, учёт токенов, логи)
src/panel.mjs       страницы и /panel/api/* (cookie + CSRF)
src/upstream.mjs    free-pi: аккаунты, вход, каталог моделей, chat, /me (с кэшем)
src/logins.mjs      ожидающие веб-входы (connect + device-code)
src/auth.mjs        scrypt-пароль, сессии, API-ключи
src/limit.mjs       rpm и одновременность
src/store.mjs       keys.json / sessions.json, кольцевой буфер логов
src/config.mjs      env + data/config.json
public/             панель (HTML/CSS/ESM, без сборки)
data/               состояние, first-run-password.txt, requests.jsonl
```

## Устранить неполадки

* **«Нет upstream-токена»** — один раз `npx free-pi-cli@latest` (вход через GitHub) либо токен в Настройках.
* **401 от free-pi** — токен истёк (живёт ~90 дней): перезапустите free-pi, нажмите «Reload из файла».
* **429** — упёрлись в rpm/одновременность или в дневной лимит free-pi (смотрите «Обзор»). Ответ free-pi пробрасывается как есть, плюс `x-abltx-hint` и `retry-after`.
* **`concurrent_session` / «уже 4 сессии»** — free-pi держит лимит сессий на аккаунт. abltx использует один стабильный `x-session-id` (лежит в `data/config.json`) и при 409 сам зовёт `/session/reset` и повторяет запрос; вручную — кнопка «Освободить чужие сессии free-pi» в Настройках.
* **Забыли пароль** — удалите `data/config.json` (или поле `passwordHash`) и перезапустите.

## Полезные мелочи

* Полный текст последнего созданного ключа дублируется в `data/last-key.txt` (панель показывает только `prefix…last4`).
* `data/requests.jsonl` — журнал запросов, если нужен внешний разбор.
* В `<title>` панели пишется отладочная строка `sw=… vw=… bad=…` (ширина страницы и элементы, вылезшие за вьюпорт) — удобно ловить поломки вёрстки.
* `GET /login?password=…&next=/#logs` — «магическая» ссылка для входа без формы.
* Скриншоты панели — в `docs/shots/`.
