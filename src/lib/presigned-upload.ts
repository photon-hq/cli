import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { c, die } from "~/lib/output.ts";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface LocalUploadFile {
  body: Buffer;
  contentType: string;
  size: number;
}

export async function readLocalUploadFile(file: string): Promise<LocalUploadFile> {
  const stats = await stat(file).catch(() => null);
  if (!stats) {
    die(`File not found: ${file}`);
  }

  return {
    body: await readFile(file),
    contentType:
      MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    size: stats.size,
  };
}

export async function putPresignedUpload(
  file: string,
  uploadUrl: string,
  upload: LocalUploadFile
): Promise<void> {
  console.log(c.dim(`Uploading ${file} (${(upload.size / 1024).toFixed(1)} KB)…`));

  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: upload.body,
    headers: { "Content-Type": upload.contentType },
  });
  if (!response.ok) {
    die(`Upload failed: ${response.status} ${response.statusText}`);
  }
}
