import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectInstallation,
  installerPlan,
  isUpdateCommandInvocation,
  parsePackageInstaller,
  replaceStandaloneBinary,
  updatePhoton,
  verifyInstalledVersion,
  type InstallerPlan,
} from "~/lib/self-update.ts";

describe("detectInstallation", () => {
  test("detects supported global package managers", () => {
    expect(
      detectInstallation(
        "/Users/me/.bun/install/global/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/bun"
      ).kind
    ).toBe("bun");
    expect(
      detectInstallation(
        "/Users/me/Library/pnpm/global/5/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/node"
      ).kind
    ).toBe("pnpm");
    expect(
      detectInstallation(
        "/Users/me/.config/yarn/global/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/node"
      ).kind
    ).toBe("yarn");
    expect(
      detectInstallation(
        "/opt/homebrew/lib/node_modules/@photon-ai/cli/dist/photon.js",
        "/opt/homebrew/bin/node"
      ).kind
    ).toBe("npm");
  });

  test("distinguishes standalone, one-off, and development invocations", () => {
    expect(detectInstallation("/usr/local/bin/photon", "/usr/local/bin/photon").kind).toBe(
      "standalone"
    );
    expect(
      detectInstallation(
        "/$bunfs/root/photon-darwin-arm64",
        "/usr/local/bin/photon"
      )
    ).toEqual({ kind: "standalone", entryPath: "/usr/local/bin/photon" });
    expect(
      detectInstallation(
        "/Users/me/.npm/_npx/123/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/node"
      ).kind
    ).toBe("ephemeral");
    expect(
      detectInstallation(
        "/Users/me/.bun/install/cache/@photon-ai/cli@2.0.0@@@1/dist/photon.js",
        "/usr/local/bin/bun"
      ).kind
    ).toBe("ephemeral");
    expect(
      detectInstallation("/workspace/photon/cli/src/index.ts", "/usr/local/bin/bun").kind
    ).toBe("development");
  });

  test("preserves the stable invocation symlink for post-update verification", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-detect-test-"));
    try {
      const target = path.join(
        tmpDir,
        ".bun/install/global/node_modules/@photon-ai/cli/dist/photon.js"
      );
      const invocation = path.join(tmpDir, "bin/photon");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.mkdirSync(path.dirname(invocation), { recursive: true });
      fs.writeFileSync(target, "");
      fs.symlinkSync(target, invocation);

      const detected = detectInstallation(invocation, "/usr/local/bin/node");

      expect(detected.kind).toBe("bun");
      expect(detected.entryPath).toBe(invocation);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recognizes a project-local Yarn Berry invocation", () => {
    expect(
      detectInstallation(
        "/Users/me/.yarn/berry/cache/photon-cli.zip/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/node",
        {
          INIT_CWD: "/Users/me/project",
          npm_config_user_agent: "yarn/4.9.2 npm/? node/v22.0.0 darwin arm64",
        }
      )
    ).toEqual({
      kind: "yarn-berry",
      entryPath:
        "/Users/me/.yarn/berry/cache/photon-cli.zip/node_modules/@photon-ai/cli/dist/photon.js",
    });
  });

  test("distinguishes Yarn dlx from a project-local Berry invocation", () => {
    expect(
      detectInstallation(
        "/private/var/folders/tmp/xfs-123/dlx-456/.yarn/cache/photon-cli.zip/node_modules/@photon-ai/cli/dist/photon.js",
        "/usr/local/bin/node",
        {
          INIT_CWD: "/private/var/folders/tmp/xfs-123/dlx-456",
          npm_config_user_agent: "yarn/4.9.2 npm/? node/v22.0.0 darwin arm64",
        }
      )
    ).toEqual({
      kind: "yarn-dlx",
      entryPath:
        "/private/var/folders/tmp/xfs-123/dlx-456/.yarn/cache/photon-cli.zip/node_modules/@photon-ai/cli/dist/photon.js",
    });
  });
});

describe("installerPlan", () => {
  test("uses argument arrays and the pinned registry version", () => {
    expect(installerPlan("npm", "3.0.0")).toEqual({
      command: "npm",
      args: ["install", "--global", "@photon-ai/cli@3.0.0"],
    });
    expect(installerPlan("bun", "3.0.0")).toEqual({
      command: "bun",
      args: ["add", "--global", "@photon-ai/cli@3.0.0"],
    });
    expect(installerPlan("yarn", "3.0.0")).toEqual({
      command: "yarn",
      args: ["global", "add", "@photon-ai/cli@3.0.0"],
    });
    expect(installerPlan("bun", "3.0.0", true)).toEqual({
      command: "bun",
      args: ["add", "--global", "--force", "@photon-ai/cli@3.0.0"],
    });
  });

  test("passes --force to Yarn Classic global reinstalls", () => {
    expect(installerPlan("yarn", "3.0.0", true)).toEqual({
      command: "yarn",
      args: ["global", "add", "--force", "@photon-ai/cli@3.0.0"],
    });
  });

  test("rejects unknown installer overrides", () => {
    expect(() => parsePackageInstaller("brew")).toThrow("Unknown installer");
  });
});

describe("isUpdateCommandInvocation", () => {
  test("recognizes update with or without a preceding global flag", () => {
    expect(isUpdateCommandInvocation(["node", "photon", "update"])).toBe(true);
    expect(isUpdateCommandInvocation(["node", "photon", "--debug", "update"])).toBe(true);
    expect(isUpdateCommandInvocation(["node", "photon", "projects", "list"])).toBe(false);
    expect(isUpdateCommandInvocation(["node", "photon", "projects", "update"])).toBe(
      false
    );
  });
});

describe("updatePhoton", () => {
  test("reports an available update without running an installer in check mode", async () => {
    let runs = 0;
    const result = await updatePhoton(
      { check: true },
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "3.0.0",
        runInstaller: async () => {
          runs += 1;
        },
      }
    );

    expect(result.status).toBe("update-available");
    expect(runs).toBe(0);
  });

  test("does nothing when the current version is latest", async () => {
    let runs = 0;
    const result = await updatePhoton(
      {},
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "2.0.0",
        runInstaller: async () => {
          runs += 1;
        },
      }
    );

    expect(result.status).toBe("up-to-date");
    expect(runs).toBe(0);
  });

  test("force reinstalls the current version with the installer force flag", async () => {
    let plan: InstallerPlan | undefined;
    const result = await updatePhoton(
      { force: true },
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "2.0.0",
        installation: { kind: "bun", entryPath: "/global/photon.js" },
        runInstaller: async (nextPlan) => {
          plan = nextPlan;
        },
        verifyInstalled: async () => undefined,
      }
    );

    expect(plan?.args).toContain("--force");
    expect(result.status).toBe("reinstalled");
  });

  test("force never downgrades a version newer than the latest dist-tag", async () => {
    let plan: InstallerPlan | undefined;
    const result = await updatePhoton(
      { force: true },
      {
        currentVersion: "4.0.0-beta.1",
        latestVersion: async () => "3.0.0",
        installation: { kind: "npm", entryPath: "/global/photon.js" },
        runInstaller: async (nextPlan) => {
          plan = nextPlan;
        },
        verifyInstalled: async () => undefined,
      }
    );

    expect(plan?.args).toContain("@photon-ai/cli@4.0.0-beta.1");
    expect(result.status).toBe("reinstalled");
  });

  test("runs the detected package manager and preserves quiet output", async () => {
    let invocation: { plan: InstallerPlan; quiet: boolean } | undefined;
    const result = await updatePhoton(
      { quiet: true },
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "3.0.0",
        installation: { kind: "pnpm", entryPath: "/global/photon.js" },
        runInstaller: async (plan, quiet) => {
          invocation = { plan, quiet };
        },
        verifyInstalled: async () => undefined,
      }
    );

    expect(invocation).toEqual({
      plan: {
        command: "pnpm",
        args: ["add", "--global", "@photon-ai/cli@3.0.0"],
      },
      quiet: true,
    });
    expect(result.installer).toBe("pnpm");
    expect(result.status).toBe("updated");
  });

  test("allows an explicit installer when automatic detection is ambiguous", async () => {
    let command = "";
    let verified: [string, string] | undefined;
    await updatePhoton(
      { installer: "bun" },
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "3.0.0",
        installation: { kind: "unknown", entryPath: "/global/photon.js" },
        runInstaller: async (plan) => {
          command = plan.command;
        },
        verifyInstalled: async (entry, version) => {
          verified = [entry, version];
        },
      }
    );
    expect(command).toBe("bun");
    expect(verified).toEqual(["/global/photon.js", "3.0.0"]);
  });

  test("refuses to guess for development and one-off invocations", async () => {
    await expect(
      updatePhoton(
        {},
        {
          currentVersion: "2.0.0",
          latestVersion: async () => "3.0.0",
          installation: { kind: "development", entryPath: "/workspace/src/index.ts" },
        }
      )
    ).rejects.toThrow("A development checkout cannot update itself");
  });

  test("directs Yarn Berry users to update the owning project", async () => {
    await expect(
      updatePhoton(
        {},
        {
          currentVersion: "2.0.0",
          latestVersion: async () => "3.0.0",
          installation: {
            kind: "yarn-berry",
            entryPath: "/project/.yarn/cache/photon-cli.zip/dist/photon.js",
          },
        }
      )
    ).rejects.toThrow(
      "Run `yarn up @photon-ai/cli` from the project that owns this dependency"
    );
  });

  test("directs Yarn dlx users to rerun the latest package", async () => {
    await expect(
      updatePhoton(
        {},
        {
          currentVersion: "2.0.0",
          latestVersion: async () => "3.0.0",
          installation: {
            kind: "yarn-dlx",
            entryPath: "/tmp/xfs-123/dlx-456/.yarn/cache/photon-cli.zip",
          },
        }
      )
    ).rejects.toThrow(
      "Run `yarn dlx --package @photon-ai/cli@latest photon` instead"
    );
  });

  test("refuses to update a different detected package-manager installation", async () => {
    await expect(
      updatePhoton(
        { installer: "bun" },
        {
          currentVersion: "2.0.0",
          latestVersion: async () => "3.0.0",
          installation: { kind: "npm", entryPath: "/global/photon.js" },
        }
      )
    ).rejects.toThrow("detected as npm");
  });

  test("replaces a detected standalone binary", async () => {
    let replacement: [string, string] | undefined;
    const result = await updatePhoton(
      {},
      {
        currentVersion: "2.0.0",
        latestVersion: async () => "3.0.0",
        installation: { kind: "standalone", entryPath: "/usr/local/bin/photon" },
        replaceStandalone: async (target, version) => {
          replacement = [target, version];
        },
      }
    );

    expect(replacement).toEqual(["/usr/local/bin/photon", "3.0.0"]);
    expect(result.installer).toBe("standalone");
  });
});

describe("verifyInstalledVersion", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-version-test-"));
  const entry = path.join(tmpDir, "photon.js");

  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test("launches the installed entry with the current runtime", async () => {
    fs.writeFileSync(entry, 'console.log("3.0.0");\n');
    await verifyInstalledVersion(entry, "3.0.0");
    await expect(verifyInstalledVersion(entry, "4.0.0")).rejects.toThrow(
      "reports 3.0.0 instead of 4.0.0"
    );
  });
});

describe("replaceStandaloneBinary", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-self-update-"));
  const target = path.join(tmpDir, "photon");
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    server?.stop();
    server = null;
    fs.writeFileSync(target, "old-binary", { mode: 0o755 });
  });

  afterAll(() => {
    server?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("verifies the checksum before atomically replacing the executable", async () => {
    const nextBinary = "new-binary";
    const checksum = createHash("sha256").update(nextBinary).digest("hex");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        return new Response(
          new URL(req.url).pathname.endsWith(".sha256")
            ? `${checksum}  photon\n`
            : nextBinary
        );
      },
    });
    await replaceStandaloneBinary(target, "3.0.0", {
      releaseBase: `http://127.0.0.1:${server.port}`,
    });

    expect(fs.readFileSync(target, "utf8")).toBe(nextBinary);
    expect(fs.statSync(target).mode & 0o111).not.toBe(0);
  });

  test("leaves the current binary untouched when verification fails", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        return new Response(
          new URL(req.url).pathname.endsWith(".sha256")
            ? `${"0".repeat(64)}  photon\n`
            : "tampered"
        );
      },
    });
    await expect(
      replaceStandaloneBinary(target, "3.0.0", {
        releaseBase: `http://127.0.0.1:${server.port}`,
      })
    ).rejects.toThrow("failed checksum verification");
    expect(fs.readFileSync(target, "utf8")).toBe("old-binary");
  });
});
