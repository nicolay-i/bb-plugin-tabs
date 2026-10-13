import { useCallback, useEffect, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../server";
import type { TabEntry } from "../lib/tabs-model";
import { stateRevisionSchema, WORKSPACE_MEMBERSHIPS_CHANGED_CHANNEL } from "../lib/workspaces";
import { translate, type PluginLocale } from "../lib/plugin-locale";
import { Icon } from "./ui/icon";

type Memberships = PluginRpcResult<(typeof rpcContract)["tabs_workspace_memberships"]>;

/** Mounted only while the submenu is open; never changes window selection or navigates. */
export function WorkspaceMembershipOptions({
  entry,
  locale,
}: {
  entry: TabEntry;
  locale: PluginLocale;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<Memberships | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const revision = useRef(0);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const refresh = useCallback(
    async function load(retry = true) {
      const token = ++request.current;
      try {
        const result = await rpcRef.current.call("tabs_workspace_memberships", {
          threadId: entry.threadId,
        });
        if (!mounted.current || token !== request.current) return;
        if (result.stateRevision < revision.current) {
          if (retry) return load(false);
          return;
        }
        revision.current = result.stateRevision;
        setSnapshot(result);
        setError(null);
      } catch (cause) {
        if (mounted.current && token === request.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [entry.threadId],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh, connection]);

  useRealtime(WORKSPACE_MEMBERSHIPS_CHANGED_CHANNEL, (payload) => {
    const parsed = stateRevisionSchema.safeParse(payload);
    if (!parsed.success || !Number.isSafeInteger(parsed.data) || parsed.data <= revision.current)
      return;
    revision.current = parsed.data;
    void refresh();
  });

  const setIncluded = async (workspaceId: string, included: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const result = included
        ? await rpcRef.current.call("tabs_open", {
            threadId: entry.threadId,
            projectId: entry.projectId,
            title: entry.title,
            ...(entry.parentThreadId ? { parentThreadId: entry.parentThreadId } : {}),
            workspaceId,
          })
        : await rpcRef.current.call("tabs_close", { threadId: entry.threadId, workspaceId });
      if (!mounted.current) return;
      revision.current = Math.max(revision.current, result.stateRevision ?? 0);
      await refresh();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <>
      {snapshot === null && error === null ? (
        <ContextMenu.Item className="bb-chat-tab-context-menu-item" disabled>
          {t("Loading tabs…")}
        </ContextMenu.Item>
      ) : null}
      {snapshot?.workspaces.map((workspace) => {
        const label = workspace.defaultName ? t(workspace.defaultName) : workspace.name;
        return (
          <ContextMenu.CheckboxItem
            key={workspace.id}
            className="bb-chat-tab-context-menu-item"
            checked={workspace.included}
            disabled={pending}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => void setIncluded(workspace.id, checked === true)}
          >
            <span className="bb-chat-tabs-membership-check">
              <ContextMenu.ItemIndicator>
                <Icon name="Check" aria-hidden />
              </ContextMenu.ItemIndicator>
            </span>
            <span className="bb-chat-tabs-membership-name" title={label}>
              {label}
            </span>
          </ContextMenu.CheckboxItem>
        );
      })}
      {error === null ? null : (
        <>
          <div className="bb-chat-tabs-membership-error" role="alert">
            {error}
          </div>
          <ContextMenu.Item
            className="bb-chat-tab-context-menu-item"
            disabled={pending}
            onSelect={(event) => {
              event.preventDefault();
              void refresh();
            }}
          >
            {t("Retry")}
          </ContextMenu.Item>
        </>
      )}
    </>
  );
}
