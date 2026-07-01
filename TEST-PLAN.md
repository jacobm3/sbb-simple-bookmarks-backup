# Bookmark Backup — Test Plan

Companion to `SPEC.md`. Each section lists **steps** and the **expected result**, and maps to functional requirement IDs (FR-*). Run the desktop sections on the Linux dev machine; run section **M** on an actual ChromeOS device.

---

## Prerequisites

- Chrome with Developer mode enabled (`chrome://extensions` → toggle *Developer mode*).
- CLI tools on the Linux dev box for verifying output:
  - `zstd` (`sudo apt install zstd`) — decompress `.zst`.
  - `gzip`/`gunzip` — decompress `.gz`.
  - `jq` — validate/inspect JSON.
- A Chrome profile with a handful of bookmarks, including at least one folder and one title containing non-ASCII characters (e.g. `café — тест — 日本語`) for the unicode check.

**Loading the extension:** `chrome://extensions` → *Load unpacked* → select the build directory. To inspect the background: click the **service worker** link on the extension's card to open its DevTools console. Use that console wherever a test says "in the SW console."

---

## A. Install & load (FR-13)

1. Load unpacked. 
2. Open the SW console; run `chrome.alarms.getAll(a => console.log(a))`.

**Expected:** Extension loads with no errors. With default settings (`enabled: true`, daily), exactly one alarm named `bookmark-backup` exists.

---

## B. Options page & theming (FR-9)

1. Open the options page.
2. Set OS/browser to **light** mode; observe. Set to **dark** mode; observe. (On Linux this is the desktop theme / Chrome's theme; the page reads `prefers-color-scheme`.)
3. Set the in-page **Theme** override to Light, then Dark, then Auto.

**Expected:** With Theme = Auto, the page matches the OS/browser scheme and updates when it changes (no reload needed). The manual override forces the chosen scheme regardless of OS, and Auto returns to following the OS. Text is readable and controls are visible in both schemes.

---

## C. Settings persistence & validation (FR-10, FR-4)

1. Change several settings (schedule mode, interval, directory, compression, retention). Reload the options page.
2. Enter invalid `backupDir` values one at a time: `/etc/x` (leading slash), `../escape` (parent segment), an empty string, and a name with illegal characters.
3. Enter a valid nested path like `backups/bookmarks`.

**Expected:** Settings survive reload. Invalid directories are rejected with an inline message and not saved. The valid nested path is accepted.

---

## D. Manual backup — happy path, zstd (FR-1, FR-3, FR-6)

*(Run on a Chrome build where zstd is supported — verify first in the SW console: `try{new CompressionStream("zstd");console.log("zstd yes")}catch{console.log("zstd no")}`.)*

1. Ensure `compression: "auto"`. Click **Back up now**.
2. Open the Downloads folder / Files app.

**Expected:** A file `bookmarks-YYYYMMDD-HHmmss.json.zst` appears under `Downloads/.chrome-bookmarks/`. The options page status shows success, the filename, format `zstd`, and a recent timestamp.

---

## E. Compression fallback — gzip (FR-3)

1. Set **Compression** to *Gzip*. Click **Back up now**.
2. (If you have access to a Chrome build without zstd, also test `auto` there and confirm it falls back.)

**Expected:** A `…​.json.gz` file is written; status shows format `gzip`. In `auto` mode on a non-zstd browser, the same `.gz` fallback occurs automatically.

---

## F. File integrity via CLI (FR-1) — the real proof

On the Linux dev box, in `Downloads/.chrome-bookmarks/`:

```bash
# zstd snapshot
zstd -d bookmarks-*.json.zst -o /tmp/out.json && jq '.[0].children | length' /tmp/out.json

# gzip snapshot
gunzip -kc bookmarks-*.json.gz > /tmp/out2.json && jq '.[0].children | length' /tmp/out2.json
```

**Expected:** Both decompress without error and produce valid JSON. `jq` returns a number, and inspecting the JSON shows your actual bookmark titles/URLs, including the unicode title intact.

---

## G. Directory configuration + dot-directory behavior (FR-4) — **known risk**

1. With default `.chrome-bookmarks`, run a backup and confirm the *exact* on-disk path (`ls -la ~/Downloads` and look for the dotted dir).
2. Change `backupDir` to `bookmarks-backups` (no dot), back up, confirm the new location.
3. Change to nested `backups/bookmarks`, back up, confirm nested creation.

**Expected:** Files land exactly under the configured path. **Specifically verify** whether Chrome preserved the leading dot in step 1. If Chrome stripped/altered it (e.g. wrote to `chrome-bookmarks` or `_chrome-bookmarks`), that must be handled per SPEC §11.2 — either the default is changed or the behavior is clearly documented and the status reflects the true path. This test must not "pass" by silently writing to an unexpected folder.

---

## H. Scheduling (FR-2)

**H1 — alarm creation per mode**
1. Set *Daily* at a specific time; save; in SW console run `chrome.alarms.getAll(...)`.
2. Switch to *Every N hours*; save; check again.

**Expected:** Daily mode shows an alarm with `periodInMinutes ≈ 1440` and a `scheduledTime` at the next occurrence of the chosen time. Interval mode shows `periodInMinutes = N*60`.

**H2 — alarm actually fires**
1. In the SW console: `chrome.alarms.create("bookmark-backup", { delayInMinutes: 0.5 })` (Chrome clamps the minimum to ~30s).
2. Wait ~30–40s without interacting.

**Expected:** A new snapshot appears and status updates — proving the `onAlarm` handler runs the pipeline, not just the button.

**H3 — missed alarm on startup**
1. Set a daily time a few minutes in the future. Fully quit Chrome before it fires. After that time passes, relaunch Chrome.

**Expected:** Shortly after launch, a backup runs (the missed daily fires on next startup), consistent with SPEC §2.3.

**H4 — master toggle (FR-13)**
1. Set `enabled: false`; check `chrome.alarms.getAll`.

**Expected:** No `bookmark-backup` alarm exists; no scheduled backups occur. Re-enabling re-arms it.

---

## I. Retention (FR-11)

1. Enable retention, set *keep* = 3.
2. Trigger 5 backups (button, or the H2 short alarm a few times).

**Expected:** Only the 3 newest snapshots remain on disk; the 2 oldest are deleted (file removed, not just history). With retention **disabled** (default), no snapshot is ever auto-deleted no matter how many accumulate. Confirm the prune only touched files this extension created.

---

## J. Restore — non-destructive (FR-12)

1. Note your current bookmarks. Take a backup.
2. Delete a bookmark folder in Chrome to simulate an accident.
3. In the extension, choose **Restore from file**, select the backup, confirm the summary counts, and run the restore.
4. Also attempt a restore from a `.zst` file and a `.gz` file.

**Expected:** A new folder `Bookmarks Restore <timestamp>` appears under *Other Bookmarks* containing the full recreated tree, including the deleted folder's contents. **No existing bookmark is deleted, moved, or altered.** Both compression formats restore correctly. If a `.zst` is opened on a browser lacking zstd decompression, a clear error is shown (per SPEC §11 limitation) rather than a silent failure.

---

## K. Error handling & failure notification (FR-8)

1. Force a failure: set `backupDir` to an invalid value at the API level, or temporarily revoke the ability to write (e.g. simulate by making the download call reject in a dev build).
2. Ensure `notifyOnFailure` is on.

**Expected:** The run fails gracefully — status shows `error` with a readable message, the previous snapshot and settings are untouched, and a desktop notification appears. Successful runs produce **no** notification (silent success).

---

## L. "Ask where to save each file" interaction (FR-1) — **known risk**

1. In Chrome settings, enable *Ask where to save each file before downloading*. Run **Back up now**.
2. Disable the setting. Run **Back up now** again.

**Expected:** With `saveAs: false`, the backup should write without a save dialog in the disabled case. Document the enabled-case behavior: if Chrome still forces a prompt, note it as an environmental limitation and ensure the extension reports the run as pending/failed rather than falsely reporting success.

---

## M. ChromeOS-specific (all FRs) — run on a real ChromeOS device

1. Load the unpacked extension on ChromeOS (Developer mode).
2. Repeat B (theming follows ChromeOS system theme), D/E (backup + fallback), and the path check from G using the **Files** app.
3. In Files, enable *Show hidden files* and confirm the `.chrome-bookmarks` directory and snapshots are present under Downloads. Verify a snapshot opens/decompresses (copy to Linux/Crostini and run the §F commands, or use a ChromeOS-side tool).
4. Confirm no native-messaging code path is exercised anywhere.

**Expected:** Identical behavior to desktop. Files land in Downloads and are visible in the Files app (hidden-files toggle on for the dotted dir). Theming follows the ChromeOS system setting.

---

## N. Edge cases & privacy (FR-1, FR-14)

1. **Empty bookmarks:** on a profile with essentially no bookmarks, run a backup.
2. **Large set:** import a large bookmark HTML (hundreds/thousands) and back up.
3. **Unicode:** confirm the non-ASCII title round-trips (already checked in F/J).
4. **Disabled while running:** toggle `enabled` off mid-day; confirm no scheduled runs.
5. **Network check:** open the SW DevTools **Network** tab (and/or watch `chrome://net-export`) across a backup.

**Expected:** Empty and large trees both back up and decompress to valid JSON. Unicode is preserved byte-for-byte. **No network requests are made at any point** — confirming FR-14.

---

## Acceptance checklist (map to SPEC §12)

- [ ] A, H4 — load & master toggle
- [ ] B, M — theming follows browser/ChromeOS, override works
- [ ] C — settings persist; directory validation
- [ ] D, E, F — backup writes valid, decompressible files; zstd + gzip fallback
- [ ] G — directory configurable; dotted-default behavior known & handled
- [ ] H — both schedule modes arm and fire; missed-alarm-on-startup
- [ ] I — retention prunes correctly; off by default deletes nothing
- [ ] J — restore is correct and non-destructive; both formats
- [ ] K — failures recorded + notified; success silent
- [ ] L — unattended download behavior verified against the Chrome save-prompt setting
- [ ] M — full behavior confirmed on ChromeOS
- [ ] N — edge cases pass; zero network egress
