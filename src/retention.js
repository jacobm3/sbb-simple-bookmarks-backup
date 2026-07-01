// retention.js
// Optional pruning of old snapshots. It ONLY ever touches downloads that this
// extension created (tracked by downloadId in the backup log) — never a blanket
// search of the user's downloads. Off by default; deletes nothing unless enabled.

import { getSettings, getStatus, setStatus } from "./settings.js";

export async function runRetention() {
  const settings = await getSettings();

  // Guards: do nothing unless explicitly enabled with a sane keep count.
  if (!settings.retentionEnabled) return;
  if (!Number.isInteger(settings.retentionKeep) || settings.retentionKeep < 1) return;

  const status = await getStatus();
  const log = Array.isArray(status.backupLog) ? status.backupLog.slice() : [];

  // Only successful snapshots that still have a numeric downloadId are prunable.
  const snapshots = log.filter(
    (e) => e.result === "success" && typeof e.downloadId === "number"
  );
  // Sort oldest first so we delete the oldest excess.
  snapshots.sort((a, b) => a.ts - b.ts);

  const excess = snapshots.length - settings.retentionKeep;
  if (excess <= 0) return;

  // The oldest `excess` snapshots get deleted.
  const toDelete = snapshots.slice(0, excess);
  const deletedIds = new Set();
  for (const entry of toDelete) {
    try {
      // removeFile deletes the actual file from disk...
      await chrome.downloads.removeFile(entry.downloadId);
    } catch {
      // File may already be gone; keep going.
    }
    try {
      // ...and erase removes the entry from Chrome's download history.
      await chrome.downloads.erase({ id: entry.downloadId });
    } catch {
      // History row may already be gone.
    }
    deletedIds.add(entry.downloadId);
  }

  // Drop the pruned entries from the log so we don't try to delete them again.
  const newLog = log.filter((e) => !deletedIds.has(e.downloadId));
  await setStatus({ backupLog: newLog });
}
