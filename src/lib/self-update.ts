import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semverGt from "semver/functions/gt.js";
import semverValid from "semver/functions/valid.js";
import updateNotifier from "update-notifier";
import pkg from "../../package.json" with { type: "json" };

export const PACKAGE_INSTALLERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageInstaller = (typeof PACKAGE_INSTALLERS)[number];
export type InstallationKind =
  | PackageInstaller
  | "standalone"
  | "ephemeral"
  | "yarn-berry"
  | "yarn-dlx"
  | "development"
  | "unknown";

export interface Installation {
  kind: InstallationKind;
  entryPath: string;
}

export interface InstallerPlan {
  command: PackageInstaller;
  args: string[];
}

export interface UpdateOptions {
  check?: boolean;
  force?: boolean;
  installer?: PackageInstaller;
  quiet?: boolean;
}

export interface UpdateResult {
  status: "up-to-date" | "update-available" | "updated" | "reinstalled";
  currentVersion: string;
  latestVersion: string;
  installer: PackageInstaller | "standalone" | null;
}

interface UpdateDependencies {
  currentVersion?: string;
  installation?: Installation;
  latestVersion?: () => Promise<string>;
  runInstaller?: (plan: InstallerPlan, quiet: boolean) => Promise<void>;
  replaceStandalone?: (target: string, version: string) => Promise<void>;
  verifyInstalled?: (entryPath: string, expectedVersion: string) => Promise<void>;
}

async function fetchLatestVersion(): Promise<string> {
  const previousOptOut = process.env.NO_UPDATE_NOTIFIER;
  process.env.NO_UPDATE_NOTIFIER = "1";
  let latest: string;
  try {
    const notifier = updateNotifier({
      pkg: { name: pkg.name, version: pkg.version },
    });
    ({ latest } = await notifier.fetchInfo());
  } catch (error) {
    throw new Error("Could not reach the Photon update registry.", {
      cause: error,
    });
  } finally {
    if (previousOptOut === undefined) {
      delete process.env.NO_UPDATE_NOTIFIER;
    } else {
      process.env.NO_UPDATE_NOTIFIER = previousOptOut;
    }
  }
  if (!semverValid(latest)) {
    throw new Error("The Photon update registry returned an invalid version.");
  }
  return latest;
}

function canonicalPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/** Infer how the currently running entry point was installed. */
export function detectInstallation(
  entryPath = process.argv[1] ?? "",
  executablePath = process.execPath,
  environment: NodeJS.ProcessEnv = process.env
): Installation {
  if (!entryPath) return { kind: "unknown", entryPath };

  const invocationEntry = path.resolve(entryPath);
  const entry = canonicalPath(entryPath);
  const executable = canonicalPath(executablePath);
  const normalizedArgument = entryPath.replaceAll("\\", "/");
  if (entry === executable || normalizedArgument.startsWith("/$bunfs/root/")) {
    return { kind: "standalone", entryPath: path.resolve(executablePath) };
  }

  const normalized = entry.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/.bun/install/cache/@photon-ai/cli@") ||
    normalized.includes("/node_modules/.cache/bunx-") ||
    (normalized.includes("/tmp/dlx-") && normalized.includes("/node_modules/"))
  ) {
    return { kind: "ephemeral", entryPath: invocationEntry };
  }
  if (normalized.includes("/.bun/install/global/")) {
    return { kind: "bun", entryPath: invocationEntry };
  }
  if (normalized.includes("/pnpm/global/") || normalized.includes("/.pnpm/global/")) {
    return { kind: "pnpm", entryPath: invocationEntry };
  }
  if (
    normalized.includes("/.config/yarn/global/") ||
    normalized.includes("/yarn/global/")
  ) {
    return { kind: "yarn", entryPath: invocationEntry };
  }
  if (
    normalized.includes("/lib/node_modules/@photon-ai/cli/") ||
    normalized.includes("/npm/node_modules/@photon-ai/cli/")
  ) {
    return { kind: "npm", entryPath: invocationEntry };
  }
  const yarnVersion = /^yarn\/(\d+)(?:\.|\s|$)/i.exec(
    environment.npm_config_user_agent ?? ""
  )?.[1];
  if (yarnVersion && Number(yarnVersion) >= 2) {
    const normalizedInitCwd = (environment.INIT_CWD ?? "").replaceAll(
      "\\",
      "/"
    );
    const dlxDirectory = /\/dlx-[^/]+(?:\/|$)/i;
    if (
      dlxDirectory.test(normalizedArgument) &&
      (normalizedArgument.includes("/.yarn/") ||
        dlxDirectory.test(normalizedInitCwd))
    ) {
      return { kind: "yarn-dlx", entryPath: invocationEntry };
    }
    return { kind: "yarn-berry", entryPath: invocationEntry };
  }
  if (!normalized.includes("/node_modules/@photon-ai/cli/")) {
    return { kind: "development", entryPath: invocationEntry };
  }
  return { kind: "unknown", entryPath: invocationEntry };
}

export function parsePackageInstaller(value: string): PackageInstaller {
  if ((PACKAGE_INSTALLERS as readonly string[]).includes(value)) {
    return value as PackageInstaller;
  }
  throw new Error(
    `Unknown installer "${value}". Expected one of: ${PACKAGE_INSTALLERS.join(", ")}.`
  );
}

export function installerPlan(
  installer: PackageInstaller,
  version: string,
  force = false
): InstallerPlan {
  const versionedPackage = `${pkg.name}@${version}`;
  const forceArgs = force ? ["--force"] : [];
  if (installer === "npm") {
    return {
      command: installer,
      args: ["install", "--global", ...forceArgs, versionedPackage],
    };
  }
  if (installer === "yarn") {
    return {
      command: installer,
      args: ["global", "add", ...forceArgs, versionedPackage],
    };
  }
  return {
    command: installer,
    args: ["add", "--global", ...forceArgs, versionedPackage],
  };
}

async function runInstallerProcess(
  plan: InstallerPlan,
  quiet: boolean
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      shell: false,
      stdio: quiet ? ["ignore", "ignore", "pipe"] : "inherit",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    child.on("error", (error) => {
      reject(
        new Error(
          `Could not start ${plan.command}. Make sure it is installed and on PATH.`,
          { cause: error }
        )
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(
        new Error(
          `The ${plan.command} updater failed with ${reason}.${detail ? ` ${detail}` : ""}`
        )
      );
    });
  });
}

export async function verifyInstalledVersion(
  entryPath: string,
  expectedVersion: string
): Promise<void> {
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, "--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PHOTON_NO_UPDATE_NOTIFIER: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-8192);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    child.on("error", (error) => {
      reject(new Error("Could not launch the updated Photon executable.", { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(
        new Error(
          `The updated Photon executable failed with ${reason}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`
        )
      );
    });
  });
  if (version !== expectedVersion) {
    throw new Error(
      `The installer completed, but ${entryPath} reports ${version || "no version"} instead of ${expectedVersion}.`
    );
  }
}

function standaloneAsset(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Standalone updates are not supported on ${process.platform}.`);
  }
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`Standalone updates are not supported on ${process.arch}.`);
  }
  return `photon-${platform}-${process.arch}`;
}

interface StandaloneUpdateDependencies {
  releaseBase?: string;
}

/** Download, checksum, and atomically replace a standalone Photon binary. */
export async function replaceStandaloneBinary(
  target: string,
  version: string,
  dependencies: StandaloneUpdateDependencies = {}
): Promise<void> {
  const asset = standaloneAsset();
  const releaseBase =
    dependencies.releaseBase ??
    "https://github.com/photon-hq/cli/releases/download";
  const url = `${releaseBase.replace(/\/$/, "")}/v${version}/${asset}`;
  const init = { signal: AbortSignal.timeout(60_000) };
  let binaryResponse: Response;
  let checksumResponse: Response;
  try {
    [binaryResponse, checksumResponse] = await Promise.all([
      fetch(url, init),
      fetch(`${url}.sha256`, init),
    ]);
  } catch (error) {
    throw new Error("Could not reach the Photon release downloads.", {
      cause: error,
    });
  }
  if (!binaryResponse.ok || !checksumResponse.ok) {
    throw new Error(
      `Could not download Photon ${version} (${binaryResponse.status}/${checksumResponse.status}).`
    );
  }

  let checksumText: string;
  try {
    checksumText = await checksumResponse.text();
  } catch (error) {
    throw new Error("Could not read the Photon release checksum.", {
      cause: error,
    });
  }
  const expected = checksumText.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("The standalone checksum file is invalid.");
  }
  const resolvedTarget = canonicalPath(target);
  const temporary = `${resolvedTarget}.update-${process.pid}-${Date.now()}`;
  let handle: number | undefined;
  try {
    if (!binaryResponse.body) {
      throw new Error("The standalone download returned an empty body.");
    }

    let actual: string;
    try {
      const mode = fs.statSync(resolvedTarget).mode & 0o777;
      handle = fs.openSync(temporary, "wx", mode || 0o755);
      const hash = createHash("sha256");
      const reader = binaryResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const written = fs.writeSync(
            handle,
            value,
            offset,
            value.byteLength - offset
          );
          if (written === 0) throw new Error("Writing the update made no progress.");
          offset += written;
        }
      }
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      actual = hash.digest("hex");
    } catch (error) {
      throw new Error(
        `Could not stage the Photon update beside ${resolvedTarget}. Check the download and file permissions.`,
        { cause: error }
      );
    }

    if (actual !== expected) {
      throw new Error("The downloaded Photon binary failed checksum verification.");
    }
    try {
      fs.renameSync(temporary, resolvedTarget);
    } catch (error) {
      throw new Error(
        `Could not replace ${resolvedTarget}. Check that the file is writable.`,
        { cause: error }
      );
    }
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Best-effort cleanup; preserve the original update error.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; preserve the original update error.
    }
  }
}

export function isUpdateCommandInvocation(argv: string[]): boolean {
  const command = argv.slice(2).find((arg) => !arg.startsWith("-"));
  return command === "update";
}

function automaticInstaller(installation: Installation): PackageInstaller | "standalone" {
  if (
    installation.kind === "npm" ||
    installation.kind === "pnpm" ||
    installation.kind === "yarn" ||
    installation.kind === "bun" ||
    installation.kind === "standalone"
  ) {
    return installation.kind;
  }
  if (installation.kind === "ephemeral") {
    throw new Error(
      `A one-off Photon invocation cannot update itself. ` +
        `Run your package runner with ${pkg.name}@latest instead.`
    );
  }
  if (installation.kind === "development") {
    throw new Error(
      "A development checkout cannot update itself. Update the checkout with Git instead."
    );
  }
  if (installation.kind === "yarn-dlx") {
    throw new Error(
      `A Yarn dlx invocation cannot update itself. ` +
        `Run \`yarn dlx --package ${pkg.name}@latest photon\` instead.`
    );
  }
  if (installation.kind === "yarn-berry") {
    throw new Error(
      `Yarn 2+ does not provide global installs. ` +
        `Run \`yarn up ${pkg.name}\` from the project that owns this dependency.`
    );
  }
  throw new Error(
    `Cannot detect this Photon installation automatically. ` +
      `Re-run with --installer ${PACKAGE_INSTALLERS.join("|")}.`
  );
}

function resolveInstaller(
  installation: Installation,
  override?: PackageInstaller
): PackageInstaller | "standalone" {
  if (!override) return automaticInstaller(installation);
  if (installation.kind === "unknown") return override;
  if (installation.kind === override) return override;
  if (
    installation.kind === "development" ||
    installation.kind === "ephemeral"
  ) {
    return automaticInstaller(installation);
  }
  throw new Error(
    `This Photon invocation was detected as ${installation.kind}; ` +
      `refusing to update a different ${override} installation.`
  );
}

export async function updatePhoton(
  options: UpdateOptions = {},
  dependencies: UpdateDependencies = {}
): Promise<UpdateResult> {
  const currentVersion = dependencies.currentVersion ?? pkg.version;
  const latestVersion = await (dependencies.latestVersion ?? fetchLatestVersion)();
  if (!semverValid(currentVersion) || !semverValid(latestVersion)) {
    throw new Error("Cannot compare invalid Photon release versions.");
  }
  const available = semverGt(latestVersion, currentVersion);
  if (!available && !options.force) {
    return {
      status: "up-to-date",
      currentVersion,
      latestVersion,
      installer: null,
    };
  }
  if (options.check) {
    return {
      status: available ? "update-available" : "up-to-date",
      currentVersion,
      latestVersion,
      installer: null,
    };
  }

  const installation = dependencies.installation ?? detectInstallation();
  const installer = resolveInstaller(installation, options.installer);
  const targetVersion = available ? latestVersion : currentVersion;
  if (installer === "standalone") {
    await (dependencies.replaceStandalone ?? replaceStandaloneBinary)(
      installation.entryPath,
      targetVersion
    );
  } else {
    await (dependencies.runInstaller ?? runInstallerProcess)(
      installerPlan(installer, targetVersion, options.force),
      options.quiet ?? false
    );
    await (dependencies.verifyInstalled ?? verifyInstalledVersion)(
      installation.entryPath,
      targetVersion
    );
  }
  return {
    status: available ? "updated" : "reinstalled",
    currentVersion,
    latestVersion,
    installer,
  };
}
