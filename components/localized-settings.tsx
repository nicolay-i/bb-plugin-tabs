import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icon } from "./ui/icon";
import { experimental_useSidebarThreads, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { SETTINGS, type SettingKey } from "../lib/settings";
import { latestProjectActivity } from "../lib/recent-projects";
import { fuzzyChatSearch } from "../lib/fuzzy-chat-search";
import {
  translate,
  usePluginLocale,
  type LanguageSetting,
  type PluginLocale,
} from "../lib/plugin-locale";
import {
  readTabAppearance,
  type TabAppearance,
  type AppearanceUpdate,
  tabAppearanceTitle,
} from "../lib/tab-appearance";

export function LocalizedSettings() {
  const settings = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const prefix = useId();
  const [tab, setTab] = useState<"general" | "appearance">("general");
  const [appearanceVisited, setAppearanceVisited] = useState(false);
  const latestValues = useRef(settings.values);
  latestValues.current = settings.values;
  const [overrides, setOverrides] = useState<Record<string, string | number | boolean>>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setOverrides({});
  }, [settings.values]);
  const values = { ...settings.values, ...overrides };
  const locale = usePluginLocale(values.language as LanguageSetting);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const appearance = useMemo(() => readTabAppearance(values.tabAppearance), [values.tabAppearance]);
  const persist = async (
    request: () => Promise<{ values: Record<string, string | number | boolean> }>,
    optimistic: Record<string, string | boolean> = {},
  ) => {
    if (savingRef.current) return false;
    const previous = overrides;
    const source = settings.values;
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    setOverrides((current) => ({ ...current, ...optimistic }));
    try {
      const result = await request();
      setOverrides(latestValues.current === source ? result.values : {});
      return true;
    } catch {
      setOverrides(latestValues.current === source ? previous : {});
      setFailed(true);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = (key: Exclude<SettingKey, "tabAppearance">, value: string | boolean) =>
    persist(() => rpc.call("tabs_settings_update", { [key]: value }), { [key]: value });
  const saveAppearance = (patch: AppearanceUpdate) =>
    persist(() => rpc.call("tabs_appearance_update", patch));

  return (
    <section
      className="bb-chat-tabs-settings"
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      aria-busy={saving || settings.isLoading}
    >
      <h2 className="bb-chat-tabs-settings-heading">{t("Configuration")}</h2>
      <div
        className="bb-chat-tabs-settings-tabs"
        role="tablist"
        aria-label={t("Configuration")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          );
          const index = buttons.findIndex((button) => button === event.target);
          if (index < 0) return;
          event.preventDefault();
          const direction = (event.key === "ArrowRight" ? 1 : -1) * (locale === "ar" ? -1 : 1);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + direction + buttons.length) % buttons.length;
          buttons[next]!.click();
          buttons[next]!.focus();
        }}
      >
        {(["general", "appearance"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${prefix}-${value}-tab`}
            aria-controls={`${prefix}-${value}-panel`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              setTab(value);
              if (value === "appearance") setAppearanceVisited(true);
            }}
          >
            {t(value === "general" ? "General" : "Appearance")}
          </button>
        ))}
      </div>
      <fieldset disabled={saving || settings.isLoading || settings.values === undefined}>
        <div
          role="tabpanel"
          className="bb-chat-tabs-settings-panel"
          id={`${prefix}-general-panel`}
          aria-labelledby={`${prefix}-general-tab`}
          hidden={tab !== "general"}
        >
          {Object.entries(SETTINGS)
            .filter(([key]) => key !== "tabAppearance")
            .map(([rawKey, descriptor]) => {
              const key = rawKey as Exclude<SettingKey, "tabAppearance">;
              const id = `${prefix}-${key}`;
              const value = values[key] ?? descriptor.default;
              return (
                <div className="bb-chat-tabs-settings-row" key={key}>
                  <div className="bb-chat-tabs-settings-copy">
                    <label htmlFor={id}>{t(descriptor.label)}</label>
                    <p id={`${id}-description`}>{t(descriptor.description)}</p>
                  </div>
                  {descriptor.type === "boolean" ? (
                    <input
                      id={id}
                      type="checkbox"
                      role="switch"
                      checked={value === true}
                      aria-describedby={`${id}-description`}
                      onChange={(event) => void save(key, event.target.checked)}
                    />
                  ) : descriptor.type === "select" ? (
                    <select
                      id={id}
                      value={String(value)}
                      aria-describedby={`${id}-description`}
                      onChange={(event) => void save(key, event.target.value)}
                    >
                      {descriptor.options.map((option) => (
                        <option key={option} value={option}>
                          {option === "Auto" || option === "Left" || option === "Right"
                            ? t(option)
                            : option}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              );
            })}
        </div>
        <div
          role="tabpanel"
          className="bb-chat-tabs-settings-panel"
          id={`${prefix}-appearance-panel`}
          aria-labelledby={`${prefix}-appearance-tab`}
          hidden={tab !== "appearance"}
        >
          {appearanceVisited &&
            (appearance === null ? (
              <p className="bb-chat-tabs-settings-error" role="alert">
                {t("Invalid tab appearance settings.")}
              </p>
            ) : (
              <AppearanceSettings
                appearance={appearance}
                visible={tab === "appearance"}
                locale={locale}
                save={saveAppearance}
                pending={saving}
                failed={failed}
              />
            ))}
        </div>
      </fieldset>
      {failed ? (
        <p className="bb-chat-tabs-settings-error" role="alert">
          {t("Could not save settings.")}
        </p>
      ) : null}
    </section>
  );
}

type ProjectDraft = { alias?: string; color?: number | null };

function AppearanceSettings({
  appearance,
  visible,
  locale,
  save,
  pending,
  failed,
}: {
  appearance: TabAppearance;
  visible: boolean;
  pending: boolean;
  failed: boolean;
  locale: PluginLocale;
  save: (patch: AppearanceUpdate) => Promise<boolean>;
}) {
  const prefix = useId();
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectDraft>({});
  const listSearchRef = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const sidebar = experimental_useSidebarThreads();
  const projects = useMemo(() => {
    if (!visible || !open) return [];
    const activity = latestProjectActivity(sidebar.threads);
    return [...sidebar.projects].sort(
      (a, b) =>
        Number(activity.has(b.id)) - Number(activity.has(a.id)) ||
        (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name, locale),
    );
  }, [sidebar.projects, sidebar.threads, locale, visible, open]);
  const matches = useMemo(
    () =>
      query.trim()
        ? fuzzyChatSearch(
            projects.map((project) => ({
              project,
              title: project.name,
              projectName: appearance.projects[project.id]?.alias ?? "",
            })),
            query,
            projects.length,
          ).map(({ project }) => project)
        : projects,
    [projects, query, appearance.projects],
  );
  const selectedProject = sidebar.projects.find((project) => project.id === projectId);
  const listedProjects = useMemo(() => {
    if (!open) return [];
    const names = new Map(sidebar.projects.map((project) => [project.id, project.name]));
    const rows = Object.entries(appearance.projects).map(([id, value]) => ({
      id,
      name: names.get(id) ?? id,
      ...value,
    }));
    rows.sort((a, b) => a.name.localeCompare(b.name, locale));
    return listQuery.trim()
      ? fuzzyChatSearch(
          rows.map((project) => ({ project, title: project.name, projectName: project.alias })),
          listQuery,
          rows.length,
        ).map(({ project }) => project)
      : rows;
  }, [appearance.projects, sidebar.projects, listQuery, locale, open]);
  const expanded = visible && open && suggestionsOpen;
  const activeIndex = matches.findIndex((project) => project.id === activeProjectId);
  useEffect(() => {
    if (!expanded) return;
    const option = projectListRef.current?.querySelector('[aria-selected="true"]');
    if (typeof option?.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
  }, [expanded, activeProjectId]);
  const chooseProject = (project: { id: string; name: string }) => {
    if (project.id !== projectId) setDraft({});
    setProjectId(project.id);
    setQuery(project.name);
    setActiveProjectId(null);
    projectInputRef.current?.focus({ preventScroll: true });
    setSuggestionsOpen(false);
  };
  return (
    <div className="bb-chat-tabs-appearance-settings">
      <h3>{t("Tab colors")}</h3>
      <div className="bb-chat-tabs-palette">
        {appearance.palette.map((color, index) => (
          <label key={index}>
            {t("Color {number}", { number: index + 1 })}
            <input
              type="color"
              aria-label={t("Color {number}", { number: index + 1 })}
              value={colors[index] ?? color}
              onChange={(event) =>
                setColors((current) => ({ ...current, [index]: event.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="bb-chat-tab-dialog-button"
        disabled={Object.keys(colors).length === 0}
        onClick={() =>
          void save({
            kind: "palette",
            colors: Object.entries(colors).map(([index, color]) => ({
              index: Number(index),
              color,
            })),
          }).then((saved) => {
            if (saved) setColors({});
          })
        }
      >
        {t("Save palette")}
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!pending) {
            setOpen(next);
            setSuggestionsOpen(false);
          }
        }}
      >
        <Dialog.Trigger asChild>
          <button type="button" className="bb-chat-tab-dialog-button bb-chat-tabs-project-manage">
            {t("Project aliases and colors")}…
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="bb-chat-tab-rename-overlay bb-chat-tabs-workspace-overlay" />
          <Dialog.Content
            className="bb-chat-tab-rename-dialog bb-chat-tabs-workspace-dialog bb-chat-tabs-project-dialog bb-chat-tabs-settings bb-chat-tabs-appearance-settings"
            lang={locale}
            dir={locale === "ar" ? "rtl" : "ltr"}
            aria-busy={pending}
            onEscapeKeyDown={(event) => {
              if (pending || expanded) event.preventDefault();
              if (expanded) {
                setSuggestionsOpen(false);
                setActiveProjectId(null);
              }
            }}
          >
            <div className="bb-chat-tabs-workspace-dialog-header">
              <Dialog.Title className="bb-chat-tab-rename-title">
                {t("Project aliases and colors")}
              </Dialog.Title>
              <Dialog.Description className="bb-chat-tab-rename-description">
                {t(
                  "Projects and chats in BB are not deleted. Removing a project clears only its alias and project color.",
                )}
              </Dialog.Description>
            </div>
            {failed && (
              <p role="alert" className="bb-chat-tabs-settings-error">
                {t("Could not save settings.")}
              </p>
            )}
            <fieldset className="bb-chat-tabs-appearance-settings" disabled={pending}>
              <label htmlFor={`${prefix}-list-search`}>{t("Search projects")}</label>
              <input
                ref={listSearchRef}
                id={`${prefix}-list-search`}
                type="search"
                className="bb-chat-tabs-project-search"
                value={listQuery}
                maxLength={300}
                onChange={(event) => setListQuery(event.target.value)}
              />
              <ul className="bb-chat-tabs-workspace-list bb-chat-tabs-project-list">
                {listedProjects.map((project) => (
                  <li key={project.id}>
                    {deleteId === project.id ? (
                      <div
                        className="bb-chat-tabs-workspace-confirm"
                        role="group"
                        aria-label={`${t("Remove from list")}: ${project.name}`}
                      >
                        <p>
                          {t("Remove this project from the list?")} <strong>{project.name}</strong>
                        </p>
                        <div className="bb-chat-tabs-workspace-confirm-actions">
                          <button
                            type="button"
                            autoFocus
                            className="bb-chat-tab-dialog-button"
                            onClick={() => setDeleteId(null)}
                          >
                            {t("Cancel")}
                          </button>
                          <button
                            type="button"
                            className="bb-chat-tab-dialog-button bb-chat-tabs-project-remove"
                            onClick={() =>
                              void save({ kind: "project-remove", projectId: project.id }).then(
                                (saved) => {
                                  if (!saved) return;
                                  setDeleteId(null);
                                  if (projectId === project.id) {
                                    setProjectId("");
                                    setDraft({});
                                  }
                                  listSearchRef.current?.focus({ preventScroll: true });
                                },
                              )
                            }
                          >
                            {t("Remove from list")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="bb-chat-tabs-project-row-copy">
                          <strong dir="auto">{project.name}</strong>
                          <span dir="auto">{project.alias || "—"}</span>
                        </div>
                        {project.color !== null && (
                          <span
                            className="bb-chat-tabs-project-color"
                            style={{ background: appearance.palette[project.color] }}
                            role="img"
                            aria-label={t("Color {number}", { number: project.color + 1 })}
                          />
                        )}
                        <button
                          type="button"
                          className="bb-chat-tabs-workspace-action"
                          title={t("Edit")}
                          aria-label={`${t("Edit")}: ${project.name}`}
                          onClick={() => {
                            setDeleteId(null);
                            chooseProject(project);
                          }}
                        >
                          <Icon name="Edit" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="bb-chat-tabs-workspace-action bb-chat-tabs-project-remove"
                          title={t("Remove from list")}
                          aria-label={`${t("Remove from list")}: ${project.name}`}
                          onClick={() => setDeleteId(project.id)}
                        >
                          <Icon name="Trash2" aria-hidden />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {listedProjects.length === 0 && <p role="status">{t("No projects found")}</p>}
              <h3>{t(projectId && appearance.projects[projectId] ? "Edit" : "Add project")}</h3>
              <div
                className="bb-chat-tabs-project-picker"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setSuggestionsOpen(false);
                }}
              >
                <label htmlFor={`${prefix}-project`}>{t("Choose a project")}</label>
                <input
                  ref={projectInputRef}
                  id={`${prefix}-project`}
                  className="bb-chat-tabs-project-search"
                  type="text"
                  role="combobox"
                  autoComplete="off"
                  spellCheck={false}
                  aria-autocomplete="list"
                  aria-expanded={expanded}
                  aria-controls={expanded ? `${prefix}-projects` : undefined}
                  aria-activedescendant={
                    expanded && activeIndex >= 0 ? `${prefix}-project-${activeIndex}` : undefined
                  }
                  placeholder={t("Search projects")}
                  maxLength={300}
                  value={query}
                  onFocus={() => setSuggestionsOpen(true)}
                  onClick={() => setSuggestionsOpen(true)}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveProjectId(null);
                    setSuggestionsOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setSuggestionsOpen(true);
                      if (matches.length === 0) {
                        setActiveProjectId(null);
                        return;
                      }
                      const index =
                        event.key === "ArrowDown"
                          ? (activeIndex + 1) % matches.length
                          : activeIndex <= 0
                            ? matches.length - 1
                            : activeIndex - 1;
                      setActiveProjectId(matches[index]?.id ?? null);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (!expanded) return;
                      const project = matches[activeIndex] ?? matches[0];
                      if (project) chooseProject(project);
                    } else if (event.key === "Escape" && expanded) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSuggestionsOpen(false);
                      setActiveProjectId(null);
                    }
                  }}
                />
                {expanded && (
                  <div
                    id={`${prefix}-projects`}
                    className="bb-chat-tabs-project-options"
                    ref={projectListRef}
                    role="listbox"
                    aria-label={t("Choose a project")}
                  >
                    {matches.map((project, index) => (
                      <button
                        type="button"
                        role="option"
                        tabIndex={-1}
                        key={project.id}
                        id={`${prefix}-project-${index}`}
                        aria-selected={activeProjectId === project.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerMove={(event) => {
                          if (event.pointerType === "mouse") setActiveProjectId(project.id);
                        }}
                        onClick={() => chooseProject(project)}
                      >
                        {tabAppearanceTitle(appearance, project.id, project.name)}
                      </button>
                    ))}
                  </div>
                )}
                {expanded && matches.length === 0 ? (
                  <p role="status">{t("No projects found")}</p>
                ) : null}
              </div>
              {projectId ? (
                <ProjectAppearanceEditor
                  key={projectId}
                  projectId={projectId}
                  projectName={selectedProject?.name ?? projectId}
                  appearance={appearance}
                  locale={locale}
                  save={save}
                  draft={draft}
                  setDraft={setDraft}
                />
              ) : null}
            </fieldset>
            <div className="bb-chat-tabs-workspace-dialog-footer">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="bb-chat-tab-dialog-button bb-chat-tab-dialog-button-primary"
                  disabled={pending}
                >
                  {t("Done")}
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function ProjectAppearanceEditor({
  projectId,
  projectName,
  appearance,
  locale,
  save,
  draft,
  setDraft,
}: {
  projectId: string;
  projectName: string;
  draft: ProjectDraft;
  setDraft: Dispatch<SetStateAction<ProjectDraft>>;
  appearance: TabAppearance;
  locale: PluginLocale;
  save: (patch: AppearanceUpdate) => Promise<boolean>;
}) {
  const prefix = useId();
  const t = (key: Parameters<typeof translate>[1], variables?: Record<string, string | number>) =>
    translate(locale, key, variables);
  const { alias, color } = draft;
  const project = appearance.projects[projectId];
  const dirty = alias !== undefined || color !== undefined;
  return (
    <form
      className="bb-chat-tabs-project-appearance"
      aria-label={projectName}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty && project) return;
        void save(
          dirty
            ? {
                kind: "project",
                projectId,
                ...(alias !== undefined ? { alias } : {}),
                ...(color !== undefined ? { color } : {}),
              }
            : { kind: "project-add", projectId },
        ).then((saved) => {
          if (saved) setDraft({});
        });
      }}
    >
      <strong className="bb-chat-tabs-selected-project" dir="auto">
        {projectName}
      </strong>
      <label htmlFor={`${prefix}-alias`}>{t("Project alias")}</label>
      <input
        id={`${prefix}-alias`}
        type="text"
        maxLength={64}
        value={alias ?? project?.alias ?? ""}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            alias: [...event.target.value].slice(0, 32).join(""),
          }))
        }
      />
      <label htmlFor={`${prefix}-color`}>{t("Project color")}</label>
      <select
        id={`${prefix}-color`}
        value={String((color === undefined ? project?.color : color) ?? "none")}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            color: event.target.value === "none" ? null : Number(event.target.value),
          }))
        }
      >
        <option value="none">{t("No color")}</option>
        {appearance.palette.map((_, index) => (
          <option key={index} value={String(index)}>
            {t("Color {number}", { number: index + 1 })}
          </option>
        ))}
      </select>
      <button
        className="bb-chat-tab-dialog-button"
        type="submit"
        disabled={!dirty && project !== undefined}
      >
        {t(project ? "Save project" : "Add")}
      </button>
    </form>
  );
}
