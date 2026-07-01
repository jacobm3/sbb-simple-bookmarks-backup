// settings.js
// Central place for the extension's settings: the defaults, reading/writing them,
// and validating user input (especially the backup directory path).
//
// Settings that should follow the user across their devices live in
// chrome.storage.sync. Per-device status (last run time, errors, the backup log)
// lives in chrome.storage.local because it describes THIS machine, not a preference.

// The default settings, applied on first run. Keep in sync with SPEC.md section 5.
export const DEFAULT_SETTINGS = {
  enabled: true,                  // master on/off for scheduled backups
  scheduleMode: "daily",          // "daily" | "interval"
  dailyTime: "03:00",             // "HH:MM" 24-hour, used when scheduleMode === "daily"
  intervalHours: 24,              // integer >= 1, used when scheduleMode === "interval"
  // Relative to the Downloads folder. NOTE: a leading-dot directory like
  // ".chrome-bookmarks" is REJECTED by Chrome's downloads API ("Invalid filename")
  // — confirmed by test G / SPEC 11.2 — so the default is the no-dot form. A user
  // may still enter a dotted path; it is permitted but flagged, and if Chrome
  // refuses it the backup fails loudly (never silently writes elsewhere).
  backupDir: "chrome-bookmarks-backup",
  compression: "auto",            // "auto" | "gzip" | "none" (auto = zstd if available, else gzip)
  retentionEnabled: false,        // when true, keep only the newest N snapshots
  retentionKeep: 30,              // integer >= 1, only meaningful when retentionEnabled
  notifyOnFailure: true,          // raise a desktop notification when a backup fails
  theme: "auto",                  // "auto" | "light" | "dark" (auto follows prefers-color-scheme)
};

// The default per-device status object (chrome.storage.local).
export const DEFAULT_STATUS = {
  lastRunAt: null,    // epoch ms of the last backup attempt
  lastResult: null,   // "success" | "error" | null
  lastError: null,    // human-readable error string
  lastFilename: null, // full relative path of the last file written
  lastFormat: null,   // "zstd" | "gzip" | "none" | null
  backupLog: [],      // recent entries { ts, result, filename, format, downloadId }, capped
};

// How many entries we keep in backupLog before dropping the oldest.
export const BACKUP_LOG_CAP = 200;

// Read all settings, filling in any missing keys with their defaults.
export async function getSettings() {
  // Passing the defaults object makes chrome fill in defaults for missing keys.
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // Merge again defensively in case new keys were added since first run.
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Save a partial set of settings (only the keys provided are changed).
export async function setSettings(partial) {
  await chrome.storage.sync.set(partial);
}

// Read the per-device status, filling missing keys with defaults.
export async function getStatus() {
  const stored = await chrome.storage.local.get(DEFAULT_STATUS);
  return { ...DEFAULT_STATUS, ...stored };
}

// Save a partial status update.
export async function setStatus(partial) {
  await chrome.storage.local.set(partial);
}

// Sanitize a backupDir so Chrome's downloads API will accept it: strip the
// leading dot(s) from each path segment (Chrome rejects dotted segments with
// "Invalid filename"). Used to auto-heal a previously-saved dotted directory
// (e.g. the old ".chrome-bookmarks" default) on install. Returns the cleaned
// path, or the default if cleaning leaves nothing.
export function sanitizeBackupDir(dir) {
  if (typeof dir !== "string") return DEFAULT_SETTINGS.backupDir;
  const cleaned = dir
    .split(/[/\\]/)                      // split into segments
    .map((seg) => seg.replace(/^\.+/, "")) // drop any leading dots from each
    .filter((seg) => seg !== "")         // drop now-empty segments
    .join("/");
  return cleaned || DEFAULT_SETTINGS.backupDir;
}

// Validate a backupDir string. Returns { ok: true, warnDotDir } or
// { ok: false, error: "..." }.
// Rules (SPEC section 5): must be relative; reject leading "/", any ".." segment,
// Windows drive letters, and characters illegal in filenames. Nested paths allowed.
export function validateBackupDir(dir) {
  if (typeof dir !== "string" || dir.trim() === "") {
    return { ok: false, error: "Directory cannot be empty." };
  }
  // No absolute paths (unix or windows style).
  if (dir.startsWith("/") || dir.startsWith("\\")) {
    return { ok: false, error: "Directory must be relative (no leading slash)." };
  }
  // No Windows drive letters like "C:".
  if (/^[a-zA-Z]:/.test(dir)) {
    return { ok: false, error: "Drive letters are not allowed." };
  }
  // Split into path segments on either slash type and check each one.
  const segments = dir.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === "") {
      // Empty segment means a leading, trailing, or doubled slash.
      return { ok: false, error: "Directory has an empty path segment." };
    }
    if (seg === "..") {
      return { ok: false, error: 'Parent-directory segments ("..") are not allowed.' };
    }
    if (seg === ".") {
      return { ok: false, error: 'Single-dot segments (".") are not allowed.' };
    }
    // Characters illegal in filenames on common filesystems.
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      return { ok: false, error: "Directory contains illegal characters." };
    }
  }
  // A leading dot on a segment is allowed but may be altered by Chrome (SPEC 2.5).
  const warnDotDir = segments.some((s) => s.startsWith("."));
  return { ok: true, warnDotDir };
}
