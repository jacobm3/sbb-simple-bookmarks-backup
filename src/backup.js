// backup.js
// The backup pipeline: read the bookmark tree, serialize to JSON, compress,
// base64-encode into a data: URL, hand it to chrome.downloads, and wait for the
// download to actually finish. Also records status/log and (optionally) raises a
// failure notification. This function never throws — errors are recorded instead.

import { getStatus, setStatus, getSettings, BACKUP_LOG_CAP } from "./settings.js";
import { compress, extensionForFormat } from "./compression.js";
import { runRetention } from "./retention.js";

// Base64-encode a Uint8Array WITHOUT overflowing the call stack. We build the
// binary string in chunks (SPEC section 9) and then btoa() it, or use the native
// toBase64() when the runtime provides it.
export function bytesToBase64(bytes) {
  // Fast path: modern runtimes have Uint8Array.prototype.toBase64().
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }
  // Fallback: assemble the binary string 32 KB at a time. Passing the whole array
  // to String.fromCharCode(...bytes) would overflow the argument stack.
  const CHUNK = 0x8000; // 32768 bytes per call
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// Build the timestamped filename base, e.g. "bookmarks-20260701-030000".
// Uses LOCAL time so the filename matches the user's wall clock.
export function makeFilenameBase(date) {
  const p = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = p(date.getMonth() + 1);
  const d = p(date.getDate());
  const h = p(date.getHours());
  const mi = p(date.getMinutes());
  const s = p(date.getSeconds());
  return `bookmarks-${y}${mo}${d}-${h}${mi}${s}`;
}

// Wait for a download to reach a terminal state. Resolves with the final on-disk
// filename on "complete"; rejects on "interrupted" or timeout. This is how we
// avoid falsely reporting success when Chrome pops a save dialog or the write
// fails (SPEC tests K and L).
function waitForDownload(downloadId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      fn(arg);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        // Look up the real path to report in status.
        chrome.downloads.search({ id: downloadId }, (items) => {
          const filename = items && items[0] ? items[0].filename : null;
          finish(resolve, filename);
        });
      } else if (delta.state && delta.state.current === "interrupted") {
        const reason = delta.error ? delta.error.current : "unknown";
        finish(reject, new Error("Download interrupted: " + reason));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Download did not complete within timeout (a save dialog or a write " +
          "failure may be blocking it)."
        )
      );
    }, timeoutMs);

    // It may already be finished before we attached the listener — check now.
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (!items || !items[0]) return;
      if (items[0].state === "complete") {
        finish(resolve, items[0].filename);
      } else if (items[0].state === "interrupted") {
        finish(reject, new Error("Download interrupted: " + (items[0].error || "unknown")));
      }
    });
  });
}

// Run one full backup. `reason` is a short string for logging ("manual"|"alarm").
// Returns the status object it wrote. Never throws — errors are recorded instead.
export async function runBackup(reason = "manual") {
  const now = new Date();
  try {
    const settings = await getSettings();

    // 1. Read the whole bookmark tree.
    const tree = await chrome.bookmarks.getTree();

    // 2. Serialize compactly (compression makes pretty-printing pointless here).
    const json = JSON.stringify(tree);

    // 3. Compress according to the user's setting.
    const { bytes, format } = await compress(json, settings.compression);

    // 4. Base64-encode and build a data: URL for chrome.downloads.
    const b64 = bytesToBase64(bytes);
    const dataUrl = `data:application/octet-stream;base64,${b64}`;

    // 5. Build the target path and start the download.
    const name = makeFilenameBase(now) + extensionForFormat(format);
    const relPath = `${settings.backupDir}/${name}`;
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: relPath,
      saveAs: false,              // never pop a save dialog (unattended operation)
      conflictAction: "uniquify", // never overwrite an existing snapshot
    });

    // 5b. Wait for it to actually land on disk before claiming success.
    const finalPath = await waitForDownload(downloadId);

    // 6. Record success. Prefer the real on-disk path Chrome reports, but fall
    //    back to the requested relative path if the search returned nothing.
    const recordedPath = finalPath || relPath;
    const entry = {
      ts: now.getTime(),
      result: "success",
      filename: recordedPath,
      format,
      downloadId,
    };
    await appendLogAndStatus(entry, {
      lastRunAt: now.getTime(),
      lastResult: "success",
      lastError: null,
      lastFilename: recordedPath,
      lastFormat: format,
    });

    // 7. Retention (guarded internally; a no-op when disabled).
    await runRetention();

    return await getStatus();
  } catch (err) {
    // On ANY error: record it and optionally notify. Never throw. The previous
    // good snapshot's info (lastFilename/lastFormat) is deliberately left intact.
    const message = err && err.message ? err.message : String(err);
    const entry = {
      ts: now.getTime(),
      result: "error",
      filename: null,
      format: null,
      downloadId: null,
    };
    await appendLogAndStatus(entry, {
      lastRunAt: now.getTime(),
      lastResult: "error",
      lastError: message,
    });
    await maybeNotifyFailure(message);
    return await getStatus();
  }
}

// Append an entry to backupLog (capped) and apply the given status fields.
async function appendLogAndStatus(entry, statusFields) {
  const status = await getStatus();
  const log = Array.isArray(status.backupLog) ? status.backupLog.slice() : [];
  log.push(entry);
  // Keep only the most recent BACKUP_LOG_CAP entries (drop oldest first).
  while (log.length > BACKUP_LOG_CAP) log.shift();
  await setStatus({ ...statusFields, backupLog: log });
}

// Raise a desktop notification about a failure, if the user wants them.
async function maybeNotifyFailure(message) {
  try {
    const settings = await getSettings();
    if (!settings.notifyOnFailure) return;
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: "Simple Bookmarks Backup failed",
      message: message.slice(0, 300),
    });
  } catch {
    // Notifications are best-effort; never let them break the pipeline.
  }
}
