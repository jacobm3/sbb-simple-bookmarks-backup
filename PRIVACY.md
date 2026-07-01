# Privacy Policy — SBB - Simple Bookmarks Backup

_Last updated: July 1, 2026_

Simple Bookmarks Backup is a Chrome extension that saves compressed, timestamped
snapshots of your bookmarks to a folder in your own Downloads directory, and can
restore them. This policy explains exactly what the extension does with your data.

## The short version

- The extension does **not** collect, transmit, sell, or share any of your data.
- It makes **no network requests** of any kind.
- Everything it reads or writes stays **on your own device**.
- There are no analytics, no tracking, no remote servers, and no third parties.

## What data the extension accesses

To do its job the extension reads and writes the following, all locally:

- **Your bookmarks.** It reads your bookmark tree to create a backup, and (only
  when you explicitly run a restore) it creates new bookmarks from a backup file.
  Restore is non-destructive: it adds a new folder and never deletes, moves, or
  overwrites your existing bookmarks.
- **Backup files.** Snapshots are written to a folder inside your browser's
  Downloads directory (default `chrome-bookmarks-backup`). These files live on
  your device. If you have separately configured your Downloads folder to sync to
  a cloud service, that is your own setup and outside this extension's control.
- **Your settings and run status.** Your preferences (schedule, directory,
  compression, etc.) are stored using Chrome's extension storage. Settings use
  `chrome.storage.sync`, which Chrome may sync across your own signed-in devices;
  this is handled entirely by Chrome, not by us, and is never sent to the
  developer. Per-device status (last run time, last result) is stored locally.

## What data is sent off your device

**None.** The extension has no server, makes no network calls, and contains no
remote or third-party code. It requests no host permissions, so it cannot contact
any website.

## Permissions and why they are needed

- **bookmarks** — read your bookmarks to back them up; create bookmarks on restore.
- **downloads** — write backup files into your Downloads folder.
- **alarms** — trigger backups on your chosen schedule.
- **storage** — save your settings and the last-run status.
- **notifications** — show a desktop notification if a backup fails.

## Data retention and deletion

- Backup files remain on your device until you delete them, or until the optional
  retention feature (off by default) prunes older snapshots you created.
- Uninstalling the extension removes its settings and status. Backup files already
  written to your Downloads folder are yours and are not removed by uninstalling.

## Children's privacy

The extension collects no personal information from anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be posted at the same location
with a new "Last updated" date.

## Contact

Questions about this policy can be directed to the developer through the extension's
Chrome Web Store listing support channel.
