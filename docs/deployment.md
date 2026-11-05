# Этап 1: проверка размещения

Статус на 2026-11-06: **Worker, Neon и Telegram webhook подключены. Реальные команды обрабатываются с HTTP200, очередь Telegram пуста. Содержание ответов DB/alarm ожидает подтверждения пользователя; CPU/квоты и удаление probes PENDING**.
На момент первоначальной локальной проверки аккаунтов не было. Затем пользователь создал Cloudflare и подтвердил вход Wrangler через OAuth. Данные авторизации находятся только в игнорируемом локальном каталоге Wrangler.
Dry-run и workerd не доказывают доступность удалённой базы, реальный Telegram и работу удалённого alarm.

## Фактическая публикация Cloudflare

- Адрес: https://borodach-bot.dubovbe.workers.dev
- Исходный коммит: `b969d2f9e0aeb05ebe86575ac96c63c65eac4b06`.
- Version ID исходной публикации до настройки Secrets: `1a056bdd-4bc1-48dd-b943-63705d3540b5`.
- `wrangler deploy`: успешно; SQLite-backed ProbeScheduler binding создан, запуск alarm ещё не проверен.
- Startup Time: 13 ms. Это время старта, **не** CPU time отдельного HTTP-запроса; не сравнивать его с лимитом 10 ms CPU.
- Скриншот кабинета пользователя показывает 100 000 запросов/сутки, что соответствует Workers Free. API subscriptions не дал подтверждения тарифных деталей; отсутствие карты/trial отдельно не установлено. Платные тарифы не включались агентом.
- Реальные запросы с обычной проверкой TLS: GET `/health` → 200 и `{"ok":true}`; POST `/webhook` без секрета и с неверным секретом, включая невалидный JSON → 403; GET `/probe` → 404. Правильный секрет ещё не настроен, его прохождение не проверено.
- Первый Node HTTPS-запрос после deploy получил TLS handshake failure. Последующий системный curl с проверкой TLS получил 200, повторный Node прошёл все четыре проверки, curl подтвердил 403. Ошибка больше не воспроизвелась, точная причина не установлена; код и проверка сертификатов не менялись.
- Теперь DATABASE_URL и WEBHOOK_SECRET переданы в Cloudflare Secrets без вывода значений. После обновления GET /health → 200; POST /webhook с верным секретом и невалидным JSON → 400 (доступ пройден, тело отвергнуто); с неверным секретом → 403. Это проверяет реальный секрет, но не регистрацию Telegram webhook.
- Настроены BOT_TOKEN, BOT_INFO и FIRST_ADMIN_ID для тестового бота. Telegram webhook указывает на опубликованный `/webhook` с secret_token; max_connections=1, message/callback_query разрешены, ожидающие обновления не отбрасывались.

## Реальное подключение Telegram

- Пользователь создал [@borodach_dubovbe_test_bot](https://t.me/borodach_dubovbe_test_bot), ввёл токен только в локальном `.dev.vars`. getMe подтвердил точное имя бота; токен не печатался.
- ID первого админа определён по единственному входящему сообщению в приватном чате с одноразовым случайным кодом, подтверждённому пользователем. Первому произвольному отправителю права не выдавались. Числовой ID в публичном отчёте не приводится.
- BOT_TOKEN/BOT_INFO/FIRST_ADMIN_ID переданы в Cloudflare Secrets через stdin. Реальный setWebhook выполнен без удаления pending updates.
- Выявлена и исправлена ошибка операционной сериализации BOT_INFO: внешние двойные кавычки с backslash-экранированием внутренних кавычек неправильно читались Node parseEnv, поэтому JSON.parse инициализации падал и Worker возвращал503. Локальный RED: INVALID_JSON_AFTER_ENV_PARSE; исправление — внешние одинарные кавычки вокруг JSON, apostrophe внутри JSON при необходимости кодируется Unicode escape. Локальный parseEnv → JSON.parse → Bot initialization прошёл; обновлён только секрет BOT_INFO, код приложения не менялся.
- Пример формата без реальных данных: `BOT_INFO='{"id":123,"is_bot":true,"first_name":"Test","username":"example_test_bot"}'`. Перед будущей загрузкой обязательно проверять round-trip parseEnv/JSON.parse, не применять слепо JSON.stringify к внешнему env-значению.
- После исправления авторизованное обновление без действий вернуло200. Проверочные `/start`, `/probe_db`, `/probe` и отложенный `/probe_status`, переданные защищённому webhook от подтверждённого админа, вернули200; ответы отправлялись только ему. Эти синтетические обновления проверяют Worker/провайдеров, а не имитируют доказательство входящей Telegram-доставки.
- getWebhookInfo подтвердил реальный URL и pending_update_count=0: ранее отправленные пользователем /start и setup доставлены. last_error_date сохранил историческую503 до исправления; на последней проверке ошибка была старше245секунд, очередь пуста.
- Содержимое ответов о результате DB/alarm нужно подтвердить в чате: обработчик возвращает200 и при безопасном сообщении о неуспехе проверки, поэтому сам HTTP200 не считается доказательством успешной транзакции или alarm. Клиентская задержка команды также не является CPU time Worker.

## Реальное подключение Neon

- Подтверждён существующий проект `borodach-bot`, регион `aws-eu-central-1` (Frankfurt), PostgreSQL18. CLI projects get показывает subscription_type=free_v3.
- Подключённый Neon MCP возвращал Unknown tool для describe_project/list_branches. Использована официальная CLI8.23.2, пользователь самостоятельно выполнил OAuth-вход. Повторный init/создание нового проекта не выполнялись.
- `neon link --project-id <existing-project> --branch production --no-config -y` связал проект; production — имя default-ветки нашей новой тестовой базы, не боевой YCLIENTS.
- CLI по умолчанию создала `.env.local`, а не `.env`. Файл перемещён в `.env` без перезаписи существующих файлов. Там DATABASE_URL, DATABASE_URL_UNPOOLED и NEON_BRANCH; значения нигде не напечатаны. Контекст `.neon` и файлы окружения исключены из Git.
- В `.dev.vars` сохранены DATABASE_URL и криптографически случайный WEBHOOK_SECRET. Они переданы Wrangler secret bulk через stdin, без паролей в аргументах команды/отчёте.
- Реальный `npm run probe:neon`: exit0, `{"ok":true,"http":true,"transaction":true}`. Выполнены HTTP SELECT1, затем Client BEGIN/SELECT1/ROLLBACK с закрытием соединения; таблицы не создавались и данные не записывались.
- Это подтверждает драйвер и соединение из Node. Реальный WebSocket Client именно из Workers, Telegram reply и удалённый alarm остаются непроверенными.

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
| Cloudflare: создание аккаунта, OAuth и deploy | PASS |
| Neon: аккаунт и доступность | PASS: CLI OAuth, существующий проект Frankfurt/PostgreSQL18 |
| Только Free, без карты/trial, фактические квоты | Neon Free подтверждён subscription_type=free_v3; Cloudflare квота100000/сутки соответствует Free. Отсутствие карты/trial и фактическое потребление отдельно не подтверждены |
| Реальный workers.dev HTTPS | PASS: GET /health 200, {"ok":true} |
| Отказ webhook без/с неверным секретом | PASS: 403, в том числе до разбора невалидного JSON |
| Отсутствие публичного probe HTTP | PASS: /probe 404 |
| Правильный секрет в опубликованном Worker | PASS: верный секрет + невалидный JSON →400, неверный →403 |
| Регистрация реального webhook Telegram | **PENDING** |
| Telegram getMe, админский ID и конфигурация бота | PASS: точное имя бота и уникальное setup-сообщение проверены |
| Регистрация webhook и доставка входящих | PASS: реальный URL, очередь pending=0 |
| Реальный Telegram /start → Neon → ответ | Ответ отправлен, HTTP200; текст успешной проверки **ожидает подтверждения пользователя** |
| Реальные HTTP и интерактивная Neon-транзакция из Node | PASS: probe:neon exit0, http=true, transaction=true |
| Реальная Neon-транзакция из Worker /probe_db | Команда обработана HTTP200 и ответ отправлен; текст результата **ожидает подтверждения пользователя** |
| Alarm на Cloudflare Free | /probe и отложенный /probe_status обработаны HTTP200; текст отметки срабатывания **ожидает подтверждения пользователя** |
| CPU и фактическое потребление квот | **PENDING** |
| Удаление временных команд из опубликованного Worker | **PENDING** |
| Независимое ревью локального кода | PASS; исправлено подтверждённое зависание CLI, scoped re-review Approved |
| Git checkpoint | Ветка `chore/stage-1-deployment-probe`; точный коммит и удалённый SHA проверяются при публикации |

Основа реализации: [Neon HTTP/WebSocket driver](https://neon.com/docs/serverless/serverless-driver),
[Cloudflare test APIs для DO](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).
Продуктовые лимиты и тарифы должны проверяться перед реальной публикацией.
