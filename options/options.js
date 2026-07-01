// options.js
// Drives the options page: loads settings into the form, saves changes back to
// chrome.storage (with validation), applies the theme, shows status, runs manual
// backups, and performs non-destructive restores.

import {
  getSettings,
  setSettings,
  getStatus,
  validateBackupDir,
} from "../src/settings.js";
import { supportsZstd } from "../src/compression.js";
import { loadBackupFile, restoreTree } from "../src/restore.js";

// Small helper to grab an element by id.
const $ = (id) => document.getElementById(id);

// ---------- Theme ----------

// Apply the theme choice to <html>. "auto" removes the attribute so the CSS
// media query (prefers-color-scheme) takes over; "light"/"dark" force it.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

// ---------- Load settings into the form ----------

async function loadIntoForm() {
  const s = await getSettings();

  $("enabled").checked = s.enabled;
  for (const radio of document.querySelectorAll('input[name="scheduleMode"]')) {
    radio.checked = radio.value === s.scheduleMode;
  }
  $("dailyTime").value = s.dailyTime;
  $("intervalHours").value = s.intervalHours;
  $("backupDir").value = s.backupDir;
  $("compression").value = s.compression;
  $("retentionEnabled").checked = s.retentionEnabled;
  $("retentionKeep").value = s.retentionKeep;
  $("notifyOnFailure").checked = s.notifyOnFailure;
  $("theme").value = s.theme;

  applyTheme(s.theme);
  updateModeVisibility();
  updateRetentionVisibility();
  updateZstdNote();
  // Show any pre-existing dot-dir warning for the loaded value.
  validateDirField();
}

// Show/hide the daily-time vs interval-hours fields based on the selected mode.
function updateModeVisibility() {
  const mode = document.querySelector('input[name="scheduleMode"]:checked')?.value;
  $("daily-field").style.display = mode === "daily" ? "" : "none";
  $("interval-field").style.display = mode === "interval" ? "" : "none";
}

// Show/hide the "keep newest" field based on the retention toggle.
function updateRetentionVisibility() {
  $("retention-field").style.display = $("retentionEnabled").checked ? "" : "none";
}

// Note whether this browser supports zstd, so the user understands "auto".
function updateZstdNote() {
  const note = supportsZstd()
    ? "This browser supports zstd, so Auto will use zstd (.zst)."
    : "This browser lacks zstd, so Auto will use gzip (.gz).";
  $("zstd-note").textContent = note;
}

// ---------- Validation for the directory field ----------

// Validate the backupDir input. Returns true if valid. Updates the inline msg.
function validateDirField() {
  const msg = $("backupDir-msg");
  const result = validateBackupDir($("backupDir").value);
  if (!result.ok) {
    msg.textContent = result.error;
    msg.className = "field-msg err";
    return false;
  }
  if (result.warnDotDir) {
    msg.textContent =
      "Note: a leading dot may be altered by Chrome. Check the actual path after " +
      "your first backup (see status).";
    msg.className = "field-msg warn";
  } else {
    msg.textContent = "";
    msg.className = "field-msg";
  }
  return true;
}

// ---------- Save handlers ----------

// Persist a single setting key/value.
async function save(key, value) {
  await setSettings({ [key]: value });
}

// Wire up every control to save on change.
function wireInputs() {
  $("enabled").addEventListener("change", (e) => save("enabled", e.target.checked));

  for (const radio of document.querySelectorAll('input[name="scheduleMode"]')) {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) {
        save("scheduleMode", e.target.value);
        updateModeVisibility();
      }
    });
  }

  $("dailyTime").addEventListener("change", (e) => {
    // A valid HH:MM value; the time input already constrains this.
    if (e.target.value) save("dailyTime", e.target.value);
  });

  $("intervalHours").addEventListener("change", (e) => {
    let n = parseInt(e.target.value, 10);
    if (!Number.isInteger(n) || n < 1) n = 1; // clamp to the minimum
    e.target.value = n;
    save("intervalHours", n);
  });

  $("backupDir").addEventListener("input", validateDirField);
  $("backupDir").addEventListener("change", (e) => {
    // Only save when valid; otherwise leave the stored value untouched.
    if (validateDirField()) save("backupDir", e.target.value);
  });

  $("compression").addEventListener("change", (e) => save("compression", e.target.value));

  $("retentionEnabled").addEventListener("change", (e) => {
    save("retentionEnabled", e.target.checked);
    updateRetentionVisibility();
  });

  $("retentionKeep").addEventListener("change", (e) => {
    let n = parseInt(e.target.value, 10);
    if (!Number.isInteger(n) || n < 1) n = 1;
    e.target.value = n;
    save("retentionKeep", n);
  });

  $("notifyOnFailure").addEventListener("change", (e) =>
    save("notifyOnFailure", e.target.checked)
  );

  $("theme").addEventListener("change", (e) => {
    save("theme", e.target.value);
    applyTheme(e.target.value);
  });
}

// ---------- Status display ----------

// Format an epoch-ms timestamp as a friendly local string.
function fmtTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

async function refreshStatus() {
  const st = await getStatus();
  $("st-lastrun").textContent = fmtTime(st.lastRunAt);

  const resultEl = $("st-result");
  resultEl.textContent = st.lastResult || "—";
  resultEl.className = st.lastResult === "success" ? "ok" : st.lastResult === "error" ? "err" : "";

  $("st-file").textContent = st.lastFilename || "—";
  $("st-format").textContent = st.lastFormat || "—";
  $("st-error").textContent = st.lastError || "—";
}

// ---------- Back up now ----------

function wireBackupNow() {
  $("backup-now").addEventListener("click", async () => {
    const btn = $("backup-now");
    const msg = $("backup-msg");
    btn.disabled = true;
    msg.textContent = "Backing up…";
    msg.className = "inline-msg";
    try {
      // Ask the service worker to run the backup so it uses the same pipeline as
      // scheduled runs. It responds with the resulting status.
      const resp = await chrome.runtime.sendMessage({ type: "backup-now" });
      await refreshStatus();
      if (resp && resp.status && resp.status.lastResult === "success") {
        msg.textContent = "Backup complete.";
        msg.className = "inline-msg ok";
      } else {
        const err = resp && resp.status ? resp.status.lastError : "Unknown error";
        msg.textContent = "Backup failed: " + err;
        msg.className = "inline-msg err";
      }
    } catch (e) {
      msg.textContent = "Backup failed: " + (e.message || e);
      msg.className = "inline-msg err";
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Restore ----------

// Holds the parsed tree between "file selected" and "Restore now".
let pendingRestore = null;

function wireRestore() {
  $("restoreFile").addEventListener("change", async (e) => {
    const summary = $("restore-summary");
    const runBtn = $("restore-run");
    pendingRestore = null;
    runBtn.disabled = true;

    const file = e.target.files && e.target.files[0];
    if (!file) {
      summary.textContent = "";
      summary.className = "field-msg";
      return;
    }
    try {
      const { tree, counts } = await loadBackupFile(file);
      pendingRestore = tree;
      summary.textContent =
        `Ready to restore ${counts.bookmarks} bookmark(s) in ${counts.folders} folder(s).`;
      summary.className = "field-msg ok";
      runBtn.disabled = false;
    } catch (err) {
      summary.textContent = "Cannot restore: " + (err.message || err);
      summary.className = "field-msg err";
    }
  });

  $("restore-run").addEventListener("click", async () => {
    if (!pendingRestore) return;
    const btn = $("restore-run");
    const msg = $("restore-msg");
    btn.disabled = true;
    msg.textContent = "Restoring…";
    msg.className = "inline-msg";
    try {
      // Build an ISO-ish timestamp for the restore folder name.
      const iso = new Date().toISOString().replace(/[:.]/g, "-");
      await restoreTree(pendingRestore, iso);
      msg.textContent = "Restore complete — see the new folder in Other Bookmarks.";
      msg.className = "inline-msg ok";
    } catch (err) {
      msg.textContent = "Restore failed: " + (err.message || err);
      msg.className = "inline-msg err";
      btn.disabled = false;
    }
  });
}

// ---------- Live updates ----------

// If settings change elsewhere (e.g. synced from another device), reload the
// form. If the per-device status changes (a backup ran), refresh the status.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") loadIntoForm();
  if (area === "local") refreshStatus();
});

// ---------- Init ----------

async function init() {
  await loadIntoForm();
  await refreshStatus();
  wireInputs();
  wireBackupNow();
  wireRestore();
}

init();
