# Этап 1: проверка размещения

Статус на 2026-11-06: **локальная часть проверена; размещение PENDING**.
Аккаунтов и реальных секретов на момент локальной проверки нет. Dry-run и workerd
не доказывают доступность регистрации, бесплатного тарифа, HTTPS и удалённой базы.

## Локальные команды

В PowerShell из корня репозитория на этой машине:

```powershell
$env:PATH = 'C:\codex_projects\tools\node-runtime\node-v24.22.2-win-x64;' + $env:PATH
$env:WRANGLER_LOG_PATH = Join-Path $PWD '.wrangler/logs'
$env:XDG_CONFIG_HOME = Join-Path $PWD '.wrangler/config'
$env:WRANGLER_SEND_METRICS = 'false'
node --version
npm.cmd --version
npm.cmd ci
npm.cmd run test:worker -- tests/worker/health.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Это настройки только текущего процесса PowerShell; системный PATH и runtime Codex
не меняются. `build` выполняет `wrangler deploy --dry-run`, ничего не публикует.
Логи, локальная конфигурация Wrangler и сборка находятся в игнорируемых каталогах.
`npm ci` требует доступ к npm registry; при запрете sandbox нужна штатная эскалация.

Проверено: Node v24.22.2, npm 11.19.1; Vitest 4.1.12,
Cloudflare Vitest plugin 1.6.0, Wrangler 4.158.0, TypeScript 6.0.3,
grammY 1.46.0, Neon driver 1.2.0. Транзитивные версии фиксирует package-lock.json.
Актуальная [интеграция Cloudflare с Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/)
использует `@cloudflare/vitest-plugin`; старый pool из исходного плана заменён им.

## Что реализовано

- `GET /health` → `200 {"ok":true}` без настройки бота и без Neon.
- Только `POST /webhook` с непустым совпавшим `X-Telegram-Bot-Api-Secret-Token`
  допускается к разбору обновления, созданию бота и побочным действиям.
- grammY `/start`: ровно один HTTP `SELECT 1 AS ok`, затем безопасный ответ.
  У Neon timeout 3 секунды с отменой, повторов нет. У Telegram timeout 5 секунд,
  повторов приложения нет. Ошибка Neon даёт общий ответ без деталей;
  ошибка обработки/Telegram возвращает общий HTTP 503.
- `/probe`, `/probe_status` и `/probe_db`: временные команды только первого админа в личном
  чате. DO хранит только техническую отметку времени; alarm через 5 секунд,
  без следующего alarm и без запросов в базу. Публичного HTTP probe-маршрута нет.
- `/probe_db` проверяет именно Worker → Neon WebSocket Client:
  `connect → BEGIN → SELECT 1 AS ok → ROLLBACK → end`. Connection/query/statement
  timeout 2 секунды, общий предел операции 6 секунд, закрытие ограничено ещё
  1 секундой. При сбое соединение закрывается с откатом незавершённой транзакции;
  в ответе нет URL/ошибок провайдера. Реальный транспорт ещё не проверен.
- `npm run probe:neon`: независимая от Worker/Telegram проверка HTTP SELECT,
  затем WebSocket `BEGIN → SELECT 1 AS ok → ROLLBACK`, закрытие Client.
  Используется тот же bounded Client probe; общий предел процесса 12 секунд.
  CLI синхронно записывает единственный JSON-результат и явно завершает процесс:
  оставленные драйвером handles не удерживают его после результата. Аварийный
  таймер остаётся активным до выхода процесса.
  Вывод — только безопасный JSON и код завершения. Проверка ничего не записывает.

У этапа 1 ещё нет защиты от повторов webhook: повтор `/start` повторит техническую
проверку и ответ. Это не готовый бот записи; схема бизнеса отсутствует.

## Подготовка реальной проверки

1. Владелец создаёт Cloudflare и Neon, тестового бота в BotFather. Проверяет в
   обоих кабинетах Free без карты/платного trial. При недоступности регистрации,
   DO Free или квот остановиться и обсудить подход; платный план не включать.
2. Скопировать `.dev.vars.example` в `.dev.vars`, `.env.example` в `.env`.
   Заполнить локально, не в чате и не в Git. `BOT_INFO` — JSON объекта `result`
   реального Telegram `getMe` для этого токена. `FIRST_ADMIN_ID` — Telegram ID
   владельца; `WEBHOOK_SECRET` — случайная строка, допустимая Telegram.
   `.env` нужен только независимому Node probe.
3. Выполнить `npm.cmd run probe:neon`. Успех должен дать
   `{"ok":true,"http":true,"transaction":true}`. Зафиксировать безопасный
   результат; не публиковать URL, токен, пароль, payload и сырые ошибки.
4. После создания аккаунтов войти в Wrangler (владелец завершает вход и
   необходимые запросы доступа), передать переменные как
   secrets (`BOT_TOKEN`, `BOT_INFO`, `WEBHOOK_SECRET`, `DATABASE_URL`,
   `FIRST_ADMIN_ID`) и опубликовать Worker. `SCHEDULER` задаёт wrangler.jsonc,
   миграция `new_sqlite_classes` создаёт SQLite-backed DO.
5. Настроить Telegram `setWebhook` на HTTPS `https://<worker>.<subdomain>.workers.dev/webhook`
   с `secret_token`, совпадающим с локальным значением. Токен не вставлять в
   команды, сохраняемые в истории или документации; выполнять из локального
   окружения. Проверить результат `getWebhookInfo` без раскрытия секретов.
6. Проверить `/health`, запрос webhook с неверным секретом, реальный `/start`,
   `/probe_db`, `/probe`, затем `/probe_status`. Только успешный `/probe_db`
   доказывает интерактивный Client из опубликованного Worker; SQL из консоли и
   независимый Node probe этого не доказывают. В кабинете проверить CPU, ошибки и расход
   квот; отдельно убедиться, что health/alarm не пробуждают Neon.
7. После успешного remote smoke удалить временные команды `/probe` и
   `/probe_status`, `/probe_db` из опубликованного Worker, повторить локальные проверки и
   публикацию. Не удалять вслепую историю DO migration: её изменение требует
   отдельной проверки Wrangler. Последующие этапы согласуются отдельно.

## Результаты

| Проверка | Фактический результат |
| --- | --- |
| TDD bootstrap RED без реализации | FAIL: отсутствует src/worker.ts |
| TDD behavioral RED с пустыми интерфейсами | 8 FAIL из 9: статусы 501, нет SELECT/abort/alarm |
| Worker-runtime тесты | PASS: 14 из 14, workerd/Miniflare, внешние HTTP/Client заменены |
| Интерактивный Client lifecycle | PASS локально: порядок, закрытие при ошибке/зависании, запрет неадмину; настоящий транспорт PENDING |
| Независимый CLI, неверная конфигурация | PASS: безопасный JSON, exit 1, пустой stderr |
| CLI при зависшем закрытии/оставшемся handle | PASS: самостоятельный exit, один JSON; всего 3 CLI-теста |
| npm test / typecheck | PASS |
| Wrangler dry-run | PASS; это не CPU замер |
| Аккаунты Cloudflare/Neon, региональная доступность | **PENDING** |
| Только Free, без карты/trial, фактические квоты | **PENDING** |
| Реальный workers.dev HTTPS и секрет webhook | **PENDING** |
| Реальный Telegram /start → Neon → ответ | **PENDING** |
| Реальная интерактивная Neon-транзакция Node + Worker /probe_db | **PENDING** |
| Alarm на Cloudflare Free | **PENDING** |
| CPU и фактическое потребление квот | **PENDING** |
| Удаление временных команд из опубликованного Worker | **PENDING** |
| Независимое ревью локального кода | PASS; исправлено подтверждённое зависание CLI, scoped re-review Approved |
| Git checkpoint | Ветка `chore/stage-1-deployment-probe`; точный коммит и удалённый SHA проверяются при публикации |

Основа реализации: [Neon HTTP/WebSocket driver](https://neon.com/docs/serverless/serverless-driver),
[Cloudflare test APIs для DO](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).
Продуктовые лимиты и тарифы должны проверяться перед реальной публикацией.
