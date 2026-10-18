# Язык интерфейса и названия режимов

`language=Auto` выбирает поддерживаемый HTML-язык страницы BB, затем язык браузера, затем English. Явный выбор фиксирует язык плагина. Сам интерфейс BB, пользовательские имена чатов и проектов этим не переводятся.

![Язык применяется и к собственным настройкам плагина](screenshots/current/settings-desktop.png)

Английский — исходный язык интерфейса и публичных описаний BB; дополнительные переводы выбираются внутри плагина. После Auto все 15 названий идут единым алфавитным списком со стабильной английской collation: Bahasa Indonesia, Deutsch, English, Español, Français, Italiano, Português (Brasil), Tiếng Việt, Türkçe, Русский, العربية, हिन्दी, 한국어, 中文（简体）, 日本語. Отдельных групп и закреплённых языков нет; сохраняемые autonyms не изменены. Settings, подсказки, статусы и accessible labels меняют язык без reload; Auto реагирует на смену HTML lang. Некоторые дополнительные переводы — machine-assisted first drafts, а не гарантия native-speaker review.

Системные режимы Work/Home/Other хранят default-marker: показываемая подпись следует текущему языку независимо от языка первого создания. Пользовательское переименование убирает этот marker навсегда для данного имени: новое имя больше не переводится автоматически.

Валидация дублей учитывает переведённые системные подписи. Grapheme initial сохраняет emoji/combined character полностью; Arabic включает RTL. Значения `Auto`, `Left`, `Right` и ключи настроек в storage/CLI не переводятся.

Связанные заметки: [selector](workspace-selector.md), [rename режима](workspace-renaming.md), [настройки](plugin-settings.md), [доступность](theme-motion-accessibility.md).
