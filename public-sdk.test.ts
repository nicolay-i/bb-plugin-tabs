import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("Public SDK boundary", () => {
  it("rejects private SDK APIs and dependencies outside the runtime allowlist", () => {
    const result = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^react(?:\/.*)?$/u,
        /^@testing-library\/react$/u,
        /^@hugeicons\/(?:react|core-free-icons)$/u,
        /^@radix-ui\/react-(?:context-menu|dialog|dropdown-menu|popover)$/u,
        /^(?:clsx|tailwind-merge|sonner)$/u,
        /^node:fs\/promises$/u,
      ],
    });

    // Development-only imports are allowed only in these exact files, not in plugin code.
    const developmentImports: Record<string, string[]> = {
      "eslint.config.mjs": ["@eslint/js", "typescript-eslint", "eslint-plugin-react-hooks"],
      "test-utils.ts": ["@get-bb/plugin-sdk/testing", "@get-bb/plugin-sdk/testing/app"],
    };
    expect(result.privateDependencies).toEqual([]);
    expect(
      result.violations.filter(
        ({ file, specifier, reason }) =>
          reason !== "outside-allowlist" || !developmentImports[file]?.includes(specifier),
      ),
    ).toEqual([]);
  });
});
