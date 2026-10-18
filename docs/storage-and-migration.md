# Хранение и однократная миграция

Вкладки, избранное и режимы — plugin-owned state, не производная от sidebar BB. Коллекция V1 со стабильными workspace ID, ревизией, отдельными `TabsState` и защитой закрытых ID хранится одним JSON-envelope в одной строке SQLite плагина. Один write атомарно меняет коллекцию и её revision.

Полный набор до 20 × (100 вкладок + 100 favorites) не упирается в KV-лимит 256 KB на значение. Общая история остаётся отдельно в `tabs.history.v1`; её запись и write workspace-коллекции не образуют одну cross-store транзакцию.

При первом чтении без новой строки legacy `tabs.state.v1` и `tabs.closedThreads.v1` импортируются в `work` один раз. Создаются пустые `home` и `other`; старые KV-ключи не удаляются и не изменяются. Повторный startup не переимпортирует legacy. Ошибка первой записи не должна оставлять частично мигрированную коллекцию.

Повреждённая новая строка вызывает явную ошибку, а не замену legacy-состоянием или пустым набором. После восстановления backup перезагрузите окно BB: frontend может хранить watermark более новой ревизии. В v0.1.13 новых миграций относительно v0.1.12 нет.

Window selection, last-active и explicit-close undo находятся отдельно в sessionStorage/memory, не в серверной коллекции. Membership и optional parent metadata совместимы с V1.

Связанные заметки: [ревизии](synchronization-and-errors.md), [выбор окна](window-local-selection.md), [общая история](chat-history.md), [лимиты](limits-and-boundaries.md).
