import type { Command } from "@commander-js/extra-typings";
import { intro, isCancel, log, outro, text, confirm as clackConfirm } from "@clack/prompts";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { openInBrowser } from "~/lib/browser.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";
import type { Project } from "~/lib/types.ts";

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .alias("project")
    .description("manage your Photon Dashboard projects");

  registerListCommand(projects);
  registerShowCommand(projects);
  registerCreateCommand(projects);
  registerUpdateCommand(projects);
  registerDeleteCommand(projects);
  registerRegenerateSecretCommand(projects);
  registerOpenCommand(projects);
  registerCheckPhoneCommand(projects);
}

// ──────────────────────────── list ────────────────────────────

function registerListCommand(projects: Command): void {
  projects
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your projects")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error } = await api.api.projects.get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(env.name);
        die(`Failed to list projects: ${formatApiError(error)}`);
      }

      const list = (data ?? []) as Project[];
      if (opts.json) {
        printJson(list);
        return;
      }
      if (list.length === 0) {
        console.log(c.dim("No projects yet."));
        console.log(c.hint("Create one with `photon projects create`."));
        return;
      }

      const rows = list.map((p) => [
        truncate(p.id, 8),
        p.name,
        p.location,
        formatStatus(p.status),
        p.spectrum ? c.green("on") : c.dim("off"),
        new Date(p.updatedAt).toLocaleDateString(),
      ]);
      printTable(["id", "name", "location", "status", "spectrum", "updated"], rows);
    });
}

// ──────────────────────────── show ────────────────────────────

function registerShowCommand(projects: Command): void {
  projects
    .command("show [id]")
    .alias("get")
    .description("show details for one project (defaults to $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error, status } = await api.api.projects({ id: projectId }).get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (status === 404 || (!error && !data)) {
        die(`Project not found: ${projectId}`, {
          hint: "List your projects with `photon projects ls`.",
        });
      }
      if (error) {
        die(`Failed to fetch project: ${formatApiError(error)}`);
      }

      if (opts.json) {
        printJson(data);
        return;
      }

      const p = data as Project;
      console.log(c.bold(p.name) + c.dim(`  (${p.id})`));
      console.log();
      printKv([
        ["status", formatStatus(p.status)],
        ["location", p.location],
        ["spectrum", p.spectrum ? c.green("enabled") : c.dim("disabled")],
        ["spectrumProjectId", p.spectrumProjectId ?? c.dim("—")],
        ["template", p.template ? "yes" : "no"],
        ["observability", p.observability ? "yes" : "no"],
        ["subscription", p.subscriptionStatus ?? c.dim("—")],
        ["createdAt", new Date(p.createdAt).toLocaleString()],
        ["updatedAt", new Date(p.updatedAt).toLocaleString()],
      ]);
    });
}

// ──────────────────────────── create ────────────────────────────

interface CreateOpts {
  name?: string;
  location?: string;
  spectrum?: boolean;
  template?: boolean;
  observability?: boolean;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerCreateCommand(projects: Command): void {
  projects
    .command("create")
    .alias("new")
    .description("create a new project")
    .option("-n, --name <name>", "project name")
    .option("-l, --location <location>", 'location (default: "United States")')
    .option("--spectrum", "enable Spectrum")
    .option("--no-spectrum", "disable Spectrum")
    .option("--template", "use as template")
    .option("--observability", "enable observability")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: CreateOpts) => {
      const filled = await fillCreateOpts(opts);
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api.projects.post({
        name: filled.name,
        location: filled.location,
        spectrum: filled.spectrum,
        template: filled.template,
        observability: filled.observability,
      });
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) {
        die(`Failed to create project: ${formatApiError(error)}`);
      }
      const result = data as { success?: true; id?: string; error?: string };
      if (result.error) {
        die(result.error);
      }
      if (!result.id) {
        die("Server did not return a project id.");
      }

      if (opts.json) {
        printJson({ id: result.id, name: filled.name, env: env.name });
        return;
      }

      console.log(
        c.success(
          `Created ${c.bold(filled.name)} ${c.dim(`(${result.id})`)} on ${c.bold(env.name)}`
        )
      );
      console.log(
        c.dim(`  To make this the active project: export PHOTON_PROJECT_ID=${result.id}`)
      );
    });
}

interface FilledCreate {
  name: string;
  location: string;
  spectrum: boolean;
  template: boolean;
  observability: boolean;
}

async function fillCreateOpts(opts: CreateOpts): Promise<FilledCreate> {
  // Non-interactive path: name is required; defaults fill the rest.
  if (!isInteractive()) {
    if (!opts.name?.trim()) {
      die("--name is required in non-interactive mode.", {
        hint: "Run from a terminal for the interactive prompt, or pass --name <name>.",
      });
    }
    return {
      name: opts.name.trim(),
      location: opts.location ?? "United States",
      spectrum: opts.spectrum ?? false,
      template: opts.template ?? false,
      observability: opts.observability ?? false,
    };
  }

  intro(c.cyan("Create a new project"));

  let name = opts.name?.trim();
  if (!name) {
    const answer = await text({
      message: "Project name",
      validate: (value) =>
        value && value.trim() ? undefined : "Project name is required",
    });
    if (isCancel(answer)) {
      die("Aborted.");
    }
    name = answer.trim();
  }

  let location = opts.location;
  if (location === undefined) {
    const answer = await text({
      message: "Location",
      placeholder: "United States",
      defaultValue: "United States",
    });
    if (isCancel(answer)) {
      die("Aborted.");
    }
    location = answer || "United States";
  }

  const spectrum = opts.spectrum ?? (await promptBool("Enable Spectrum?", false));
  const template = opts.template ?? (await promptBool("Use as template?", false));
  const observability =
    opts.observability ?? (await promptBool("Enable observability?", false));

  outro(c.dim("Submitting…"));
  return { name, location, spectrum, template, observability };
}

async function promptBool(message: string, initial: boolean): Promise<boolean> {
  const answer = await clackConfirm({ message, initialValue: initial });
  if (isCancel(answer)) die("Aborted.");
  return Boolean(answer);
}

// ──────────────────────────── update ────────────────────────────

interface UpdateOpts {
  name?: string;
  spectrum?: boolean;
  template?: boolean;
  observability?: boolean;
  project?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerUpdateCommand(projects: Command): void {
  projects
    .command("update [id]")
    .alias("edit")
    .alias("set")
    .description("update an existing project (defaults to $PHOTON_PROJECT_ID)")
    .option("-n, --name <name>", "new name")
    .option("--spectrum", "enable Spectrum")
    .option("--no-spectrum", "disable Spectrum")
    .option("--template", "use as template")
    .option("--no-template", "stop using as template")
    .option("--observability", "enable observability")
    .option("--no-observability", "disable observability")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (idArg: string | undefined, opts: UpdateOpts) => {
      // At least one mutation flag is required so we don't accidentally
      // PATCH with the same values (server treats unspecified booleans as
      // false, so blindly re-sending current state could RESET them).
      // An empty/whitespace-only --name is also "no mutation" — without
      // this check, the rename would silently fall back to current.name
      // and the user would get a "✓ Updated" with nothing changed.
      const trimmedName = opts.name?.trim();
      if (opts.name !== undefined && !trimmedName) {
        die("--name must not be empty.", {
          hint: "Either pass a non-empty name or omit --name to keep the current one.",
        });
      }
      const hasMutation =
        trimmedName !== undefined ||
        opts.spectrum !== undefined ||
        opts.template !== undefined ||
        opts.observability !== undefined;
      if (!hasMutation) {
        die("Nothing to update.", {
          hint: "Pass at least one of --name / --spectrum / --template / --observability.",
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      // Server's PATCH requires the full payload (name + boolean flags).
      // Fetch current state and overlay the user's mutations so we don't
      // reset spectrum/template/observability to false silently.
      const fetched = await api.api.projects({ id: projectId }).get();
      if (fetched.status === 401) throw new SessionExpiredError(resolved.name);
      if (fetched.status === 404 || (!fetched.error && !fetched.data)) {
        die(`Project not found: ${projectId}`, {
          hint: "List your projects with `photon projects ls`.",
        });
      }
      if (fetched.error || !fetched.data) {
        die(`Failed to load current project: ${formatApiError(fetched.error)}`);
      }
      const current = fetched.data as Project;

      const body = {
        name: trimmedName ?? current.name,
        spectrum: opts.spectrum ?? current.spectrum,
        template: opts.template ?? current.template,
        observability: opts.observability ?? current.observability,
      };

      const { error, status, data } = await api.api
        .projects({ id: projectId })
        .patch(body);
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to update project: ${formatApiError(error)}`);
      const result = data as { success?: true; error?: string };
      if (result.error) die(result.error);

      if (opts.json) {
        printJson({ id: projectId, ...body });
        return;
      }
      console.log(c.success(`Updated ${c.bold(body.name)} ${c.dim(`(${projectId})`)}`));
    });
}

// ──────────────────────────── delete ────────────────────────────

function registerDeleteCommand(projects: Command): void {
  projects
    .command("delete [id]")
    .alias("rm")
    .alias("remove")
    .description("permanently delete a project (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      // Look up the project name so we can show it in the prompt.
      // Distinguish "not found" (404 / null body) from genuine errors
      // (500, network) — otherwise users get a misleading "deleted?"
      // message when the GET actually failed for a different reason.
      const fetched = await api.api.projects({ id: projectId }).get();
      if (fetched.status === 401) throw new SessionExpiredError(resolved.name);
      if (fetched.status === 404 || (!fetched.error && !fetched.data)) {
        die(`Project not found: ${projectId}`, {
          hint: "Already deleted? `photon projects ls` to confirm.",
        });
      }
      if (fetched.error) {
        die(`Failed to look up project: ${formatApiError(fetched.error)}`);
      }
      const project = fetched.data as Project;

      await confirmDestructive({
        message: `Delete project ${c.bold(project.name)} (${projectId})? This cannot be undone.`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to delete ${project.name}.`,
      });

      const { error, status } = await api.api.projects({ id: projectId }).delete();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to delete project: ${formatApiError(error)}`);

      console.log(c.success(`Deleted ${c.bold(project.name)} ${c.dim(`(${projectId})`)}`));

      // If the active project env var points at the project we just deleted,
      // surface a hint. We can't unset it from a subprocess, so the user has
      // to do it themselves.
      if (process.env.PHOTON_PROJECT_ID === projectId) {
        console.error(
          c.warn(`Active project just deleted. Run \`unset PHOTON_PROJECT_ID\` to clear.`)
        );
      }
    });
}

// ──────────────────────────── regenerate-secret ────────────────────────────

function registerRegenerateSecretCommand(projects: Command): void {
  projects
    .command("regenerate-secret [id]")
    .alias("rotate-secret")
    .description("rotate the project's Spectrum API secret (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .option("--json", "output JSON")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      await confirmDestructive({
        message: `Rotate the API secret for project ${projectId}? Existing integrations using the old secret will stop working immediately.`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to rotate the secret.`,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        ["regenerate-secret"].post();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to rotate secret: ${formatApiError(error)}`);
      const result = data as { success?: true; projectSecret?: string; error?: string };
      if (result.error) die(result.error);
      if (!result.projectSecret) die("Server did not return a new secret.");

      if (opts.json) {
        printJson({ id: projectId, projectSecret: result.projectSecret });
        return;
      }

      console.log(c.success(`New secret for ${projectId}:`));
      console.log(`  ${c.bold(result.projectSecret)}`);
      log.warn(
        "This is shown once. Store it somewhere safe — re-rotating is the only way to recover."
      );
    });
}

// ──────────────────────────── open ────────────────────────────

function registerOpenCommand(projects: Command): void {
  projects
    .command("open [id]")
    .description("open the project in the dashboard web UI (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      // Use new URL() rather than concatenation so a custom env URL
      // with a trailing slash doesn't produce `https://x//dashboard/...`.
      const url = new URL(`/dashboard/${projectId}`, resolved.url).toString();
      await openInBrowser(url, { noBrowser: !opts.browser, label: "URL" });
    });
}

// ──────────────────────────── check-phone ────────────────────────────

function registerCheckPhoneCommand(projects: Command): void {
  projects
    .command("check-phone <number>")
    .description("check whether a phone number is available on Spectrum")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (number, opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error, status } = await api.api.projects[
        "check-availability"
      ].get({
        query: { phoneNumber: number },
      });
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) die(`Failed to check phone availability: ${formatApiError(error)}`);

      if (opts.json) {
        printJson(data);
        return;
      }
      const result = data as { available?: boolean };
      if (result.available) {
        console.log(c.success(`${number} is available.`));
      } else {
        console.log(c.warn(`${number} is taken.`));
      }
    });
}

// ──────────────────────────── helpers ────────────────────────────

function formatStatus(s: string): string {
  switch (s) {
    case "running":
      return c.green(s);
    case "paused":
      return c.yellow(s);
    case "error":
      return c.red(s);
    default:
      return s;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printKv(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    console.log(`  ${c.dim(k.padEnd(width))}  ${v}`);
  }
}
