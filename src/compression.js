// compression.js
// Feature-detects zstd and provides compress/decompress helpers built on the
// browser's native CompressionStream / DecompressionStream. Shared between the
// service worker (compress during backup) and the options page (decompress during
// restore).

// Returns true if this browser can create a zstd CompressionStream.
export function supportsZstd() {
  try {
    // Constructing it is the cheapest reliable feature test.
    new CompressionStream("zstd");
    return true;
  } catch {
    return false;
  }
}

// Same idea, but for decompression (used by restore).
export function supportsZstdDecompress() {
  try {
    new DecompressionStream("zstd");
    return true;
  } catch {
    return false;
  }
}

// Given the user's compression setting ("auto" | "gzip" | "none"), decide the
// actual format to use right now. "auto" prefers zstd, falling back to gzip.
export function resolveFormat(mode) {
  if (mode === "none") return "none";
  if (mode === "gzip") return "gzip";
  // auto: use zstd when the browser supports it, else gzip.
  return supportsZstd() ? "zstd" : "gzip";
}

// Compress a string. Returns { bytes: Uint8Array, format: "zstd"|"gzip"|"none" }.
export async function compress(str, mode) {
  const format = resolveFormat(mode);
  if (format === "none") {
    // No compression: just UTF-8 encode the string.
    const bytes = new TextEncoder().encode(str);
    return { bytes, format };
  }
  // Stream the string through the native compressor.
  const cs = new CompressionStream(format); // "gzip" | "zstd"
  const stream = new Blob([str]).stream().pipeThrough(cs);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return { bytes, format };
}

// Decompress bytes previously produced by compress(). `format` is one of
// "zstd" | "gzip" | "none". Returns the original string. Throws a clear error if
// the browser cannot decompress zstd.
export async function decompress(bytes, format) {
  if (format === "none") {
    return new TextDecoder().decode(bytes);
  }
  if (format === "zstd" && !supportsZstdDecompress()) {
    throw new Error(
      "This browser cannot decompress zstd (.zst) files. Open the backup on a " +
      "newer Chrome, or use a gzip/uncompressed backup."
    );
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

// Map a format to its filename extension suffix (appended after the base name).
export function extensionForFormat(format) {
  if (format === "zstd") return ".json.zst";
  if (format === "gzip") return ".json.gz";
  return ".json"; // none
}

// Given a filename, guess the format from its extension. Used by restore.
export function formatFromFilename(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zst")) return "zstd";
  if (lower.endsWith(".gz")) return "gzip";
  return "none";
}
