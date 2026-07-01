# Bookmark Backup — Chrome Extension

Manifest V3 extension that writes dated, compressed snapshots of your bookmarks
to a folder in Downloads on a schedule, for recovery from accidental deletion.
No network I/O. See `SPEC.md` for the full specification and `TEST-PLAN.md` for
the test plan.

## Loading it

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this directory.
3. Open the extension's **options page** to configure schedule, directory,
   compression, retention, theme, and to run a manual backup or a restore.

## File layout (matches SPEC §6)

```
manifest.json
service-worker.js         # entry: alarms, messages, install/startup
src/settings.js           # defaults, get/set, validation
src/scheduler.js          # (re)arm chrome.alarms from settings
src/backup.js             # read → serialize → compress → base64 → download
src/compression.js        # zstd/gzip feature-detect + compress/decompress
src/retention.js          # prune old snapshots (guarded, off by default)
src/restore.js            # decompress + non-destructive tree recreate
options/                  # options.html / .css / .js
icons/                    # 16, 32, 48, 128 px
test/                     # automated CDP test harness (see below)
```

## Two decisions confirmed during the build

These resolve open items in SPEC §11 and the "known risk" test §G, based on
observed Chrome behavior.

- **Default backup directory is `chrome-bookmarks-backup` (no leading dot).**
  Chrome's `chrome.downloads` API *rejects* a path whose segment begins with a
  dot (e.g. `.chrome-bookmarks`) with **"Invalid filename"** — it does not merely
  strip the dot. A dotted directory is still *permitted* as a user setting (and
  flagged in the UI), but if Chrome refuses it the backup **fails loudly** and the
  status shows the error — it never silently writes elsewhere (SPEC §2.5, §11.2).

- **zstd falls back to gzip when unavailable.** `auto` compression uses zstd only
  when `new CompressionStream("zstd")` succeeds; otherwise it uses gzip (`.gz`).
  On the Chrome build used for testing (149), zstd CompressionStream is *not*
  available, so `auto` produces gzip — exactly the fallback SPEC §7.3 prescribes.

## Running the automated tests

The harness drives real (headless) Chrome via the DevTools Protocol and exercises
the automatable sections of `TEST-PLAN.md` (A, B, C, D/E/F content-integrity, G
dot-dir behavior, H1/H2/H4 scheduling, I retention, J restore, K failure/notify,
N edge cases + no-network). It requires Python with `websocket-client` + `requests`
and the CLI tools `zstd`, `gzip`, `jq`.

```bash
source ~/pydev/bin/activate
python test/run_tests.py
```

Not automated here (need a GUI, a device, or a full browser restart): **H3**
missed-alarm-on-restart, **L** the "Ask where to save each file" setting, **M**
ChromeOS. Run those manually per `TEST-PLAN.md`.

### Note on the headless harness

In headless mode Chrome collapses a `chrome.downloads` filename/subdir to a single
file literally named `download`, so the harness verifies the dot-directory
accept/reject decision at the *API level* and verifies file **content** by
decompressing the saved blob — rather than trusting the on-disk name, which only
headed Chrome honors. Under normal (headed) use the files are written with their
real timestamped names under the configured directory.
