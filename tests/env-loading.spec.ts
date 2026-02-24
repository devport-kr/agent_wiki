import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvFiles } from "../src/shared/load-env";

const touchedKeys = ["DEVPORT_ENV_ALPHA", "DEVPORT_ENV_BETA", "DEVPORT_ENV_KEEP"];

describe("loadEnvFiles", () => {
  afterEach(() => {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
  });

  it("loads .env.local and .env without overriding existing process env", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "devport-env-fixture-"));
    writeFileSync(
      join(fixtureDir, ".env.local"),
      [
        "DEVPORT_ENV_ALPHA=from-local",
        "DEVPORT_ENV_BETA='from local quoted'",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(fixtureDir, ".env"),
      [
        "DEVPORT_ENV_ALPHA=from-env",
        "DEVPORT_ENV_KEEP=from-env",
      ].join("\n"),
      "utf8",
    );
    process.env.DEVPORT_ENV_KEEP = "from-process";

    try {
      const result = loadEnvFiles({ cwd: fixtureDir });

      expect(process.env.DEVPORT_ENV_ALPHA).toBe("from-local");
      expect(process.env.DEVPORT_ENV_BETA).toBe("from local quoted");
      expect(process.env.DEVPORT_ENV_KEEP).toBe("from-process");
      expect(result.loadedFiles).toHaveLength(2);
      expect(result.loadedKeys).toContain("DEVPORT_ENV_ALPHA");
      expect(result.loadedKeys).toContain("DEVPORT_ENV_BETA");
      expect(result.loadedKeys).not.toContain("DEVPORT_ENV_KEEP");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
