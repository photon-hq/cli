import type { Command } from "@commander-js/extra-typings";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { PRODUCTION_URL } from "~/lib/env.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError } from "~/lib/output.ts";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

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
      const stats = await stat(file).catch(() => null);
      if (!stats) {
        die(`File not found: ${file}`);
      }
      const body = await readFile(file);
      const size = stats.size;
      const mime = MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream";

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      // 1) Ask the server for a presigned upload URL. Upstream v0.2.9
      // replaced the single GET /spectrum/avatar-upload-url endpoint with
      // a two-step POST /spectrum/avatar/upload (presign) +
      // POST /spectrum/avatar/commit (finalize) flow. The presign step
      // returns the storage `key` we must echo back to /commit so the
      // server can verify the object exists in S3 and persist the
      // canonical avatar URL.
      const urlResp = await api.api
        .projects({ id: projectId })
        .spectrum.avatar.upload.post({ contentType: mime });
      if (urlResp.status === 401) throw new SessionExpiredError(resolved.name);
      if (urlResp.error)
        die(`Failed to get upload URL: ${formatApiError(urlResp.error)}`);
      const presign = urlResp.data as {
        uploadUrl?: string;
        key?: string;
        error?: string;
      };
      if (presign.error) die(presign.error);
      if (!presign.uploadUrl || !presign.key) {
        die("Server did not return upload URL + key.");
      }

      // 2) PUT the file body to the presigned URL. Spectrum returns a
      // simple PUT-style URL (per services/spectrum.ts), not multipart.
      console.log(c.dim(`Uploading ${file} (${(size / 1024).toFixed(1)} KB)…`));
      const putResp = await fetch(presign.uploadUrl, {
        method: "PUT",
        body,
        headers: {
          "Content-Type": mime,
        },
      });
      if (!putResp.ok) {
        die(`Upload failed: ${putResp.status} ${putResp.statusText}`);
      }

      // 3) Commit the upload so Spectrum finalizes the avatar artifact
      // and returns the canonical avatarUrl we can persist on the profile.
      const commitResp = await api.api
        .projects({ id: projectId })
        .spectrum.avatar.commit.post({ key: presign.key });
      if (commitResp.status === 401) throw new SessionExpiredError(resolved.name);
      if (commitResp.error)
        die(`Failed to commit avatar: ${formatApiError(commitResp.error)}`);
      const commit = commitResp.data as {
        success?: true;
        avatarUrl?: string;
        error?: string;
      };
      if (commit.error) die(commit.error);
      if (!commit.avatarUrl) {
        die("Server did not return committed avatar URL.");
      }
      const avatarUrl = commit.avatarUrl;

      // 4) Optionally update the Spectrum profile to point at the new URL.
      if (opts.updateProfile !== false) {
        const patch = await api.api
          .projects({ id: projectId })
          .spectrum.profile.patch({ avatarUrl });
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
            avatarUrl,
          });
          die(`Uploaded, but failed to update profile: ${formatApiError(patch.error)}`, {
            hint: `Update manually: ${recovery}`,
            context: `Avatar URL: ${avatarUrl}`,
          });
        }
      }

      console.log(c.success(`Uploaded avatar from ${file}`));
      console.log(c.dim(`  URL: ${avatarUrl}`));
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
