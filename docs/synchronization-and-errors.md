# Синхронизация без отката нового намерения

Операции набора явно адресуют workspace ID. Read–modify–write сериализованы общей очередью; сохранённая коллекция и revision публикуются после успешной записи. No-op не создаёт лишней mutation. Metadata каталога не распространяет выбор окна.

Realtime state передаёт workspace ID и монотонную ревизию; клиент отбрасывает старые snapshots и ответы прошлого поколения посещения. Route epoch, URL и отдельная explicit-selection revision защищают навигацию, включая A→B→A. Rename/fallback каталога не считаются новым явным выбором пользователя.

Серверный availability cache после lifecycle-события сильнее запоздавшего metadata lookup. Reconciliation и restore перечитывают актуальное состояние внутри очереди, поэтому архивированный чат не возвращается из одновременно завершившегося старого RPC. Transient/permission-ошибки сохраняют записи, а не masquerade как удаление.

Membership читает актуальный state после mutation tail, refresh-ится при открытии/reconnect/revision-сигнале и не применяет ответ закрытого submenu. Hidden-sidechat activity имеет собственные generation/revision, независимые от tab-content clocks.

Ошибка записи оставляет данные и возможность retry, а не успешную галочку. UI-ошибки scoped к текущему посещению; old result не навигирует после нового намерения. Повреждение storage не лечится reset автоматически.

Это согласованность состояния плагина, не транзакция с history или runtime BB. Связанные заметки: [storage](storage-and-migration.md), [lifecycle](archive-delete-lifecycle.md), [membership](workspace-memberships.md), [ошибочные состояния](empty-loading-error-states.md).
