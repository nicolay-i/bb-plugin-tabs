# Темы, анимации и доступность

Chat Tabs использует semantic tokens темы BB и `color-mix(in oklch)`, а не отдельную фиксированную палитру. Избранное, работа и выбранность должны оставаться различимыми в light/dark/custom themes; серый nested-only индикатор намеренно без halo.

![Та же полоса в тёмной теме](screenshots/current/chat-strip-dark.png)

Workspace-dialog открывается за 160 мс, закрывается за 120 мс; backdrop тоже fades. Отдельный `scale` не заменяет transform центрирования. Разные state-анимации позволяют Radix Presence удерживать closing-узел до завершения, затем удалить и вернуть фокус. При `prefers-reduced-motion: reduce` dialog/overlay и меню не анимируются; дополнительных JS timers для этого нет.

Controls имеют локализованные accessible names, описание полного имени, focus rings и статусы, не зависящие лишь от цвета. Пункты selector — radio, memberships — checkbox; dialogs имеют title/description. Иконки-декорации скрыты от повторного чтения screen reader.

Compact/touch цели не меньше 44×44 px; desktop inline header-control остаётся 28 px под размеры штатного chrome. Длинные имена обрезаются визуально, но остаются в tooltip/описании. Arabic использует RTL и logical insets.

Скриншоты подтверждают внешнее представление в конкретной теме, не полную accessibility certification или физический screen-reader тест. Связанные заметки: [язык](interface-language.md), [клавиатура](keyboard-shortcuts.md), [layout](responsive-layout.md), [dialog](workspace-management.md).
