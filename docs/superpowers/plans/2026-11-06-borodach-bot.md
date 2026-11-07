# Бородач Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полный тестовый Telegram-бот записи для одного барбершопа с клиентом, барбером и админом, без ручного согласования времени в переписке.

**Architecture:** Один TypeScript Worker принимает webhook и обрабатывает команды; Neon PostgreSQL хранит пользователей, графики, заявки, визиты, историю и задания уведомлений. Изменения фиксируются атомарно, затем уведомления доставляются из outbox. Предлагается один SQLite-backed Durable Object только как будильник следующего задания: база записей остаётся в Neon, постоянного опроса PostgreSQL нет.

**Tech Stack:** TypeScript strict, grammY, @neondatabase/serverless (Client для интерактивных транзакций), SQL-миграции без ORM, Vitest + @cloudflare/vitest-plugin, Wrangler; Node.js LTS с npm, PostgreSQL тестовой среды. Точные совместимые версии проверяются и фиксируются package-lock.json на этапе 1, не копируются из старых примеров.

**Spec:** [2026-11-05-borodach-bot-design.md](../specs/2026-11-05-borodach-bot-design.md). План согласован пользователем 2026-11-06. Техническая проверка этапа 1 завершена с ограничениями CPU/учёта расхода в docs/deployment.md. Этап 2 реализован и проверен на Neon и CI Linux/PostgreSQL; пользователь согласовал: отдельная тестовая ветка Neon, разработчик Sol Medium, проверяющий Sol High. Уточнения исполнения — docs/stage-2-foundation.md. Этап 3 реализован и проверен на Neon и CI Linux/PostgreSQL; после проверки восстановления этап4 реализован, проверен на Neon/CI и в отдельном preview (docs/stage-4-notifications.md); этап 5 реализован и проверен (docs/stage-5-identity-access.md), этап 6 реализован и проверен на Neon/CI и двумя аккаунтами в тестовом боте (docs/stage-6-client-booking.md), реализован этап 7, проверки кода и ревью пройдены, готовятся публикация и ручная приёмка (docs/stage-7-client-reminders.md), этапы 8–11 не начаты. Проверки этапа3 — docs/stage-3-booking-rules.md. Роли: [agent-team.md](../../agent-team.md).

## Global Constraints

- Один барбершоп, один адрес; TypeScript + Workers + Neon PostgreSQL; собственные тестовые данные; бюджет 0 рублей в пределах бесплатных квот.
- Боевой YCLIENTS не подключать. Mini App, оплата, штрафы, скидки, несколько филиалов — вне первой версии.
- Europe/Moscow для отображения и графика; UTC для моментов времени. Шаг начала — 30 минут, длительность услуг не округляется.
- Клиентская запись минимум за два часа, горизонт по умолчанию 30 дней с настройкой админа. Предлагаемая точная граница горизонта: до конца локального дня today+30 включительно; нижняя граница now+2h включительно.
- Одна ожидающая заявка клиента (включая его запрос переноса), подтверждённых будущих визитов может быть несколько.
- Срок подтверждения — час с учётом рабочего графика по спецификации. Перенос требует согласия второй стороны. Старый визит остаётся до принятия.
- Телефон через request_contact, совпадение contact.user_id и отправителя. Имя + телефон для ручного клиента.
- В Git только код, схема, документация и вымышленные данные. Секреты — в окружении. Рабочая база и резервные копии не публикуются.
- Каждый этап: проверки → независимое ревью по выбранному процессу → коммит → push → сверка удалённого SHA → обсуждение следующего этапа. Код не начинается до согласования плана.
- Работник/проверяющий: GPT-6.1 Sol + Medium, явные параметры, fork_turns=none; отдельного автономного оркестратора не запускать.

## Review Focus

1. Два клиента одновременно выбирают пересекающиеся, но не одинаковые интервалы: проходит только одна заявка (этап 3).
2. Сбой между фиксацией записи и HTTP-ответом/настройкой будильника: повтор webhook восстанавливает доставку без новой записи (этапы 2, 4, 7).
3. Частично пересекающийся перенос того же визита не мешает самому себе, но блокирует оба интервала для других (этап 8).
4. Старые кнопки, новая персональная ссылка, чужой контакт или номер, уже связанный с аккаунтом: нет обхода доступа/ограничений (этапы 5, 6, 9).
5. Изменение графика одновременно с заявкой или переносом, либо отправка старого напоминания после переноса: нет некорректного визита/нового задания по старой версии (этапы 3, 7, 8, 9).

## Решения исполнителя для согласования

1. **Планировщик:** Durable Object с одним alarm; хранит только nextWake/generation и технические данные запуска, не клиентов и брони. Free допускает SQLite-backed DO. Причина — не будить Neon каждую минуту. Cron раз в минуту проверяет только состояние DO и восстанавливает пропавший alarm; не опрашивает Neon при отсутствии срока. Alarm дренирует просроченные задания PostgreSQL ограниченными пачками. При ошибке заранее назначает повтор, не полагается бесконечно на встроенные шесть повторов.
2. **Конкурентность:** в каждом изменяющем бизнес-транзакцию запросе `SELECT ... FROM shop WHERE id=1 FOR UPDATE` до чтения изменяемого состояния. Одна небольшая организация допускает последовательные изменения без сложных межмастерных блокировок. Внутри транзакции — права, сроки, пересечения, изменение, аудит и outbox. Никаких сетевых вызовов Telegram внутри транзакции. Прямые изменения данных обходным путём запрещены архитектурой репозитория; миграционная роль отдельна от runtime. Проверка пересечений — в PostgreSQL под блокировкой, а не только в календаре. При росте нагрузки это решение пересматривается отдельно.
3. **Интервалы:** хранить текущую бронь визита и новый интервал открытого переноса отдельными записями. Конфликт проверять по обоим, исключая записи того же visitId только для проверки его переноса; интервалы [start,end). Одна открытая заявка переноса на визит. Устаревшие временные брони игнорируются по expiresAt<=dbNow, а изменение сначала завершает затронутые истёкшие заявки в той же транзакции.
4. **Состояния:** визит pending / confirmed / declined / expired / cancelled / completed / no_show; перенос pending / accepted / declined / expired / cancelled. Завершённые записи не подтверждаются и не переносятся заново. У клиента дополнительно доступно «Отозвать заявку». Итог визита может исправить админ с аудитом.
5. **Ссылки и формы:** payload мастера `b_<randomToken>`, приглашение `i_<randomToken>` (срок 24 часа); хранить хеш токена, поддержать отзыв. Callback — короткий непрозрачный ID, срок 30 минут, привязка к пользователю и версии формы; размер callback_data <=64 байт. Черновик и форма хранятся в PostgreSQL, а не в памяти Worker. При новом /start предыдущий черновик недействителен; существующие заявки не удаляются. Корректный, но устаревший callback предлагает обновить экран.
6. **Ввод:** услуги/мастера выбираются кнопками, календарь кнопками; для произвольных названий, цены, длительности, причины и ручного контакта админ/мастер вводит текст в ответ на подсказку. Ввод проверяется, перед записью показывается итог. Телефон ручного клиента нормализуется libphonenumber-js/min с RU по умолчанию и сохранением международных номеров. Telegram ID хранить bigint, на границах приложения — строка.
7. **Тарифы и ранги:** каталог активных услуг отдельно от ранговых тарифов и индивидуальных переопределений. Нулевую цену допускаем, длительность только положительная. Снимки состава/стоимости/длительности у визита; перенос состава не меняет. Новое имя услуги отображается новым заявкам, история сохраняет снимок.
8. **Напоминания:** точность до 5 минут при здоровых сервисах, не SLA при сбоях. На границе ровно часа достаточно подтверждения; для прошедшего выбранного второго интервала использовать 1 час, если этот момент ещё впереди. 24-часовое пропущенное напоминание не пересылать. Версия визита и версия задания предотвращают повторный план после переноса; единичное уже отправляемое сообщение при одновременной отмене исключить абсолютно нельзя.
9. **Доступ:** разрешения накопительные: админ может быть клиентом/мастером. Пользователь с несколькими ролями переключает меню, но каждое действие проверяет сервер. Первого админа назначает FIRST_ADMIN_ID; управление профилями барберов/клиентов выполняется в меню. Дополнительное меню назначения новых админов не вводится: это отдельное будущее решение, а не условная ветка реализации текущего плана.
10. **Ручной клиент:** до первого связывания будущие визиты доступны только сотрудникам. После подтверждённого контакта клиент видит своё будущее расписание. Старые визиты не передаются автоматически по одному совпавшему номеру. Телефон, привязанный к другому Telegram ID, требует разбирательства админа без автоматического переноса владения.

## Структура и общие интерфейсы

Пути ниже относительно корня репозитория. Файлы вводятся только на своём этапе, пустые заготовки всех модулей заранее не создавать.

```text
src/worker.ts                 fetch/scheduled, проверка HTTP, сборка зависимостей
src/env.ts                    Env и проверка обязательных настроек
src/domain/types.ts           ID, момент/интервал, статусы, ошибки и команды
src/db/client.ts               Neon HTTP-read и Client transaction, закрытие соединений
src/db/repository.ts           бизнес-операции под shop lock, без Telegram API
src/db/schema/                 нумерованные SQL-миграции
src/bot/create-bot.ts          grammY и маршрутизация
src/bot/screens.ts             общие меню, клавиатуры, ошибки ввода
src/bot/client.ts              клиентский путь и настройки
src/bot/staff.ts               рабочее место барбера и ручная запись
src/bot/admin.ts               каталог, персонал, графики, настройки
src/identity/service.ts        контакт, привязка, роли и приглашения
src/catalog/service.ts         ранги, услуги, эффективные тарифы
src/schedule/service.ts        шаблон, исключения, доступность, рабочие сроки
src/booking/service.ts         новые заявки, согласования, отмена, результат
src/booking/transfers.ts       двухсторонние переносы
src/notifications/planner.ts   расчёт уведомлений и перепланирование
src/notifications/outbox.ts    lease, доставка, повторы и terminal errors
src/jobs/scheduler.ts          Durable Object, arm/ensure/alarm
src/jobs/drain.ts              сроки и задания, bounded batch
src/reports/service.ts         статистика по области доступа
scripts/                      migrate, seed, webhook, backup/restore, smoke
tests/unit/                   чистые правила с явными now и timezone
tests/integration/            реальный PostgreSQL, гонки и транзакции
tests/worker/                 webhook/DO, Telegram API mock
tests/fixtures/               вымышленные пользователи/мастера/услуги
```

Общие типы этапа 2 в `src/domain/types.ts`: `Id=string`, `Instant=string` (ISO UTC); `Interval={start:Instant,end:Instant}`; `Actor={telegramId:Id}`; `DomainError={code:string,message:string}`; `CommandResult={entityId?:Id,status:string,nextWake:Instant|null}`. Набор команд расширяется discriminated union `Command` по этапам; произвольные названия функций не заменяют существующие интерфейсы. `OfferItem={serviceId:Id,name:string,priceKopecks:number,durationMinutes:number}`; `Conflict={visitId:Id,start:Instant,end:Instant,kind:'visit'|'transfer'}`. `WorkSchedule={timezone:'Europe/Moscow',weekly:Record<number,{startMinute:number,endMinute:number}[]>,exceptions:Record<string,{startMinute:number,endMinute:number}[]>}`: weekday ISO 1..7, даты исключений YYYY-MM-DD, пустой массив — выходной, перерывы задаются разрывом рабочих интервалов. `SmokeResult={webhook:boolean,database:boolean,scheduler:boolean,secretsRedacted:boolean}` вводится в scripts/smoke.ts на этапе 11.

`SqlReader={query<T>(text:string,values:unknown[]):Promise<T[]>}` и `Tx=SqlReader & {now:Instant}` вводятся в src/db/client.ts. `Database.read<T>(run:(sql:SqlReader)=>Promise<T>):Promise<T>` — параметризованные чтения; `Database.transaction<T>(run:(tx:Tx)=>Promise<T>):Promise<T>` — BEGIN, shop lock, commit/rollback, гарантированное закрытие Client. now получается из БД после получения shop lock (clock_timestamp(), не transaction-start now()), чтобы ожидание блокировки не позволяло подтверждать истёкший срок.

`Repository.execute(actor:Actor, command:Command, updateId:Id):Promise<CommandResult>` — атомарное выполнение и защита от повторного updateId. `Repository.replay(updateId:Id):Promise<CommandResult|null>` возвращает уже сохранённый результат для повторного arm. `Repository.nextDue():Promise<Instant|null>` и `Repository.drainDue(now:Instant,limit:number):Promise<{nextWake:Instant|null,remaining:boolean}>` — задания и сроки. CommandResult сохраняется с выполненным updateId.

`Scheduler.arm(at:Instant|null):Promise<void>` — только приближает срок, не удаляет более ранний; `Scheduler.ensure():Promise<void>` — без PostgreSQL восстанавливает нужный alarm. `Outbox.deliver(now:Instant,limit:number):Promise<{nextWake:Instant|null}>` — Telegram после commit, не меняет исходную бизнес-операцию. Сессия формы `Draft={id:Id,telegramId:Id,version:number,barberId:Id|null,lockedBarber:boolean,serviceIds:Id[],selectedStart:Instant|null,expiresAt:Instant}`.

## Этап 1: доказать доступность бесплатного размещения

**Сложность:** средняя, текущей модели достаточно. **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.env.example`, `.dev.vars.example`, `src/worker.ts`, `src/env.ts`, `src/jobs/scheduler.ts` (минимальный probe DO), `scripts/probe-neon.ts`, `docs/deployment.md`, `tests/worker/health.test.ts`. Код только после согласования плана.

**Interfaces:** `Env={BOT_TOKEN:string,BOT_INFO:string,WEBHOOK_SECRET:string,DATABASE_URL:string,FIRST_ADMIN_ID:string,SCHEDULER:DurableObjectNamespace}`; `fetch(request,env,ctx):Promise<Response>`; `ProbeScheduler.alarm():Promise<void>`; `probeDatabase(url:string):Promise<{ok:boolean}>`.

- [ ] Проверить полноценный Node LTS + npm: сейчас найден Node v24.22.1, npm в PATH не обнаружен. Использовать официальный дистрибутив после проверки имеющихся инструментов; глобальный runtime Codex не заменять. Пользователь сам создаёт аккаунты Cloudflare/Neon и тестового бота через BotFather; секреты вводит локально, не в чат и не GitHub. Убедиться, что включены только Free, без пробного платного периода/карты.
- [x] Создать минимальные конфигурации, затем тесты `health_has_no_db_dependency` (GET /health=200, dbCalls=0), `rejects_wrong_webhook_secret` (403, dbCalls=0), `database_probe_is_bounded` (один SELECT, вывод без URL/секрета). До реализации handler/probe `npm run test:worker -- tests/worker/health.test.ts` обязан падать по отсутствующей реализации.
- [x] Реализовать минимальные интерфейсы, прогнать `npm run typecheck`, указанные тесты и `npm run build` (Wrangler dry-run). Отдельный временный probe DO проверяет deploy/alarm на Free, не запускает опрос базы.
- [x] Выполнить минимальную реальную цепочку /start → webhook → SELECT 1 → ответ Telegram и alarm → безопасная тестовая отметка; не разворачивать остальной функционал. В отчёте проверить HTTPS workers.dev, webhook secret, runtime, интерактивную Neon-транзакцию BEGIN/SELECT/ROLLBACK, CPU и квоты. Удалить probe-маршрут из опубликованного Worker после проверки. GET /health не будит базу.
- [x] Зафиксировать результаты в docs/deployment.md без секретов. Если регистрация, DO Free, соединение или CPU не проходят, остановить реализацию и согласовать изменение подхода; не включать платный тариф. Коммит `chore: verify free Workers and Neon deployment`, push, сверка SHA.

Примечание к первому пункту: Node24.22.2/npm11.19.1 и аккаунты настроены; Neon Free и квота Workers100000/сутки подтверждены. Отсутствие карты/trial отдельно не проверено, поэтому смешанный административный пункт не отмечен целиком. Приёмка технического smoke и её ограничения описаны в docs/deployment.md.

## Этап 2: транзакционная основа и повторные события

**Сложность:** высокая; до исполнения предупредить о рекомендации усилить модель для проверки транзакций. **Files:** `src/domain/types.ts`, `src/db/client.ts`, `src/db/repository.ts`, `src/db/schema/001-core.sql`, `scripts/migrate.ts`, `scripts/seed.ts`, `src/bot/create-bot.ts`, `src/worker.ts`, `tests/integration/transactions.test.ts`, `tests/worker/webhook.test.ts`, `.github/workflows/check.yml`.

**Interfaces:** вводит общие `Database`, `Tx`, `Repository.execute/replay`, `CommandResult`; для первой проверяемой команды `Command={kind:'start',payload:string|null}`. Миграции применяются в порядке номера с checksum и таблицей schema_migrations; `migrate(url:string):Promise<void>`, `seed(url:string):Promise<void>` только тестовые данные.

- [x] Тесты: `rollback_removes_event_and_outbox` (ошибка после создания события оставляет 0 бизнес-изменений и 0 сообщений), `duplicate_update_returns_same_result` (один updateId дважды → один эффект), `concurrent_duplicate_commits_once` (два соединения → одна обработка), `failed_arm_retries_without_repeating_command` (commit сделан, arm упал → webhook 5xx; повтор arm успешен, эффект один), `missing_or_bad_secret_never_enters_db`. Сначала запустить `npm run test:integration -- tests/integration/transactions.test.ts` и `npm run test:worker -- tests/worker/webhook.test.ts`, проверить падение по отсутствующей логике.
- [x] Реализовать shop row lock и единый transaction lifecycle. Таблицы shop/settings, telegram_users/roles, clients/phone_claims, barbers/ranks/services/tariffs/assignments, weekly_hours/date_exceptions, visits/visit_items/holds/transfers, drafts/callbacks, invitations, processed_updates, audit_events, jobs/outbox. UUID PK; unique Telegram ID, активная привязка телефона и updateId; CHECK на положительную длительность, start<end, неотрицательные копейки; версии сущностей. Секретные invitation tokens только хешем. Минимальные индексируемые поля для due и пересечений.
- [x] В webhook граммY создавать с BOT_INFO без getMe на каждый запрос; важные действия/состояние формы и processed_update фиксировать вместе. Replay возвращает nextWake для повторного arm, ack 200 только после успешного arm. До этапа 4 bootstrap scheduler отправляет только простое сообщение /start и не имитирует готовность полной очереди; транзакционные тесты используют подставной Scheduler. Ожидаемые domain errors сохраняют один ответ-отказ и processed_update без частичных изменений (savepoint внутри общей транзакции); инфраструктурные ошибки откатывают всё и дают повторяемый 5xx. Callback acknowledgement — best effort после фиксации, без новых бизнес-эффектов. Никакого fire-and-forget как единственной доставки.
- [x] Реальная PostgreSQL-среда обязательна: отдельная Neon test branch либо PostgreSQL локально/в CI. CI сервис PostgreSQL, никогда runtime DATABASE_URL. `npm run db:migrate`, `npm run db:seed`, `npm run typecheck`, оба набора тестов, `npm run build` → 0 failures. Повтор миграций не меняет данные, seed не вызывает Telegram. Коммит `feat: add transactional repository and idempotent webhook`, push, сверка SHA.

## Этап 3: каталог, график и защита бронирований

**Сложность:** высокая; предупредить до исполнения о рекомендации усиления проверки гонок и временных границ. **Files:** `src/catalog/service.ts`, `src/schedule/service.ts`, `src/booking/service.ts`, `src/db/repository.ts`, `tests/unit/pricing.test.ts`, `tests/unit/schedule.test.ts`, `tests/integration/booking-races.test.ts`.

**Interfaces:** `effectiveOffer(barberId:Id,serviceIds:Id[],tx:Tx):Promise<{items:OfferItem[],priceKopecks:number,durationMinutes:number}>`; `approvalDeadline(now:Instant,work:Interval[]):Instant|null`; `listSlots(input:{barberId:Id,serviceIds:Id[],from:Instant,to:Instant,actorMode:'client'|'staff',excludeVisitId?:Id},db:Database):Promise<Interval[]>`; добавляет Command `requestBooking`, `confirmBooking`, `declineBooking`, `cancelBooking`, с ID/ожидаемой версией для изменений. Источник правды всегда повторно проверяется в execute.

- [x] Чистые тесты: override ранга; два предложения 60+30=90 минут и сумма копеек; нет тарифа → недоступно; шаг 30 минут, длительность 45 сохраняется; соседние интервалы разрешены; перерыв/выходной/исключение; минимум ровно 2 часа; граница today+30. Для смены 10–20 МСК now19:40 → deadline20:40; now21:00 → nextWorkingStart+1h; deadline>=visitStart → слот скрыт. `npm run test:unit -- tests/unit/pricing.test.ts tests/unit/schedule.test.ts` сначала FAIL, затем PASS.

Ключевое утверждение `approval_deadline_continues_after_shift` в schedule.test.ts (часы в ISO — UTC):

```ts
expect(approvalDeadline('2026-11-06T16:40:00.000Z', [
  { start: '2026-11-06T07:00:00.000Z', end: '2026-11-06T17:00:00.000Z' },
])).toBe('2026-11-06T17:40:00.000Z');
```

- [x] Интеграционные тесты: два независимых запроса 10:00–11:30 и 11:00–12:00 → один успех; один клиент одновременно к двум мастерам → одна pending; два последовательных непересекающихся визита допустимы; expired hold не мешает новому; подтверждение ровно в expiresAt запрещено; повтор callback не создаёт новую заявку. `npm run test:integration -- tests/integration/booking-races.test.ts` сначала FAIL, после реализации PASS на настоящем PostgreSQL.
- [x] Реализовать эффективные тарифы, UTC/локальные даты через Intl, график/исключения, половинные интервалы, снимки и pending hold. Под shop lock завершать истёкшие затронутые заявки, затем права/пересечения/лимиты; подтверждение до expiresAt, отмена клиента только до начала. Снимок нельзя пересчитать по текущему каталогу при подтверждении.
- [x] Добавить тест конфликта изменения графика с заявкой через одновременные соединения: либо изменение применено и заявка отклонена, либо заявка принята и изменение заблокировано. Все изменяющие пути используют тот же shop lock. Typecheck + unit + integration → PASS. Коммит `feat: enforce pricing schedules and atomic booking rules`, push, сверка SHA.

## Этап 4: надёжные уведомления и экономный планировщик

**Сложность:** высокая; заранее оценить усиление модели для двух хранилищ и повторов. **Files:** `src/notifications/outbox.ts`, `src/jobs/scheduler.ts`, `src/jobs/drain.ts`, `src/worker.ts`, `tests/worker/scheduler.test.ts`, `tests/integration/outbox.test.ts`.

**Interfaces:** `Scheduler.arm/ensure`, `Repository.nextDue/drainDue`, `Outbox.deliver` из общей схемы; `TelegramTransport.send(job:Delivery):Promise<{messageId:Id}>`; `Delivery={id:Id,chatId:Id,method:string,payload:unknown,entityId:Id|null,entityVersion:number|null}`. Пачка максимум 5 бизнес-заданий или сообщений на запуск, уточнить по CPU этапа 1, при remaining следующий alarm через 1 секунду.

- [x] Тесты `arm_preserves_earliest_under_interleaving` (два arm и завершающийся alarm не теряют ранний срок), `ensure_idle_does_not_query_neon` (1440 тиков, 0 SQL), `alarm_failure_schedules_retry`, `duplicate_alarm_does_not_duplicate_job_effect`, `outbox_lease_survives_crash`, `telegram_429_uses_retry_after`, `telegram_403_marks_unreachable_without_undoing_booking`. Запустить `npm run test:worker -- tests/worker/scheduler.test.ts` и `npm run test:integration -- tests/integration/outbox.test.ts`, сначала FAIL.
- [x] DO сначала в своём хранилище обнуляет/помечает текущий выполняемый срок и запоминает generation; после await к PostgreSQL объединяет возвращённый срок с любым новым arm, не перезаписывает ранний новый срок поздним старым. Обновление local state + setAlarm атомарно. Перед потенциально падающим вызовом назначает защитный повтор; после пустой очереди снимает лишний alarm только если не было нового arm. Cron ensure не обращается к Neon. При исчерпании ресурсов сообщать проблему, платные функции не включать.
- [x] Outbox: claim lease отдельной транзакцией, send с timeout вне неё, mark sent отдельной транзакцией. До отправки проверить состояние/версию визита. После timeout неизвестной доставки допускается повтор сообщения, но не бизнес-операции. 429 по retry_after, временные ошибки exponential backoff с пределом 5 минут; постоянные ошибки пометить failed, сигнал сотруднику при доступном канале. Один эффект deadline expiry и одно логическое уведомление благодаря unique job key.
- [x] Проверить успешный тест и реальное пробуждение после idle, запись в Neon только когда due. Коммит `feat: add durable wakeups and transactional notification delivery`, push, сверка SHA.

## Этап 5: телефон, роли и приглашения

**Сложность:** средняя, для гонок привязки — отдельная проверка. **Files:** `src/identity/service.ts`, `src/bot/screens.ts`, `src/bot/create-bot.ts`, `tests/unit/contact.test.ts`, `tests/integration/identity.test.ts`, `tests/worker/access.test.ts`.

**Interfaces:** `acceptContact(actor:Actor,contact:{userId?:Id,phone:string},tx:Tx):Promise<Id>`; `requirePermission(actor:Actor,action:string,resource:{barberId?:Id,clientId?:Id},tx:Tx):Promise<void>`; Command `updateContact`, `issueBarberInvite`, `redeemInvite`, `revokeInvite`. Все команды выполняются через Repository.execute.

- [x] Тесты: чужой/без user_id контакт отвергнут, свой номер принят; повтор номера в другом аккаунте → конфликт без смены владельца; смена номера не передаёт старые визиты; два redeem одного приглашения → один успех; истёкший/отозванный токен отвергнут; барбер не видит чужое расписание и статистику; клиент не может вызвать staff action старой кнопкой; первый админ создаётся идемпотентно. Команды `npm run test:unit -- tests/unit/contact.test.ts`, `npm run test:integration -- tests/integration/identity.test.ts`, `npm run test:worker -- tests/worker/access.test.ts` сначала FAIL.
- [x] Реализовать нормализацию, приватный чат, объединение только разрешённых будущих ручных записей и приглашения 24h. Доступ по actor и ресурсу, накопительные роли. Для пользователей вне личного чата показать, что нужно открыть личный диалог; не принимать контакт из группы.
- [x] Прогнать перечисленные тесты и typecheck → PASS. Коммит `feat: add verified Telegram contacts and scoped staff access`, push, сверка SHA.

## Этап 6: запись клиента кнопками и календарём

**Сложность:** средняя. **Files:** `src/bot/client.ts`, `src/bot/screens.ts`, `src/bot/create-bot.ts`, `src/db/repository.ts`, `tests/worker/client-flow.test.ts`, `tests/unit/calendar.test.ts`.

**Interfaces:** `renderClientScreen(draft:Draft,view:ClientView):Promise<Screen>`; `Screen={text:string,keyboard:InlineKeyboardMarkup|ReplyKeyboardMarkup}` (типы из grammY); `ClientView='masters'|'services'|'calendar'|'times'|'summary'|'bookings'|'settings'`; `handleClientAction(actor:Actor,callbackId:Id,tx:Tx):Promise<CommandResult>`; Command `start`, `clientAction`, `saveDraftInput` преобразуются в те же защищённые операции этапов 3/5. Репозиторий передаётся render через фабрику зависимостей, renderer не импортирует runtime секреты.

- [x] Worker-тест от /start до заявки: выбор мастера → услуги с отметками → календарь → часы → имя/контакт при необходимости → итог → pending; мастер получает кнопки, после confirm клиент получает точные детали. В персональном b_token пути мастера нет, чужую услугу/мастера из callback отвергнуть. Новая персональная ссылка делает прежнюю форму недействительной. Два нажатия «Записаться» дают одну заявку; срок 30 минут callback и отсутствующая форма → понятное обновление. Месяц/год, февраль и край горизонта, лимит 64 байта. `npm run test:worker -- tests/worker/client-flow.test.ts` и `npm run test:unit -- tests/unit/calendar.test.ts` сначала FAIL.
- [x] Реализовать persistent draft, короткие callback IDs и кнопки «Назад»; отсутствие услуги/слота объяснить и предложить другой день. Чтение календаря не бронирует. Подтверждение при изменении состояния после просмотра итога возвращает конфликт с предложением обновить время, не подтверждает старые данные. Пустой доступный каталог не приводит к ошибке.
- [x] Прогнать тесты + typecheck, вручную проверить тестовым клиентом и мастером на отдельном боте. Коммит `feat: add conversational client booking calendar`, push, сверка SHA.

## Этап 7: напоминания и управление записями клиента

**Сложность:** средняя. **Files:** `src/notifications/planner.ts`, `src/bot/client.ts`, `src/booking/service.ts`, `tests/unit/reminders.test.ts`, `tests/integration/client-bookings.test.ts`.

**Interfaces:** `planReminders(input:{visitId:Id,version:number,start:Instant,confirmedAt:Instant,now:Instant,hours:1|2|3|4|5}):ReminderPlan[]`; `ReminderPlan={key:string,dueAt:Instant,kind:'day'|'near'}`; Command `setReminderHours`, `cancelBooking`, `withdrawBooking`; при смене настройки пересчитать только ещё не отправленные задания подтверждённых будущих визитов.

- [x] Тесты: более суток → два напоминания; выбранные 5 часов прошли и до визита 3 часа → одно за 1 час, без старого 24h; ровно час/меньше → только подтверждение; выбранный 1 час ещё впереди → одно; настройка 1..5 сохраняется для следующей записи; изменение не шлёт задним числом уже отправленное; отмена аннулирует jobs и открытый перенос. `npm run test:unit -- tests/unit/reminders.test.ts` и `npm run test:integration -- tests/integration/client-bookings.test.ts` сначала FAIL.

Ключевое утверждение `missed_five_hours_falls_back_to_one` в reminders.test.ts:

```ts
expect(planReminders({
  visitId: 'v1', version: 1, hours: 5,
  start: '2026-11-07T18:00:00.000Z',
  confirmedAt: '2026-11-07T15:00:00.000Z', now: '2026-11-07T15:00:00.000Z',
}).map(({kind, dueAt}) => ({kind, dueAt}))).toEqual([
  {kind: 'near', dueAt: '2026-11-07T17:00:00.000Z'},
]);
```

- [x] Реализовать planner с чистыми явными now, уникальными ключами и версиями; не принимать время устройства клиента. В «Мои записи» только собственные визиты, отмена с подтверждением действия до начала, отзыв pending и настройка телефона/интервала. После commit arm; lost ack проверяется повтором updateId.
- [ ] Проверить тестами: позднее фоновое выполнение завершает pending, но при нажатии после срока операция уже запрещена; отменённый визит не создаёт новых сообщений напоминания. Коммит `feat: add client reminders settings and cancellation`, push, сверка SHA.

## Этап 8: переносы с согласием

**Сложность:** высокая; рекомендовать усиленную проверку до кода. **Files:** `src/booking/transfers.ts`, `src/bot/client.ts`, `src/bot/staff.ts`, `src/db/repository.ts`, `tests/unit/transfer-deadlines.test.ts`, `tests/integration/transfers.test.ts`.

**Interfaces:** Command `requestTransfer` / `proposeTransfer` с `visitId`, `expectedVersion`, `newStart`; `decideTransfer` с `transferId`, `expectedVersion`, `accept`; `recordPhoneAgreement` для не связанного с ботом ручного клиента. `transferDeadline(input:{initiator:'client'|'staff',now:Instant,oldStart:Instant,newStart:Instant,work:Interval[]}):Instant|null`.

- [ ] Тесты: клиентский перенос — минимум 2 часа и горизонт, мастер может ближе; оба сохраняют old hold до принятия; принятие атомарно заменяет снимок времени, услуги/цена прежние; отказ/истечение освобождают new; deadline=min(правило инициатора,oldStart,newStart), нулевой срок запрещён. Самопересекающийся old10:00–11:30,new10:30–12:00 разрешён, чужая заявка11:45 отвергнута. Один pending transfer на визит; клиентский transfer считается его одной pending заявкой.
- [ ] Тесты гонок: согласие и отмена, два согласия, согласие ровно в срок, изменение графика с обоими интервалами; итог всегда один допустимый статус, без потерянной старой записи и сиротской брони. Старое задание версии до переноса не планируется заново и не отправляется при проверке stale. Подтверждение по телефону запрещено для связанного Telegram-клиента, для ручного сохраняет who/when/channel. `npm run test:unit -- tests/unit/transfer-deadlines.test.ts` и `npm run test:integration -- tests/integration/transfers.test.ts` сначала FAIL.
- [ ] Реализовать commands под shop lock с проверкой initiator/approver и version; новые holds и jobs в той же транзакции. Меню обеих сторон и принятие по телефону; при отказе уведомить инициатора. Отмена визита погашает открытый перенос. Прогнать тесты → PASS. Коммит `feat: implement consent-based appointment transfers`, push, сверка SHA.

## Этап 9: управление услугами, персоналом и графиком

**Сложность:** средняя, конкурентные правки графика — высокая проверка. **Files:** `src/bot/admin.ts`, `src/catalog/service.ts`, `src/schedule/service.ts`, `src/identity/service.ts`, `tests/worker/admin-flow.test.ts`, `tests/integration/admin-conflicts.test.ts`.

**Interfaces:** Command `saveService`, `archiveService`, `saveRank`, `setRankTariff`, `setBarberTariff`, `assignBarberService`, `saveBarber`, `archiveBarber`, `saveWeeklyHours`, `saveDateException`, `setBookingHorizon`; изменяющие существующие сущности включают expectedVersion. `validateScheduleChange(barberId:Id,proposed:WorkSchedule,tx:Tx):Promise<Conflict[]>` возвращает реальные ID/даты визитов для меню админа.

- [ ] Worker-тест: админ создаёт ранг/мастера/услугу, задаёт ранг-тариф и override, назначает услуги/график, видит итог до сохранения; барбер/клиент те же callbacks получают denial. Неверные сумма/минуты/диапазон времени не записываются. Перерывы не пересекают смену, интервалы исключений валидируются. `npm run test:worker -- tests/worker/admin-flow.test.ts` сначала FAIL.
- [ ] Интеграционные тесты: старая запись сохраняет снимок после смены ранга/прайса; удаление услуги из назначения не ломает существующий визит; архивирование мастера с будущими pending/confirmed/transfers блокируется; отпуск затрагивает обе брони переноса → список конфликтов; вчерашний expired hold не мешает правке; конкурентные правки с expectedVersion не затирают друг друга. `npm run test:integration -- tests/integration/admin-conflicts.test.ts` сначала FAIL.
- [ ] Реализовать меню и текстовые формы; права admin в execute и audit для всех мутаций. Справочники с историей архивировать. Настройка горизонта не отменяет существующие визиты. Все тесты → PASS. Коммит `feat: add admin catalog staff and schedule management`, push, сверка SHA.

## Этап 10: рабочее место барбера, результаты и статистика

**Сложность:** средняя. **Files:** `src/bot/staff.ts`, `src/reports/service.ts`, `src/booking/service.ts`, `tests/worker/staff-flow.test.ts`, `tests/integration/reports.test.ts`.

**Interfaces:** Command `createManualBooking` (barberId,clientName,phone,serviceIds,start), `staffCancelBooking` (reason обязательна), `markOutcome` (visitId,version,outcome:'completed'|'no_show'), `correctOutcome` (admin,reason). `getReport(actor:Actor,input:{fromLocalDate:string,toLocalDate:string,barberId?:Id},db:Database):Promise<{completed:number,noShows:number,serviceValueKopecks:number}>` — локальные даты включительно.

- [ ] Тесты: «Сегодня»/день/неделя только свой scope; админ может фильтровать всех; ручная запись сразу confirmed, даже если осталось <2 часов, но не в прошлом/не вне графика/не в конфликт; несвязанный клиент не получает фиктивное Telegram-уведомление. Обязательная причина staff cancel → извинение/причина/новая запись. Итог до начала запрещён, после начала разрешён; автозавершения нет. `npm run test:worker -- tests/worker/staff-flow.test.ts` сначала FAIL.
- [ ] Тесты статистики: сумму дают только completed по snapshots, cancelled/no_show/pending не дают; граница суток МСК, период по началу визита; неявки считаются отдельно; чужой barberId rejected; исправление результата админом отражается в отчёте и аудите. `npm run test:integration -- tests/integration/reports.test.ts` сначала FAIL.
- [ ] Реализовать отчёт и меню; суммы подписать «Стоимость оказанных услуг», не «Оплачено». После связывания клиента показать ему будущую ручную запись и планировать только оставшиеся напоминания. Tests + typecheck → PASS. Коммит `feat: add barber workspace visit outcomes and reports`, push, сверка SHA.

## Этап 11: проверка всей первой версии и восстановление

**Сложность:** высокая интеграционная; до этапа оценить необходимость усиления финального ревью. **Files:** `tests/worker/acceptance.test.ts`, `tests/integration/acceptance.test.ts`, `scripts/backup.ps1`, `scripts/restore.ps1`, `scripts/set-webhook.ts`, `scripts/smoke.ts`, `docs/runbook.md`, `docs/deployment.md`, `README.md`, `.github/workflows/check.yml`.

**Interfaces:** `backup`/`restore` — pg_dump custom-format и pg_restore с заранее проверенными параметрами подключения из окружения; `setWebhook(env):Promise<void>` через POST, secret_token, allowed_updates message/callback_query, без token в URL логов; `smoke(env):Promise<SmokeResult>` печатает только статусы. Резервная копия — зашифрованный том/папка пользователя вне Git, ежедневный запуск Windows Task Scheduler только при включённом компьютере; 7 последних успешных копий. Это не облачная круглосуточная гарантия: при недоступном компьютере следующий запуск выполняет пропущенное задание и показывает возраст копии. Перед публикацией пользователь выбирает локальный путь, копия не пишется в публичный GitHub.

- [ ] Добавить сквозные тесты матрицы спецификации: все три роли, оба входа, multi-service, контакт, заявка/истечение, оба переноса и телефонный случай, отмена, тарифные снимки, конфликт графика, напоминания, результаты и статистика. Обязателен сценарий повторной доставки каждого изменяющего события и параллельных переносов/заявок. До закрытия gaps тесты должны FAIL, затем PASS; не подменять реальную PostgreSQL памятью.
- [ ] Выполнить `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run test:worker`, `npm run test:integration`, `npm run build`; все 0 failures. Проверка runtime secrets отсутствуют в Git/логах, /health не раскрывает настройки и не запрашивает БД, callback от другого аккаунта недействителен. Ограничить размер webhook и выдачу календаря для CPU Free.
- [ ] Создать backup тестовой базы; восстановить в отдельную пустую тестовую БД (никогда поверх исходной). Сравнить количества и ключевые связи, snapshots, версии, jobs и роли. У восстановленного стенда не должно быть доступа к Telegram до явного включения доставки, чтобы не повторить старые сообщения. Описать восстановление совместимой версии кода и схемы; не использовать destructive rollback как стандарт.
- [ ] Опубликовать тестового бота, провести приёмку клиентом/мастером/админом, снять фактические задержки/CPU/число запросов и расход Neon за наблюдаемый период. Проверить период idle не создаёт SELECT от cron и не держит Client открытым. Прогноз месячного потребления явно пометить оценкой, при угрозе квот ограничить тестовую нагрузку/согласовать изменение; не обещать Free под любой нагрузкой. Наблюдать напоминания и deadline в реальном времени, не сообщать «проверено» только по mocks.
- [ ] Независимый Code Reviewer проверяет полный diff и evidence против спецификации, конкретные security paths — с AppSec по необходимости. Исправить блокирующие замечания, повторить только затронутые проверки. Коммит `chore: validate first version deployment and recovery`, push, сверка SHA; выдать ссылку на бота и инструкцию для трёх ролей, перечислить реальные ограничения бесплатного хостинга.

## Команды и правила выполнения

Скрипты package.json: `typecheck=tsc --noEmit`, `test:unit=vitest run --config vitest.unit.config.ts`, `test:worker=vitest run --config vitest.config.ts`, `test:integration=vitest run --config vitest.integration.config.ts`, `build=wrangler deploy --dry-run`, `db:migrate=tsx scripts/migrate.ts`, `db:seed=tsx scripts/seed.ts`, `dev=wrangler dev`. Соответствующие Vitest-конфигурации создаются на этапах 1–2. Нет обещания работающей команды до создания её конфигурации.

Все TDD-шаги: записать конкретный тест → подтвердить FAIL из-за отсутствующей логики → реализовать минимально → PASS. Сетевые зависимости в unit/worker mocks, настоящая БД обязательна для транзакций/гонок. Провалы из-за незаданного тестового URL или недоступного пакета не считаются доказанным красным тестом бизнес-логики.

После каждого этапа `git diff --check`, релевантные тесты, ревью, явный `git add` списка файлов, коммит с указанным сообщением, `git push origin <branch>`, `git ls-remote origin refs/heads/<branch>` и сравнение с HEAD. План не требует новой worktree: использовать подходящий текущий checkout по инструкциям приложения, изоляцию при необходимости определить перед исполнением.

## Проверка полноты плана

| Раздел спецификации | Где реализуется |
| --- | --- |
| Размещение и 0 рублей | 1, 4, 11 |
| Роли, приглашения, контакты | 2, 5, 9 |
| Ранги, услуги, снимки | 3, 9 |
| Графики/исключения/конфликты | 3, 9 |
| Общий/персональный вход, календарь | 5, 6 |
| Заявки и сроки/блокировки | 2, 3, 4, 6 |
| Ручные клиенты и запись | 5, 10 |
| Согласованные переносы | 8 |
| Отмена и результат визита | 7, 10 |
| Напоминания и настройки | 4, 7, 8 |
| Админ и рабочее место | 9, 10 |
| Статистика | 10 |
| Целостность/аудит/повторы | 2–5, 8, 11 |
| Резервные копии/публикация | 11 |

Самопроверка исполнителя перед выдачей: покрытие спецификации, одинаковые имена общих интерфейсов, конкретные файлы/проверки, пять failure modes выше привязаны к этапам. Приложение и тесты этим документом не созданы и не запускались.

## Основания технических решений

Проверено 2026-11-06 по первичным источникам:

- [grammY на Workers Node.js](https://grammy.dev/hosting/cloudflare-workers-nodejs): webhook с BOT_INFO без постоянного polling.
- [Neon driver](https://neon.com/docs/serverless/serverless-driver): HTTP для одиночных запросов, Client/Pool для интерактивных транзакций; закрывать соединения в пределах вызова Worker.
- [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html): row locks живут до конца транзакции.
- [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/): 10 мс CPU, ожидание сетевых запросов не считается CPU; нужен runtime probe, а не обещание по объёму кода.
- [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): SQLite-backed DO доступен на Free.
- [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): at-least-once, ограниченные встроенные повторы; нужен идемпотентный handler и собственное восстановление alarm.
- [Neon Free](https://neon.com/pricing): конечный бюджет вычислений, постоянный опрос базы исключён.
- [Workers Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/): проверять поведение в runtime Workers, не только Node.

## Передача к реализации

План согласован пользователем, включая решения исполнителя (планировщик DO, точные границы, формы, резервирование). Сохраняется ранее выбранная работа с субагентами и остановками между этапами. Выполнить только этап 1, показать фактический результат, затем обсуждать следующий. Не запускать сразу все 11 этапов. Этап 1 нельзя считать завершённым без реального deploy, проверки Neon-транзакции, Telegram webhook и DO alarm.
