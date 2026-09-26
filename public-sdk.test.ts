import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("Chat Tabs", () => {
  it("handles behavior 1", async () => {
    const result = await experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^react(?:\/.*)?$/u,
        /^@testing-library\/react$/u,
        /^@hugeicons\/(?:react|core-free-icons)$/u,
        /^@radix-ui\/react-(?:context-menu|dialog|dropdown-menu|popover)$/u,
        /^(?:clsx|tailwind-merge|sonner)$/u,
        /^node:fs\/promises$/u,
      ],
    });

    expect(result.privateDependencies).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
