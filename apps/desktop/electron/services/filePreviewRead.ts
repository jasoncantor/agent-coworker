import fs from "node:fs/promises";

export const DEFAULT_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

export async function readCappedFilePreview(
  absPath: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; byteLength: number; truncated: boolean }> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  const toRead = Math.min(maxBytes, stat.size);
  const fh = await fs.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buffer, 0, toRead, 0);
    // Detach from the pooled Buffer by copying into a fresh Uint8Array so the
    // slice we send over IPC isn't aliased to a larger backing store.
    const bytes = new Uint8Array(bytesRead);
    bytes.set(buffer.subarray(0, bytesRead));
    return {
      bytes,
      byteLength: bytesRead,
      truncated: stat.size > bytesRead,
    };
  } finally {
    await fh.close();
  }
}
