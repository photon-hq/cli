import type { Command } from "@commander-js/extra-typings";
import { InvalidArgumentError } from "commander";
import { getApi, type ApiContext } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";

export const DEFAULT_PROFILE_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_PROFILE_SYNC_POLL_INTERVAL_MS = 1000;
const PROFILE_SYNC_POLL_INTERVAL_ENV =
  "PHOTON_PROFILE_SYNC_POLL_INTERVAL_MS";

export function registerSpectrumProfile(spectrum: Command): void {
  const profile = spectrum
    .command("profile")
    .description("view or update the Spectrum profile (display name, avatar)");

  profile
    .command("show", { isDefault: true })
    .description("show the Spectrum profile")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .spectrum.profile.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to fetch Spectrum profile: ${formatApiError(error)}`);

      if (opts.json) return printJson(data ?? {});
      if (!data || typeof data !== "object") {
        console.log(c.dim("No Spectrum profile."));
        return;
      }
      const entries = Object.entries(
        data as unknown as Record<string, unknown>
      ).filter(([k]) => !["id", "projectId"].includes(k));
      if (entries.length === 0) {
        console.log(c.dim("Empty Spectrum profile."));
        return;
      }
      const width = Math.max(...entries.map(([k]) => k.length));
      for (const [k, v] of entries) {
        console.log(`  ${c.dim(k.padEnd(width))}  ${formatValue(v)}`);
      }
    });

  profile
    .command("update")
    .alias("edit")
    .description("update the Spectrum profile (preserves unset fields)")
    .option("--first-name <name>")
    .option("--last-name <name>")
    .option("--avatar-url <url>", "avatar image URL (use `spectrum avatar upload` instead)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const hasMutation =
        opts.firstName !== undefined ||
        opts.lastName !== undefined ||
        opts.avatarUrl !== undefined;
      if (!hasMutation) {
        die("Nothing to update.", {
          hint: "Pass at least one of --first-name / --last-name / --avatar-url.",
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const body: Record<string, string> = {};
      if (opts.firstName !== undefined) body.firstName = opts.firstName;
      if (opts.lastName !== undefined) body.lastName = opts.lastName;
      if (opts.avatarUrl !== undefined) body.avatarUrl = opts.avatarUrl;

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .spectrum.profile.patch(body);
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to update Spectrum profile: ${formatApiError(error)}`);
      const result = data as { success?: true; profile?: unknown; error?: string };
      if (result.error) die(result.error);

      if (opts.json) return printJson(result.profile ?? {});
      console.log(c.success("Spectrum profile updated."));
    });

  profile
    .command("sync")
    .description("sync the project profile to every dedicated iMessage line")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-wait", "return after the sync is accepted")
    .option(
      "--timeout <duration>",
      "client-side polling timeout (default: 10m)",
      parseProfileSyncTimeout,
      DEFAULT_PROFILE_SYNC_TIMEOUT_MS
    )
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const initial = await triggerProfileSync(
        api,
        projectId,
        resolved.name
      );

      if (opts.wait === false) {
        if (!opts.json) console.log(c.success("Spectrum profile sync queued."));
        printProfileSyncAggregate(initial, opts.json ?? false);
        return;
      }

      if (!opts.json && initial.status === "in_progress") {
        console.log(c.info("Spectrum profile sync queued; waiting for completion."));
      }

      const result = await pollProfileSync({
        api,
        projectId,
        envName: resolved.name,
        initial,
        timeoutMs: opts.timeout,
        json: opts.json ?? false,
      });
      finishProfileSync(result, opts.json ?? false);
    });

  profile
    .command("sync-status")
    .description("show the current project profile sync status")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const result = await getProfileSyncStatus(
        api,
        projectId,
        resolved.name
      );
      finishProfileSync(result, opts.json ?? false);
    });
}

async function triggerProfileSync(
  api: ApiContext["api"],
  projectId: string,
  envName: string
) {
  const { data, error, status } = await api.api
    .projects({ id: projectId })
    .spectrum.profile.sync.post();

  if (status === 401) throw new SessionExpiredError(envName);
  if (error) {
    die(`Failed to trigger Spectrum profile sync: ${formatApiError(error)}`);
  }
  if (!data?.succeed) {
    die("Failed to trigger Spectrum profile sync: empty API response.");
  }
  return data.data;
}

async function getProfileSyncStatus(
  api: ApiContext["api"],
  projectId: string,
  envName: string
) {
  const { data, error, status } = await api.api
    .projects({ id: projectId })
    .spectrum.profile.sync.get();

  if (status === 401) throw new SessionExpiredError(envName);
  if (error) {
    die(`Failed to fetch Spectrum profile sync status: ${formatApiError(error)}`);
  }
  if (!data?.succeed) {
    die("Failed to fetch Spectrum profile sync status: empty API response.");
  }
  return data.data;
}

type ProfileSyncAggregate = Awaited<
  ReturnType<typeof getProfileSyncStatus>
>;

interface PollProfileSyncOptions {
  api: ApiContext["api"];
  projectId: string;
  envName: string;
  initial: ProfileSyncAggregate;
  timeoutMs: number;
  json: boolean;
}

async function pollProfileSync(
  opts: PollProfileSyncOptions
): Promise<ProfileSyncAggregate> {
  let latest = opts.initial;
  if (isTerminalProfileSyncStatus(latest.status)) return latest;

  const deadline = Date.now() + opts.timeoutMs;
  const pollIntervalMs = resolveProfileSyncPollInterval();

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      exitProfileSyncTimeout(latest, opts);
    }

    const next = await settleBeforeDeadline(
      getProfileSyncStatus(opts.api, opts.projectId, opts.envName),
      remainingMs
    );
    if (next === PROFILE_SYNC_TIMED_OUT) {
      exitProfileSyncTimeout(latest, opts);
    }

    latest = next;
    if (isTerminalProfileSyncStatus(latest.status)) return latest;

    const delayMs = Math.min(pollIntervalMs, deadline - Date.now());
    if (delayMs <= 0) {
      exitProfileSyncTimeout(latest, opts);
    }
    await delay(delayMs);
  }
}

function finishProfileSync(
  result: ProfileSyncAggregate,
  json: boolean
): void {
  printProfileSyncAggregate(result, json);

  if (result.status === "partial_failed") {
    die("Spectrum profile sync completed with failed lines.", {
      hint: "Run `photon spectrum profile sync-status` to inspect the current aggregate.",
    });
  }
  if (result.status === "failed") {
    die("Spectrum profile sync failed.", {
      hint: "Run `photon spectrum profile sync-status` to inspect the current aggregate.",
    });
  }
}

function printProfileSyncAggregate(
  result: ProfileSyncAggregate,
  json: boolean
): void {
  if (json) {
    printJson(result);
    return;
  }

  console.log(c.bold("Spectrum profile sync"));
  console.log(`  ${c.dim("status".padEnd(8))}  ${formatSyncStatus(result.status)}`);
  console.log(`  ${c.dim("pending".padEnd(8))}  ${result.pending}`);
  console.log(`  ${c.dim("synced".padEnd(8))}  ${result.synced}`);
  console.log(`  ${c.dim("failed".padEnd(8))}  ${result.failed}`);
  console.log(`  ${c.dim("total".padEnd(8))}  ${result.total}`);
  if (result.errors.length > 0) {
    console.log(`  ${c.dim("errors".padEnd(8))}`);
    for (const error of result.errors) {
      console.log(`    ${error.lineId}: ${error.reason}`);
    }
  }
}

function formatSyncStatus(status: ProfileSyncAggregate["status"]): string {
  switch (status) {
    case "completed":
      return c.green(status);
    case "partial_failed":
    case "failed":
      return c.red(status);
    case "in_progress":
      return c.cyan(status);
  }
  return status;
}

function isTerminalProfileSyncStatus(
  status: ProfileSyncAggregate["status"]
): boolean {
  return status !== "in_progress";
}

function parseProfileSyncTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw invalidTimeout(value);

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "s";
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * multiplier;

  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 1 ||
    !Number.isSafeInteger(milliseconds)
  ) {
    throw invalidTimeout(value);
  }
  return milliseconds;
}

function invalidTimeout(value: string): InvalidArgumentError {
  return new InvalidArgumentError(
    `must be a positive duration such as 500ms, 30s, 10m, or 1h (got "${value}")`
  );
}

function resolveProfileSyncPollInterval(): number {
  const raw = process.env[PROFILE_SYNC_POLL_INTERVAL_ENV];
  if (!raw) return DEFAULT_PROFILE_SYNC_POLL_INTERVAL_MS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_PROFILE_SYNC_POLL_INTERVAL_MS;
}

const PROFILE_SYNC_TIMED_OUT = Symbol("profile-sync-timed-out");

function settleBeforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T | typeof PROFILE_SYNC_TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(PROFILE_SYNC_TIMED_OUT), timeoutMs);
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function exitProfileSyncTimeout(
  latest: ProfileSyncAggregate,
  opts: Pick<PollProfileSyncOptions, "json" | "timeoutMs">
): never {
  printProfileSyncAggregate(latest, opts.json);
  die(`Spectrum profile sync polling timed out after ${formatDuration(opts.timeoutMs)}.`, {
    hint: "The server-side sync continues. Run `photon spectrum profile sync-status` to check it.",
  });
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000}s`;
  return `${milliseconds}ms`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
