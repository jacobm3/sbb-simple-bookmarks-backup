// service-worker.js
// Entry point for the MV3 background service worker. Wires up:
//  - alarm (re)arming on install/startup,
//  - the onAlarm handler that runs the backup pipeline,
//  - messages from the options page ("back up now"),
//  - re-arming whenever settings change.
//
// This is an ES module ("type": "module" in the manifest), so it can import the
// helpers in src/.

import { rearmAlarm, ALARM_NAME } from "./src/scheduler.js";
import { runBackup } from "./src/backup.js";
import { getSettings, DEFAULT_SETTINGS, sanitizeBackupDir } from "./src/settings.js";

// On install (and on update), make sure defaults exist and arm the alarm.
chrome.runtime.onInstalled.addListener(async () => {
  // Fill in any settings the user doesn't have yet, without clobbering existing.
  const current = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };

  // Auto-heal a previously-saved dotted backup directory. Chrome's downloads API
  // rejects a folder whose name starts with a dot ("Invalid filename"), and older
  // builds of this extension defaulted to ".chrome-bookmarks". If the stored value
  // still has a leading-dot segment, rewrite it to the accepted form so backups
  // stop failing. A user's already-valid choice is left untouched.
  const healed = sanitizeBackupDir(merged.backupDir);
  if (healed !== merged.backupDir) {
    merged.backupDir = healed;
  }

  await chrome.storage.sync.set(merged);
  await rearmAlarm();
});

// On browser startup, re-arm (alarms can be lost across an update/restart).
chrome.runtime.onStartup.addListener(async () => {
  await rearmAlarm();
});

// When the alarm fires, run a backup (only if still enabled).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  if (!settings.enabled) return;
  await runBackup("alarm");
});

// Re-arm whenever the user changes settings (the sync storage area). Re-arming on
// any sync change is simple and always safe.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  await rearmAlarm();
});

// Handle messages from the options page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "backup-now") {
    // Run the backup and report the resulting status back to the options page.
    runBackup("manual").then((status) => sendResponse({ ok: true, status }));
    return true; // keep the message channel open for the async response
  }
  return false;
});
