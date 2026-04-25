import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrateAgentConfig } from "../src/migrateAgentConfig";

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

describe("migrateAgentConfig", () => {
  test("migrates workspace and user .agent config into canonical .cowork paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-migrate-"));
    const cwd = path.join(root, "workspace");
    const home = path.join(root, "home");

    try {
      await writeJson(path.join(cwd, ".agent", "config.json"), {
        provider: "openai",
        modelSettings: { maxRetries: 2, existing: "legacy" },
      });
      await writeJson(path.join(cwd, ".cowork", "config.json"), {
        model: "gpt-5.4",
        modelSettings: { existing: "canonical" },
      });
      await writeJson(path.join(cwd, ".agent", "mcp-servers.json"), {
        servers: [
          { name: "existing", transport: { type: "stdio", command: "legacy-existing" } },
          { name: "imported", transport: { type: "stdio", command: "legacy-imported" } },
        ],
      });
      await writeJson(path.join(cwd, ".cowork", "mcp-servers.json"), {
        servers: [{ name: "existing", transport: { type: "stdio", command: "canonical" } }],
      });
      await fs.mkdir(path.join(cwd, ".agent", "skills", "legacy-skill"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".agent", "skills", "legacy-skill", "SKILL.md"),
        "# Legacy skill\n",
        "utf-8",
      );
      await fs.writeFile(path.join(cwd, ".agent", "AGENT.md"), "legacy hot cache", "utf-8");

      await writeJson(path.join(home, ".agent", "config.json"), { userName: "Legacy User" });

      const result = await migrateAgentConfig({ cwd, homedir: home });
      const workspace = result.scopes.find((scope) => scope.scope === "workspace");
      const user = result.scopes.find((scope) => scope.scope === "user");

      expect(workspace?.configImported).toBe(2);
      expect(workspace?.configSkippedConflicts).toBe(1);
      expect(workspace?.mcpImported).toBe(1);
      expect(workspace?.mcpSkippedConflicts).toBe(1);
      expect(workspace?.entriesImported).toBe(2);
      expect(workspace?.archivedPath).toContain(".agent.legacy-migrated.");
      expect(user?.configImported).toBe(1);

      const workspaceConfig = await readJson(path.join(cwd, ".cowork", "config.json"));
      expect(workspaceConfig.provider).toBe("openai");
      expect(workspaceConfig.model).toBe("gpt-5.4");
      expect(workspaceConfig.modelSettings).toEqual({ existing: "canonical", maxRetries: 2 });

      const userConfig = await readJson(path.join(home, ".cowork", "config", "config.json"));
      expect(userConfig.userName).toBe("Legacy User");

      const mcp = await readJson(path.join(cwd, ".cowork", "mcp-servers.json"));
      expect((mcp.servers as Array<{ name: string }>).map((server) => server.name)).toEqual([
        "existing",
        "imported",
      ]);

      await fs.access(path.join(cwd, ".cowork", "skills", "legacy-skill", "SKILL.md"));
      expect(await fs.readFile(path.join(cwd, ".cowork", "AGENT.md"), "utf-8")).toBe(
        "legacy hot cache",
      );
      await expect(fs.access(path.join(cwd, ".agent"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
