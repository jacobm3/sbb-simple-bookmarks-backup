# Bookmark Backup — Chrome Extension Product Specification

**Version:** 1.0 (handoff draft)
**Target runtime:** Chrome (desktop Linux/macOS/Windows) **and ChromeOS**
**Manifest:** V3
**Audience:** Claude Code, developing locally on a Linux machine.

---

## 1. Summary

A Manifest V3 Chrome extension that, on a configurable schedule (default once per day), writes a compressed snapshot of the user's bookmarks to a local folder inside Downloads. Its purpose is **recovery from accidental deletion** — the user keeps dated, point-in-time snapshots and can restore from any of them.

The extension does no network I/O. Bookmark data never leaves the device except by being written to the user's own Downloads directory (which the user may separately choose to sync to Drive, etc.).

---

## 2. Platform constraints that shaped this design

These are load-bearing. Do not "optimize" them away without re-checking.

1. **ChromeOS is a first-class target, so native messaging is out.** Chrome's native-messaging host registration only exists for Windows, macOS, and Linux (a manifest in a browser config dir / the Windows registry pointing at a native binary). ChromeOS has no such registration path and cannot run an arbitrary host binary, and the browser cannot reach a Crostini container. Therefore **all file output goes through `chrome.downloads`**, which behaves consistently across desktop and ChromeOS.

2. **MV3 background is a service worker that Chrome kills when idle.** `setInterval`/`setTimeout` cannot be relied on for scheduling. Use **`chrome.alarms`**, which wakes the worker to fire.

3. **Alarms only fire while Chrome is running.** If a scheduled time passes while the browser is closed, the alarm fires shortly after the next launch. "Daily" therefore means "about once per day, whenever Chrome is next open." This is acceptable for backups; it must be documented in the UI.

4. **Service workers cannot use `URL.createObjectURL`.** To hand a generated file to `chrome.downloads.download`, the worker must build a **`data:` URL (base64)**. Payloads here are small after compression, so this is fine. (See §9 for the base64 gotcha and the offscreen-document fallback if size ever becomes a problem.)

5. **A leading-dot download subdirectory may be sanitized by Chrome.** The default target is `.chrome-bookmarks`. Chrome sanitizes download filenames and *may* strip or alter a leading dot in a path segment. This must be verified during testing (see test plan §G) and handled: if Chrome refuses the dotted path, the implementation must surface a clear error rather than silently writing somewhere else.

6. **The "Ask where to save each file before downloading" Chrome setting can force a save dialog.** That would break unattended operation. The extension must call `download` with `saveAs: false` and the test plan must confirm behavior with that Chrome setting both on and off (test §L).

---

## 3. Goals / non-goals

**Goals**
- Automatic, scheduled, local, compressed bookmark snapshots.
- zstd compression when the browser supports it, gzip otherwise.
- Configurable schedule, output directory, and compression.
- Options page that follows the browser's light/dark setting.
- A safe, non-destructive restore path.

**Non-goals (v1)**
- Cloud upload / sync of backups (the user can point Downloads at Drive themselves).
- Diffing or deduplicating snapshots.
- Backing up anything other than bookmarks (history, passwords, etc.).

---

## 4. Functional requirements

Each has an ID for traceability against the test plan.

| ID | Requirement |
|----|-------------|
| FR-1 | On the configured schedule, read the full bookmark tree and write a compressed snapshot to the configured directory under Downloads. |
| FR-2 | Scheduling uses `chrome.alarms`. Two modes: **Daily at a fixed time** and **Every N hours**. Both configurable in options. |
| FR-3 | Compression is chosen at runtime: if `new CompressionStream("zstd")` succeeds, use zstd (`.zst`); otherwise fall back to gzip (`.gz`). A user setting may force gzip, or disable compression (`.json`). |
| FR-4 | Default output directory is `.chrome-bookmarks` **relative to the Downloads folder**. User-configurable in options with validation. |
| FR-5 | Snapshot filenames are timestamped and never overwrite an existing snapshot. |
| FR-6 | A "Back up now" button in options triggers an immediate backup. |
| FR-7 | The options page reflects the current status: last run time, result (success/error), last filename, and format used. |
| FR-8 | On backup failure, optionally raise a desktop notification (default on). Success is silent (no per-run notification). |
| FR-9 | The options page follows the browser's `prefers-color-scheme` (light/dark) by default, with an optional manual override (Auto/Light/Dark). |
| FR-10 | Settings persist across restarts and (via `chrome.storage.sync`) across the user's devices. Per-device status persists in `chrome.storage.local`. |
| FR-11 | Optional retention: keep only the newest N snapshots created by this extension, deleting older ones. **Default off** (never auto-deletes). |
| FR-12 | Restore: the user can select a backup file; the extension decompresses and validates it, then **non-destructively** recreates the tree inside a new folder (never modifies or deletes existing bookmarks). |
| FR-13 | An on/off master toggle enables/disables scheduled backups without uninstalling. |
| FR-14 | No network requests. No remote code. All processing is local. |

---

## 5. Settings schema

Stored in `chrome.storage.sync` unless noted. Provide these defaults on first run.

| Key | Type | Default | Notes / validation |
|-----|------|---------|--------------------|
| `enabled` | boolean | `true` | Master on/off for scheduled backups. |
| `scheduleMode` | `"daily" \| "interval"` | `"daily"` | |
| `dailyTime` | string `"HH:MM"` (24h) | `"03:00"` | Used when `scheduleMode === "daily"`. |
| `intervalHours` | integer ≥ 1 | `24` | Used when `scheduleMode === "interval"`. |
| `backupDir` | string | `".chrome-bookmarks"` | Relative to Downloads. See validation below. |
| `compression` | `"auto" \| "gzip" \| "none"` | `"auto"` | `auto` = zstd if available else gzip. |
| `retentionEnabled` | boolean | `false` | |
| `retentionKeep` | integer ≥ 1 | `30` | Only meaningful when `retentionEnabled`. |
| `notifyOnFailure` | boolean | `true` | |
| `theme` | `"auto" \| "light" \| "dark"` | `"auto"` | `auto` follows `prefers-color-scheme`. |

**`backupDir` validation:** must be a relative path; reject leading `/`, any `..` segment, drive letters, and characters illegal in filenames. Allow nested paths (e.g. `backups/bookmarks`). A leading dot on a segment is *permitted in the setting* but flagged as "may be altered by Chrome" (see §2.5 / test §G).

**Status object** (in `chrome.storage.local`, per-device):

| Key | Type | Notes |
|-----|------|-------|
| `lastRunAt` | number \| null | epoch ms |
| `lastResult` | `"success" \| "error" \| null` | |
| `lastError` | string \| null | human-readable |
| `lastFilename` | string \| null | full relative path written |
| `lastFormat` | `"zstd" \| "gzip" \| "none" \| null` | |
| `backupLog` | array | recent entries `{ ts, result, filename, format, downloadId }`, capped (e.g. last 200). Also used to drive retention. |

---

## 6. Architecture / file layout

Service worker is an ES module (`"type": "module"`) so logic can be split cleanly.

```
manifest.json
service-worker.js         # entry: wires alarms, messages, install/startup
src/
  settings.js             # defaults, get/set, validation
  scheduler.js            # (re)arm chrome.alarms from settings
  backup.js               # pipeline: read → serialize → compress → encode → download
  compression.js          # feature-detect + compress/decompress helpers
  retention.js            # prune old snapshots (guarded)
  restore.js              # decompress + non-destructive tree recreate
options/
  options.html
  options.css             # CSS-variable theming + prefers-color-scheme
  options.js
icons/                    # 16, 32, 48, 128 px
```

---

## 7. Detailed behavior

### 7.1 Scheduling (`scheduler.js`)
- A single named alarm, e.g. `"bookmark-backup"`.
- On `runtime.onInstalled` **and** `runtime.onStartup`, and whenever settings change, re-arm:
  - Clear the existing alarm.
  - If `!enabled`, leave it cleared.
  - `interval` mode: `chrome.alarms.create("bookmark-backup", { periodInMinutes: intervalHours * 60 })`.
  - `daily` mode: compute ms until the next occurrence of `dailyTime`; `chrome.alarms.create("bookmark-backup", { when: nextTime, periodInMinutes: 1440 })`.
- `chrome.alarms.onAlarm` → if name matches and `enabled`, run the backup pipeline.
- Alarms reset on extension update/reload, so always re-arm on `onInstalled`.

### 7.2 Backup pipeline (`backup.js`)
1. `const tree = await chrome.bookmarks.getTree();`
2. Serialize: `JSON.stringify(tree)` (optionally pretty — but compressed output makes pretty-printing cheap; store compact to keep size down).
3. Choose format via `compression.js` (see 7.3) and compress the JSON string to a `Uint8Array`.
4. Base64-encode the bytes **in chunks** (§9) and build `data:application/octet-stream;base64,<b64>`.
5. Build the filename (7.4) and call:
   ```js
   chrome.downloads.download({
     url: dataUrl,
     filename: `${backupDir}/${name}`,
     saveAs: false,
     conflictAction: "uniquify",
   });
   ```
6. Record status in `chrome.storage.local` (success/error, filename, format, downloadId, timestamp), append to `backupLog`.
7. If retention is enabled, invoke `retention.js`.
8. On any error: record it, and if `notifyOnFailure`, raise a `chrome.notifications` notification.

### 7.3 Compression + fallback (`compression.js`)
- `supportsZstd()`: `try { new CompressionStream("zstd"); return true } catch { return false }`.
- `compress(str, mode)`:
  - resolve effective format: `none` → no compression; `gzip` → gzip; `auto` → zstd if supported else gzip.
  - compress via streams:
    ```js
    const cs = new CompressionStream(fmt); // "gzip" | "zstd"
    const stream = new Blob([str]).stream().pipeThrough(cs);
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    ```
  - return `{ bytes, format }` where `format ∈ {"zstd","gzip","none"}`.
- `decompress(bytes, format)` (for restore): mirror with `DecompressionStream`. If a `.zst` file is opened on a browser whose `DecompressionStream` lacks zstd, fail with a clear message (known limitation; see §11).

### 7.4 File naming & location (FR-4, FR-5)
- Name: `bookmarks-YYYYMMDD-HHmmss.json` plus extension by format: `.zst`, `.gz`, or none.
  - Example: `bookmarks-20260701-030000.json.zst`
- Path passed to `download`: `${backupDir}/${name}`, `backupDir` default `.chrome-bookmarks`.
- `conflictAction: "uniquify"` guarantees no overwrite even if two run in the same second.

### 7.5 Retention (`retention.js`, FR-11)
- Only ever operates on downloads **this extension created** (tracked via `downloadId` in `backupLog`) — never a blanket search of the user's downloads.
- When `retentionEnabled` and the count of tracked snapshots exceeds `retentionKeep`, for each oldest excess entry:
  - `chrome.downloads.removeFile(id)` (deletes file from disk), then `chrome.downloads.erase({ id })` (removes the history entry). Wrap each in try/catch — the file may already be gone.
  - Remove the entry from `backupLog`.
- Guard: never prune if `retentionKeep < 1` or `retentionEnabled` is false. Default configuration deletes nothing.

### 7.6 Restore (`restore.js`, FR-12)
- Runs in a page context (options or a dedicated restore view) where `FileReader`/`Blob` are available.
- User selects a backup file. Determine format from extension (`.zst`/`.gz`/`.json`), decompress, `JSON.parse`.
- Validate the parsed structure looks like a `chrome.bookmarks` tree (array with a root node containing `children`).
- Show a summary: number of folders and bookmarks found.
- On explicit confirm, create a new folder named `Bookmarks Restore <ISO timestamp>` under **Other Bookmarks** (`parentId: "2"`) and recursively recreate:
  - node with `children` and no `url` → `chrome.bookmarks.create({ parentId, title })`, recurse.
  - node with `url` → `chrome.bookmarks.create({ parentId, title, url })`.
- **Never** delete, move, or overwrite existing bookmarks. Recovery = the user drags what they need back out of the restore folder. This is deliberately the safest possible restore.

### 7.7 Options UI + theming (FR-9)
- Controls for every setting in §5, plus: "Back up now" button, current status display, and a "Restore from file" entry point.
- **Theming:** CSS custom properties with light values as default and a `@media (prefers-color-scheme: dark)` block overriding them. This makes `theme: "auto"` require no JavaScript. For manual override, set `data-theme="light"|"dark"` on `<html>` and provide CSS that keys off `[data-theme]` to beat the media query. Default is auto.
- Both themes must meet reasonable contrast; all controls keyboard-accessible and labeled.

---

## 8. Permissions / manifest

```json
{
  "manifest_version": 3,
  "name": "Bookmark Backup",
  "version": "1.0.0",
  "description": "Daily local, compressed backups of your bookmarks for recovery from accidental deletion.",
  "permissions": ["alarms", "bookmarks", "downloads", "storage", "notifications"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "options_page": "options/options.html",
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

- No `host_permissions`. No `content_scripts`.
- `notifications` only if FR-8 is implemented (it should be).
- Add `"offscreen"` **only** if the offscreen fallback in §9 is used.

---

## 9. Implementation notes & gotchas

- **Base64 in the worker:** do **not** do `btoa(String.fromCharCode(...bytes))` on a large array — it overflows the call stack. Encode in chunks (e.g. 0x8000 bytes per `String.fromCharCode` call) or use `Uint8Array.prototype.toBase64()` where available, with the chunked path as fallback.
- **Data-URL size:** base64 adds ~33%. Compressed bookmark JSON is small (bookmarks are highly compressible), so a `data:` URL is fine for the expected range. **Offscreen fallback:** if a user ever hits a size limit, create an offscreen document (`chrome.offscreen`, reason `BLOBS`/`DOM_PARSER`), have it `URL.createObjectURL(blob)`, pass the blob URL back to the worker for `download`, then revoke. Adds the `offscreen` permission and a document lifecycle; not needed for v1 unless size demands it.
- **Re-arm alarms on every settings change and on `onInstalled`/`onStartup`** — alarms don't survive updates.
- **Feature-detect zstd at runtime, per run** — cheap, and the answer can differ across the devices the user syncs settings to.
- **Surface errors loudly in status** — this is an unattended tool; silent failure is the main risk.

---

## 10. Non-functional requirements

- **Privacy:** zero network egress; verifiable by inspecting the code and by the absence of host permissions.
- **Robustness:** a failed run must not corrupt settings or the previous snapshot; it records an error and the next run proceeds.
- **Performance:** streaming compression handles large trees without freezing the worker.
- **Accessibility:** labeled controls, keyboard navigation, adequate contrast in both themes.
- **Footprint:** no third-party runtime dependencies required for v1 (compression is native).

---

## 11. Open decisions to confirm (flag before or during build)

1. **Backup format = full-tree JSON.** This preserves structure and `dateAdded`, and is what the in-extension restore consumes. Trade-off: Chrome's *native* "Import bookmarks" expects Netscape HTML, not JSON, so native import can't read these files — restore must go through this extension. If you also want a natively-importable copy, add an optional Netscape-HTML export alongside the JSON. **Recommended: JSON + in-extension restore for v1; HTML export as a later option.**
2. **Dot-directory default (`.chrome-bookmarks`).** Confirm Chrome accepts a leading-dot download subdir (test §G). If it strips the dot, either accept `chrome-bookmarks` (no dot) as the default or document the observed behavior. Note: the ChromeOS Files app hides dot-directories unless "show hidden files" is on.
3. **Retention default off.** For a backup tool, auto-deleting is risky; default is to keep everything. Confirm this is what you want.
4. **Daily default time `03:00`.** Because alarms only fire while Chrome runs, a machine that's off overnight will effectively back up on first launch after 03:00. Confirm the default or prefer interval mode.

---

## 12. Acceptance criteria

The build is done when every FR in §4 is demonstrably met via the corresponding section of the test plan, specifically:

- Scheduled and manual backups produce a valid, decompressible file in the configured directory (FR-1, FR-6; tests D–F).
- zstd is used when available and gzip otherwise, with correct extensions (FR-3; tests D, E).
- Directory is configurable and validated, and the dotted-default behavior is known and handled (FR-4; test G).
- Both schedule modes arm correct alarms and fire (FR-2; test H).
- Options page tracks light/dark with the browser and offers an override (FR-9; test B).
- Restore recreates a tree non-destructively (FR-12; test J).
- Failures are recorded and (optionally) notified; no silent failure (FR-8; test K).
- No network traffic is generated (FR-14; test N).
- Everything above also holds on ChromeOS (test M).
