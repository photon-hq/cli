import { c, die } from "~/lib/output.ts";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const SVG_EXTENSIONS = new Set([".svg", ".svgz"]);
const SVG_PREFIX_PATTERN =
  /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i;
const SVG_SIGNATURE_BYTES = 4100;

const fileExtension = (file: string): string => {
  const fileName = file.replaceAll("\\", "/").split("/").at(-1) ?? file;
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
};

const isSvgContent = (body: Uint8Array): boolean =>
  SVG_PREFIX_PATTERN.test(
    new TextDecoder().decode(body.subarray(0, SVG_SIGNATURE_BYTES))
  );

const rejectSvg = (extension: string, body?: Uint8Array): void => {
  if (SVG_EXTENSIONS.has(extension) || (body && isSvgContent(body))) {
    die("SVG avatars are not supported.", {
      hint: "Convert the image to PNG, JPEG, or WebP before uploading.",
    });
  }
};

export interface LocalUploadFile {
  body: Uint8Array;
  contentType: string;
  size: number;
}

export async function readLocalUploadFile(file: string): Promise<LocalUploadFile> {
  const extension = fileExtension(file);
  rejectSvg(extension);

  const localFile = Bun.file(file);
  if (!(await localFile.exists())) {
    die(`File not found: ${file}`);
  }

  const body = new Uint8Array(await localFile.arrayBuffer());
  rejectSvg(extension, body);

  return {
    body,
    contentType: MIME_TYPES[extension] ?? "application/octet-stream",
    size: body.byteLength,
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
