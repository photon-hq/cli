import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";
import { putPresignedUpload, readLocalUploadFile } from "~/lib/presigned-upload.ts";

export function registerSpectrumLineProfile(lines: Command): void {
  const profile = lines
    .command("profile")
    .description("manage a dedicated iMessage line profile");

  profile
    .command("update <line-id>")
    .alias("edit")
    .description("update a line profile name (preserves unset fields)")
    .option("--first-name <name>")
    .option("--last-name <name>")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option(
      "--api-host <url>",
      "API host URL (defaults to PHOTON_API_HOST or built-in production)"
    )
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (lineId, opts) => {
      const body =
        opts.firstName !== undefined
          ? {
              firstName: opts.firstName,
              ...(opts.lastName !== undefined
                ? { lastName: opts.lastName }
                : {}),
            }
          : opts.lastName !== undefined
            ? { lastName: opts.lastName }
            : die("Nothing to update.", {
                hint: "Pass --first-name and/or --last-name.",
              });

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
        .lines({ lineId })
        .profile.patch(body);
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) {
        die(`Failed to update line profile: ${formatApiError(error)}`);
      }
      if (!data?.succeed) {
        die("Failed to update line profile: empty API response.");
      }

      if (opts.json) return printJson(data.data);
      console.log(c.success(`Updated profile for line ${lineId}.`));
    });

  const avatar = lines
    .command("avatar")
    .description("manage a dedicated iMessage line avatar");

  avatar
    .command("upload <line-id> <file>")
    .description("upload an image as a line avatar")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option(
      "--api-host <url>",
      "API host URL (defaults to PHOTON_API_HOST or built-in production)"
    )
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .action(async (lineId, file, opts) => {
      const uploadFile = await readLocalUploadFile(file);
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const upload = await api.api
        .projects({ id: projectId })
        .lines({ lineId })
        .profile.avatar.upload.post({ contentType: uploadFile.contentType });
      if (upload.status === 401) {
        throw new SessionExpiredError(resolved.name);
      }
      if (upload.error) {
        die(
          `Failed to get line avatar upload URL: ${formatApiError(upload.error)}`
        );
      }
      if (!upload.data?.succeed) {
        die("Failed to get line avatar upload URL: empty API response.");
      }

      // This PUT targets the presigned object URL; API calls stay on Eden.
      await putPresignedUpload(file, upload.data.data.uploadUrl, uploadFile);

      const commit = await api.api
        .projects({ id: projectId })
        .lines({ lineId })
        .profile.avatar.commit.post({ key: upload.data.data.key });
      if (commit.status === 401) {
        throw new SessionExpiredError(resolved.name);
      }
      if (commit.error) {
        die(`Uploaded, but commit failed: ${formatApiError(commit.error)}`);
      }
      if (!commit.data?.succeed) {
        die("Uploaded, but commit failed: empty API response.");
      }

      console.log(c.success(`Uploaded avatar for line ${lineId}.`));
      console.log(c.dim(`  URL: ${commit.data.data.avatarUrl}`));
    });
}
