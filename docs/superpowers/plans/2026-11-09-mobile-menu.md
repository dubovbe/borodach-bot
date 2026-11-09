# Mobile Menu A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить обрезание общей навигации и оформить выбранное меню A обычными эмодзи.
**Architecture:** Меняем только подписи и ряды существующих inline-кнопок. Общая навигация остаётся доступной напрямую; оба пути её формирования используют одну раскладку. Служебные action/callback и права сохраняются.
**Tech Stack:** Существующий TypeScript/grammY, Workers, Vitest; без зависимостей и миграций.
**Spec:** [Подтверждённый дизайн A](../specs/2026-11-09-mobile-menu-design.md).

## Global Constraints

- Порядок общей навигации: «📋 Мои записи», «⚙️ Настройки», затем доступные «💈 Рабочее место», «📊 Статистика», «🔄 Переносы», последним «🛠 Управление». Каждый пункт — отдельный ряд.
- Прежние action: bookings/settings/staff(scope staff)/staffReport(scope staff)/staffTransfers/admin. Условия staffVisible/adminVisible сохраняются.
- Рабочее место: Today/Week одной короткой парой, затем отдельные Date/Pending/Manual/Report. Подписи — точные значения дизайна; возврат «⬅️ К рабочему месту» ведёт к прежнему kind:home.
- Reply-кнопки контакта, календарные ячейки, даты, бизнес-правила и данные не меняются. Внутренний админский редактор не расширяем; общий вход «Управление» получает эмодзи.
- Не добавлять B-подменю, дополнительные идеи, новую библиотеку или шрифтовые/цветовые API. Backup-настройка отложена.

## Review Focus

1. Submitted boundary строит клавиатуру отдельно: новая раскладка нужна также после отправки заявки.
2. После перестановки кнопок каждый UUID должен соответствовать прежнему action и пользователю.
3. Пункты мастера/админа не появляются у клиента без профиля или прав; прежний backend по-прежнему отклоняет чужой callback.
4. Эмодзи не меняют текст reply-ввода «Назад»/передачу контакта; длинные данные и календарные ряды не затрагиваются.
5. Новая подпись Date не ломает маршруты Today/Week/Home; тесты не должны скрывать ошибки широким переименованием или удалением утверждений.

## Task 1: Inline-навигация A

**Files:** modify src/bot/client.ts, src/bot/staff-workspace.ts; tests/worker/client-flow.test.ts, staff-flow.test.ts, admin-flow.test.ts. При необходимости обновить только поиск/ожидания изменённых подписей в tests/integration/client-bookings.test.ts, admin-conflicts.test.ts, identity.test.ts.
**Interfaces:** локальный managementRows():ScreenButton[][] вместо одномерного managementButtons; callbacks() и submittedBoundary() добавляют эти ряды через spread. Существующие action-объекты и непрозрачные callback_data сохраняются. Общая staff-кнопка back сохраняет kind:home.

- [ ] Сначала добавить поведенческие Worker-проверки: до профиля клиенту доступны ровно две одиночные строки; мастеру — пять, администратору — шесть в порядке дизайна. Сопоставить callback_data с сохранённым action, проверить отсутствие чужих пунктов. Например: `expect(navRows.map(r=>r.length)).toEqual(expectedLabels.map(()=>1)); expect(navRows.map(r=>r[0].text)).toEqual(expectedLabels)`.
- [ ] Дополнить существующий тест submittedBoundary проверкой такой же навигации после отправки заявки; существующие проверки версии/неповтора визита сохранить. Добавить точную раскладку рабочего места и переходы новых Today/Date/Week/Back-подписей.
- [ ] Запустить затронутые файлы через `node node_modules/vitest/vitest.mjs run tests/worker/client-flow.test.ts tests/worker/staff-flow.test.ts tests/worker/admin-flow.test.ts`. Зафиксировать RED из-за старого ряда/подписей до правки product-кода.
- [ ] Реализовать managementRows и применить в обоих путях client.ts; изменить только навигационные подписи/ряды staff-workspace.ts. Адаптировать точные тестовые подписи, не ослабляя assertions и security-проверки.
- [ ] Повторить затронутые Worker-тесты, затем `npm.cmd run test:unit`, `npm.cmd run test:worker`, `npm.cmd run typecheck`, `npm.cmd run build`; ожидаются 0 failures. Не запускать неизменённые Node/полный Neon локально; полный PostgreSQL-набор пройдёт в CI.
- [ ] Самопроверка, frozen report с RED/GREEN и точным списком файлов; независимое SPEC/QUALITY ревью только нового diff от базы 921df9c. Исправления проверять затронутыми тестами.
- [ ] Основной агент: проверить diff/секреты/байты миграций, коммит `fix: make mobile navigation readable`, push/сверка SHA и draft PR поверх chore/stage-11-validation-recovery; дождаться обязательного CI.
- [ ] Основной агент: обновить существующий тестовый Worker без смены схемы/webhook/секретов и без seed/reset, выполнить безопасный smoke и сравнить защищённые записи/роли/снимки до и после. Пользователь на аккаунтах 1/2 открывает свежий /start и проверяет меню на телефоне; итог записать в GitHub.

## Execution and self-review

Одна задача, без параллельных изменений файлов. Прежний согласованный метод: Backend Architect Sol Medium + независимый Code Reviewer Sol High, основной агент владеет документацией/Git/CI/публикацией. Текущий checkout сохраняем; отдельная ветка feat/mobile-menu-a от 921df9c, новая worktree не требуется по предпочтению проекта.

План сверён с коротким дизайном: все подписи и ограничения покрыты; пять рисков привязаны к конкретным Worker-сценариям и существующим проверкам. Пользователь явно подтвердил реализацию по дизайну и ранее выбрал исполнение через работников; этот план не добавляет требований и не требует повторного согласования того же объёма.
