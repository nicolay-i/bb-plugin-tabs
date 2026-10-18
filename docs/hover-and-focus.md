# Hover раскрывает меню, не забирая фокус

Mouse-hover над selector режима, кнопкой списка или плюсом открывает соответствующий popup примерно через 300 мс. Он не переводит ввод из composer в меню и не блокирует чат modal-overlay. Touch/pen не трактуются как hover.

![Меню списка можно открыть, сохранив возможность ввода в чате](screenshots/current/chat-list-history.png)

Уход до задержки отменяет открытие. Между trigger и popup есть короткий leave-grace порядка 120 мс: crossing gap не закрывает меню. Если меню открыто только наведением, уход с обеих поверхностей закрывает его; первый клик фиксирует его, после чего mouse-leave не закрывает. Повторный клик trigger или действие outside закрывает popup.

Клик/tap и ArrowDown остаются самостоятельными путями, не требуют hover. Keyboard-opening явно передаёт ownership навигации меню; Escape закрывает его. После [управления режимами](workspace-management.md) фокус возвращается к selector, а не случайному фоновому tab.

Меню [детей](subthread-navigation.md) отличается задержкой 250 мс и переходом во вложенные submenu. «Ещё» в истории/проектах раскрывает следующую порцию на клик/tap или 300 мс hover; timers очищаются при leave/unmount.

Фокус-neutral mouse path не отменяет а11y-клавиатурную навигацию. См. [поиск](chat-search.md), [клавиатуру](keyboard-shortcuts.md), [темы и motion](theme-motion-accessibility.md).
