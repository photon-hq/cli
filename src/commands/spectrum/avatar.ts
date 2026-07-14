import type { Command } from "@commander-js/extra-typings";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
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

      // 1) Ask the server for a presigned PUT URL. Upstream v0.3.1 replaced
      // `GET spectrum/avatar-upload-url` with a two-step flow: `POST
      // spectrum/avatar/upload` issues the URL + a storage `key`, then `POST
      // spectrum/avatar/commit` finalizes the upload using that key.
      const urlResp = await api.api
        .projects({ id: projectId })
        .spectrum.avatar.upload.post({ contentType: mime });
      if (urlResp.status === 401) throw new SessionExpiredError(resolved.name);
      if (urlResp.error)
        die(`Failed to get upload URL: ${formatApiError(urlResp.error)}`);
      const uploadResult = urlResp.data as {
        uploadUrl?: string;
        key?: string;
        error?: string;
      };
      if (uploadResult.error) die(uploadResult.error);
      if (!uploadResult.uploadUrl || !uploadResult.key) {
        die("Server did not return uploadUrl + key.");
      }

      // 2) PUT the file body to the presigned URL. Spectrum returns a
      // simple PUT-style URL (per services/spectrum.ts), not multipart.
      console.log(c.dim(`Uploading ${file} (${(size / 1024).toFixed(1)} KB)…`));
      const putResp = await fetch(uploadResult.uploadUrl, {
        method: "PUT",
        body,
        headers: {
          "Content-Type": mime,
        },
      });
      if (!putResp.ok) {
        die(`Upload failed: ${putResp.status} ${putResp.statusText}`);
      }

      // 3) Commit the upload so Spectrum verifies the object and returns the
      // canonical avatar URL.
      const commit = await api.api
        .projects({ id: projectId })
        .spectrum.avatar.commit.post({ key: uploadResult.key });
      if (commit.status === 401) throw new SessionExpiredError(resolved.name);
      if (commit.error)
        die(`Uploaded, but commit failed: ${formatApiError(commit.error)}`);
      const commitResult = commit.data as {
        success?: true;
        avatarUrl?: string;
        error?: string;
      };
      if (commitResult.error) die(commitResult.error);
      if (!commitResult.avatarUrl) {
        die("Server did not return an avatar URL after commit.");
      }
      const avatarUrl = commitResult.avatarUrl;

      console.log(c.success(`Uploaded avatar from ${file}`));
      console.log(c.dim(`  URL: ${avatarUrl}`));
    });
}
