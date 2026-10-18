# Скриншоты Chat Tabs 0.1.13

Каталог `docs/screenshots/current/` снят 14 октября 2026 года в работающем BB с установленным `tabs@0.1.13`. Это отрисованные реальные компоненты плагина, не макеты и не картинки image generation. Каталог режимов, вкладки, sidebar metadata, поиск, CRUD и настройки заменены браузерной SDK-фикстурой только для Chat Tabs; другие плагины и хост BB не подменены.

Все показанные имена, проекты, статусы и ошибки демонстрационные. Посторонние области скрыты только при screenshot, UI-область обрезана по своим bounds. Реальные переписки не включены; реальные чаты/режимы не создавались, не переименовывались, не архивировались и не удалялись. Серверный каталог и настройки сверяются до/после. Фото изображают возможности UI, а не реальные длительные runs или поломку пользовательской БД.

Использован локальный Chromium, desktop 1440 px, compact 390 px, light/dark. Длинные домашние/настроечные блоки показаны как crop области, а не как точный размер физического экрана. Эмуляция не является проверкой iOS/Android, native Safari, screen reader или системных shortcuts BB Desktop.

## Английские примеры для README

`docs/screenshots/chat-strip-desktop-en.png` и `docs/screenshots/new-chat-lists-en.png` сняты отдельно в локальном BB при `language=English`: палитра, алиасы, английские названия проектов/чатов, закрепления и избранное заданы только SDK-фикстурой в браузере. Это crops самой полосы и двух homepage sections, без реальной переписки и composer. Сценарии и результаты находятся в `.tmp/localization-audit/` и `.tmp/localization-followup/`. Публичный README использует английские примеры; русскоязычные изображения ниже остаются дополнительной галереей, а не английской витриной BB.

## Основные поверхности

- [Desktop-полоса и header-selector](current/chat-strip-desktop.png), [dark](current/chat-strip-dark.png), [compact](current/chat-strip-mobile.png).
- [Новый чат](current/new-chat-lists.png), [compact-карточки](current/new-chat-mobile.png), [visit-local undo](current/homepage-undo.png).
- [Закрепления и история](current/chat-list-history.png), [поиск проекта](current/chat-search.png), [нет совпадений](current/chat-search-empty.png).
- [Проекты для composer](current/recent-projects.png).
- [Контекстное меню](current/tab-context-menu.png), [membership](current/workspace-membership.png).
- [Диалог названия чата](current/chat-rename-dialog.png), [inline rename](current/chat-inline-rename.png).
- [Прямые дети](current/subthread-menu.png), [вложенное дерево](current/subthread-tree.png).
- [Меню режимов](current/workspace-menu.png), [управление](current/workspace-management.png), [compact-управление](current/workspace-management-mobile.png).
- [Создание без смены режима](current/workspace-created.png), [rename режима](current/workspace-inline-rename.png), [delete confirmation](current/workspace-delete-confirmation.png).
- [Настройки desktop](current/settings-desktop.png), [compact](current/settings-mobile.png).
- [Пустой список](current/new-chat-empty.png), [loading](current/new-chat-loading.png), [storage error](current/new-chat-error.png).

Поведение каждой поверхности описано в `docs/README.md` и связанных атомарных заметках. Старые `real-bb-*.png` сохранены как прежние иллюстрации; новые заметки используют только `current/`, поскольку selector и управление изменились в v0.1.13.

Воспроизводящий скрипт и отчёты текущего прогона находятся в `.tmp/documentation/`; исполняемая копия архивируется перед full-check, чтобы внешние test-only импорты Playwright не попадали в SDK boundary scan. Они не являются runtime dependency плагина.
