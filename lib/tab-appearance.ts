import { z } from "zod";

export const DEFAULT_TAB_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#22a06b",
  "#e38c25",
  "#e45b86",
  "#14a3ad",
];
const MAX_APPEARANCE_BYTES = 128 * 1024;
const reservedIds = new Set(["__proto__", "prototype", "constructor"]);
const idSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((id) => id === id.trim() && !reservedIds.has(id));
const colorSchema = z.string().regex(/^#[\da-f]{6}$/iu);
const slotSchema = z.number().int().min(0).max(5);
const aliasSchema = z
  .string()
  .trim()
  .refine((alias) => [...alias].length <= 32 && !/\p{Cc}/u.test(alias));
const projectSchema = z.object({ alias: aliasSchema, color: slotSchema.nullable() }).strict();
const appearanceSchema = z
  .object({
    version: z.literal(1),
    palette: z.array(colorSchema).length(6),
    projects: z.record(idSchema, projectSchema),
    tabs: z.record(idSchema, slotSchema),
  })
  .strict();
export type TabAppearance = z.infer<typeof appearanceSchema>;

export function defaultTabAppearance(): TabAppearance {
  return { version: 1, palette: [...DEFAULT_TAB_PALETTE], projects: {}, tabs: {} };
}

/** Invalid stored settings are readable with defaults, but must never be overwritten silently. */
export function readTabAppearance(value: unknown): TabAppearance | null {
  if (value === undefined) return defaultTabAppearance();
  if (
    typeof value !== "string" ||
    value.length > MAX_APPEARANCE_BYTES ||
    new TextEncoder().encode(value).byteLength > MAX_APPEARANCE_BYTES
  )
    return null;
  try {
    const raw: unknown = JSON.parse(value, (key: string, entry: unknown) => {
      if (reservedIds.has(key)) throw new Error("Invalid appearance key.");
      return entry;
    });
    const parsed = appearanceSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const appearanceSettingSchema = z
  .string()
  .refine(
    (value) => readTabAppearance(value) !== null,
    "Invalid tab appearance settings (maximum 128 KB).",
  );

export const appearanceUpdateSchema = z.union([
  z
    .object({
      kind: z.literal("palette"),
      colors: z
        .array(z.object({ index: slotSchema, color: colorSchema }).strict())
        .min(1)
        .max(6)
        .refine((colors) => new Set(colors.map(({ index }) => index)).size === colors.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: idSchema,
      alias: aliasSchema.optional(),
      color: slotSchema.nullable().optional(),
    })
    .strict()
    .refine((patch) => patch.alias !== undefined || patch.color !== undefined),
  z.object({ kind: z.literal("project-add"), projectId: idSchema }).strict(),
  z.object({ kind: z.literal("project-remove"), projectId: idSchema }).strict(),
  z.object({ kind: z.literal("tab"), threadId: idSchema, color: slotSchema.nullable() }).strict(),
]);
export type AppearanceUpdate = z.infer<typeof appearanceUpdateSchema>;

/** Field patches merge under the server's existing queue, including edits from other windows. */
export function updateTabAppearance(
  current: TabAppearance,
  patch: AppearanceUpdate,
): TabAppearance {
  const next = { ...current };
  if (patch.kind === "palette") {
    next.palette = [...current.palette];
    for (const { index, color } of patch.colors) next.palette[index] = color;
  } else if (patch.kind === "project") {
    const project = {
      ...(current.projects[patch.projectId] ?? { alias: "", color: null }),
      ...(patch.alias !== undefined ? { alias: patch.alias } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    next.projects = { ...current.projects, [patch.projectId]: project };
  } else if (patch.kind === "project-add") {
    next.projects = {
      ...current.projects,
      [patch.projectId]: current.projects[patch.projectId] ?? { alias: "", color: null },
    };
  } else if (patch.kind === "project-remove") {
    next.projects = { ...current.projects };
    delete next.projects[patch.projectId];
  } else {
    next.tabs = { ...current.tabs };
    if (patch.color === null) delete next.tabs[patch.threadId];
    else next.tabs[patch.threadId] = patch.color;
  }
  appearanceSettingSchema.parse(JSON.stringify(next));
  return next;
}

export function tabAppearanceColor(appearance: TabAppearance, threadId: string, projectId: string) {
  const index = appearance.tabs[threadId] ?? appearance.projects[projectId]?.color;
  return index === undefined || index === null ? undefined : appearance.palette[index];
}

export function tabAppearanceTitle(appearance: TabAppearance, projectId: string, title: string) {
  const alias = appearance.projects[projectId]?.alias;
  return alias ? `[${alias}] ${title}` : title;
}
