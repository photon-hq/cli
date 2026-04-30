import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { PRODUCTION_URL } from "~/lib/env.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError } from "~/lib/output.ts";

export function registerSpectrumAvatar(spectrum: Command): void {
  const avatar = spectrum.command("avatar").description("manage the Spectrum avatar image");

  avatar
    .command("upload <file>")
    .description("upload an image as the Spectrum avatar")
    .option("--no-update-profile", "only upload, don't update the profile to use the new avatar")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .action(async (file, opts) => {
      const local = Bun.file(file);
      if (!(await local.exists())) {
        die(`File not found: ${file}`);
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

      // 1) Ask the server for a presigned URL.
      const urlResp = await api.api
        .projects({ id: projectId })
        .spectrum["avatar-upload-url"].get();
      if (urlResp.status === 401) throw new SessionExpiredError(resolved.name);
      if (urlResp.error)
        die(`Failed to get upload URL: ${formatApiError(urlResp.error)}`);
      const result = urlResp.data as {
        success?: true;
        uploadUrl?: string;
        avatarUrl?: string;
        error?: string;
      };
      if (result.error) die(result.error);
      if (!result.uploadUrl || !result.avatarUrl) {
        die("Server did not return upload + avatar URLs.");
      }

      // 2) PUT the file body to the presigned URL. Spectrum returns a
      // simple PUT-style URL (per services/spectrum.ts), not multipart.
      console.log(c.dim(`Uploading ${file} (${(local.size / 1024).toFixed(1)} KB)…`));
      const putResp = await fetch(result.uploadUrl, {
        method: "PUT",
        body: local,
        headers: {
          "Content-Type": local.type || "application/octet-stream",
        },
      });
      if (!putResp.ok) {
        die(`Upload failed: ${putResp.status} ${putResp.statusText}`);
      }

      // 3) Optionally update the Spectrum profile to point at the new URL.
      if (opts.updateProfile !== false) {
        const patch = await api.api
          .projects({ id: projectId })
          .spectrum.profile.patch({ avatarUrl: result.avatarUrl });
        if (patch.status === 401) throw new SessionExpiredError(resolved.name);
        if (patch.error) {
          // Upload succeeded; surface the patch failure but don't undo.
          // Build the recovery command with the same --project /
          // --api-host / --token context the user originally passed, and
          // quote the URL so shell-significant chars don't break copy-paste.
          const recovery = buildRecoveryCommand({
            projectId,
            apiHost: resolved.url,
            token: opts.token,
            avatarUrl: result.avatarUrl,
          });
          die(`Uploaded, but failed to update profile: ${formatApiError(patch.error)}`, {
            hint: `Update manually: ${recovery}`,
            context: `Avatar URL: ${result.avatarUrl}`,
          });
        }
      }

      console.log(c.success(`Uploaded avatar from ${file}`));
      console.log(c.dim(`  URL: ${result.avatarUrl}`));
    });
}

function buildRecoveryCommand(opts: {
  projectId: string;
  apiHost: string;
  token?: string;
  avatarUrl: string;
}): string {
  const parts: string[] = ["photon spectrum profile update"];
  parts.push(`--project ${shellQuote(opts.projectId)}`);
  // Only include --api-host if it differs from the default production URL,
  // so the recovery command stays minimal in the common case.
  if (opts.apiHost !== PRODUCTION_URL) {
    parts.push(`--api-host ${shellQuote(opts.apiHost)}`);
  }
  if (opts.token !== undefined) {
    parts.push(`--token ${shellQuote(opts.token)}`);
  }
  parts.push(`--avatar-url ${shellQuote(opts.avatarUrl)}`);
  return parts.join(" ");
}

/**
 * Single-quote a value for safe shell copy-paste. Escapes embedded
 * single quotes via the standard `'\''` trick. Avoids shell injection
 * vectors in URLs that contain `&`, `?`, `;`, `|`, etc.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
