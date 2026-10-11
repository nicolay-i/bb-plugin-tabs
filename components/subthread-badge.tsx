import { translate, type PluginLocale } from "../lib/plugin-locale";
import { Icon } from "./ui/icon";

/** Shared marker for child chats; roots keep their existing appearance. */
export function SubthreadBadge({ locale = "en" }: { locale?: PluginLocale }) {
  const label = translate(locale, "Subthread");
  return (
    <span className="bb-chat-tabs-subthread-badge" title={label} aria-label={label}>
      <Icon name="GitBranch" aria-hidden />
    </span>
  );
}
