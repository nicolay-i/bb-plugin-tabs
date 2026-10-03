import { useEffect, useId, useRef, useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { SETTINGS, type SettingKey } from "../lib/settings";
import { translate, usePluginLocale, type LanguageSetting } from "../lib/plugin-locale";

export function LocalizedSettings() {
  const settings = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const prefix = useId();
  const [overrides, setOverrides] = useState<Record<string, string | number | boolean>>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setOverrides({}); }, [settings.values]);
  const values = { ...settings.values, ...overrides };
  const locale = usePluginLocale(values.language as LanguageSetting);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const save = async (key: SettingKey, value: string | boolean) => {
    if (savingRef.current) return;
    const previous = overrides;
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    setOverrides((current) => ({ ...current, [key]: value }));
    try {
      // The server validates keys, types and enum options before persistence.
      const result = await rpc.call("tabs_settings_update", { [key]: value });
      setOverrides(result.values);
    } catch {
      setOverrides(previous);
      setFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="bb-chat-tabs-settings" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} aria-busy={saving || settings.isLoading}>
      <h2 className="bb-chat-tabs-settings-heading">{t("Configuration")}</h2>
      <fieldset disabled={saving || settings.isLoading || settings.values === undefined}>
        {Object.entries(SETTINGS).map(([rawKey, descriptor]) => {
          const key = rawKey as SettingKey;
          const id = `${prefix}-${key}`;
          const value = values[key] ?? descriptor.default;
          return (
            <div className="bb-chat-tabs-settings-row" key={key}>
              <div className="bb-chat-tabs-settings-copy">
                <label htmlFor={id}>{t(descriptor.label)}</label>
                <p id={`${id}-description`}>{t(descriptor.description)}</p>
              </div>
              {descriptor.type === "boolean" ? (
                <input id={id} type="checkbox" role="switch" checked={value === true}
                  aria-describedby={`${id}-description`}
                  onChange={(event) => void save(key, event.target.checked)} />
              ) : (
                <select id={id} value={String(value)} aria-describedby={`${id}-description`}
                  onChange={(event) => void save(key, event.target.value)}>
                  {descriptor.options.map((option) => (
                    <option key={option} value={option}>
                      {option === "Auto" || option === "Left" || option === "Right" ? t(option) : option}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </fieldset>
      {failed ? <p className="bb-chat-tabs-settings-error" role="alert">{t("Could not save settings.")}</p> : null}
    </section>
  );
}
