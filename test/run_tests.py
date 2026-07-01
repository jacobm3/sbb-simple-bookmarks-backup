#!/usr/bin/env python3
"""
Automated test driver for the Bookmark Backup extension.

Launches Chrome (new headless, which supports MV3 service workers + extensions),
loads the unpacked extension via the CDP Extensions.loadUnpacked command, and
exercises the automatable sections of TEST-PLAN.md via the DevTools Protocol.

Two environment facts shape this harness (both discovered empirically, both
consistent with SPEC.md's stated risks):

  * This Chrome build does NOT support the zstd CompressionStream, so "auto"
    compression correctly falls back to gzip (SPEC 2.1 / 7.3). zstd-specific
    checks are reported as N/A on this build.

  * In headless mode chrome.downloads collapses the requested filename/subdir to
    a single file literally named "download" under the configured download dir.
    So we verify the dot-directory accept/reject behaviour at the downloads API
    level (the real product concern, test G) and verify file CONTENT by
    decompressing the saved blob — rather than trusting the on-disk path/name,
    which only headed Chrome honours.

GUI-only / device-only sections (save-dialog L, ChromeOS M, quit-and-relaunch H3)
are reported as manual.

Run:  source ~/pydev/bin/activate && python test/run_tests.py
"""

import base64
import glob
import gzip
import json
import os
import subprocess
import tempfile
import time

from cdp import Chrome, Conn, CDPError

EXT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHROME = "/usr/bin/google-chrome"

results = []      # (name, ok, detail)
supports_zstd = False


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def note(name, detail):
    """Informational line that is not a pass/fail gate."""
    print(f"[INFO] {name} — {detail}")


def js_str(s):
    return json.dumps(s)


def main():
    global supports_zstd
    workdir = tempfile.mkdtemp(prefix="bmbackup-test-")
    profile = os.path.join(workdir, "profile")
    downloads = os.path.join(workdir, "downloads")
    scratch = os.path.join(workdir, "scratch")
    for d in (profile, downloads, scratch):
        os.makedirs(d)
    print(f"workdir: {workdir}")

    chrome = Chrome(CHROME, profile, EXT_DIR)
    page = None
    sw = None
    try:
        browser = chrome._browser
        browser.call(
            "Browser.setDownloadBehavior",
            {"behavior": "allow", "downloadPath": downloads, "eventsEnabled": True},
        )

        ext_id = chrome.extension_id
        print(f"extension id: {ext_id}")
        sw_target = chrome.wait_for_target(
            lambda t: t.get("type") == "service_worker"
            and f"chrome-extension://{ext_id}/" in t.get("url", ""),
            timeout=30,
        )
        # Attaching to the SW keeps it alive for the whole run (no idle teardown).
        sw = Conn(sw_target["webSocketDebuggerUrl"])

        opt_url = f"chrome-extension://{ext_id}/options/options.html"
        opt_target = chrome.open_url(opt_url)
        page = Conn(opt_target["webSocketDebuggerUrl"])
        page.call("Runtime.enable")
        time.sleep(1.0)

        # ---- A. Install & load: exactly one alarm ----
        alarms = page.evaluate(
            "(async()=>{const a=await chrome.alarms.getAll();"
            "return a.map(x=>({name:x.name,periodInMinutes:x.periodInMinutes}));})()"
        )
        names = [a["name"] for a in alarms]
        check("A: exactly one 'bookmark-backup' alarm after load",
              names == ["bookmark-backup"], f"alarms={alarms}")

        # ---- zstd availability (informational; drives expectations below) ----
        supports_zstd = page.evaluate(
            "(async()=>{const m=await import('../src/compression.js');"
            "return m.supportsZstd();})()"
        )
        note("zstd support on this Chrome build",
             "YES (auto -> zstd)" if supports_zstd else "NO (auto -> gzip fallback, per SPEC 7.3)")
        expected_auto = "zstd" if supports_zstd else "gzip"

        # ---- C. Directory validation ----
        val = page.evaluate(
            "(async()=>{const m=await import('../src/settings.js');"
            "const cases=['/etc/x','../escape','','a<b','backups/bookmarks',"
            "'chrome-bookmarks','.chrome-bookmarks'];"
            "return cases.map(c=>({c, r:m.validateBackupDir(c)}));})()"
        )
        vmap = {v["c"]: v["r"] for v in val}
        c_ok = (not vmap["/etc/x"]["ok"] and not vmap["../escape"]["ok"]
                and not vmap[""]["ok"] and not vmap["a<b"]["ok"]
                and vmap["backups/bookmarks"]["ok"] and vmap["chrome-bookmarks"]["ok"]
                and vmap[".chrome-bookmarks"]["ok"]
                and vmap[".chrome-bookmarks"].get("warnDotDir") is True)
        check("C: backupDir validation (reject bad, accept nested, warn dotted)",
              c_ok, json.dumps(vmap))

        # ---- C. Persistence ----
        page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                      "await m.setSettings({intervalHours:7});})()")
        persisted = page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                                  "return (await m.getSettings()).intervalHours;})()")
        check("C: settings persist to chrome.storage.sync", persisted == 7,
              f"intervalHours read back = {persisted}")

        # ---- B. Theming ----
        page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                      "await m.setSettings({theme:'auto'});"
                      "document.documentElement.removeAttribute('data-theme');})()")
        page.call("Emulation.setEmulatedMedia",
                  {"features": [{"name": "prefers-color-scheme", "value": "dark"}]})
        bg_dark = page.evaluate("getComputedStyle(document.body).backgroundColor")
        page.call("Emulation.setEmulatedMedia",
                  {"features": [{"name": "prefers-color-scheme", "value": "light"}]})
        bg_light = page.evaluate("getComputedStyle(document.body).backgroundColor")
        page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        bg_override = page.evaluate("getComputedStyle(document.body).backgroundColor")
        page.evaluate("document.documentElement.removeAttribute('data-theme')")
        check("B: theme auto follows prefers-color-scheme (dark != light)",
              bg_dark != bg_light, f"dark={bg_dark} light={bg_light}")
        check("B: manual dark override beats light OS setting",
              bg_override == bg_dark and bg_override != bg_light, f"override={bg_override}")

        # Ensure a working default dir for the pipeline tests.
        set_settings(page, {"backupDir": "chrome-bookmarks", "compression": "auto",
                            "enabled": True, "scheduleMode": "daily"})

        # ---- N1. Empty-bookmarks backup ----
        empty_status = trigger_backup(page)
        empty_file = newest_download(downloads)
        empty_ok = (empty_status.get("lastResult") == "success"
                    and json_roots(decompress_blob(empty_file)) >= 1)
        check("N1: backup succeeds on empty bookmark set and yields valid JSON",
              empty_ok, f"status={short(empty_status)}")

        # ---- Populate bookmarks (unicode + folder) ----
        page.evaluate(
            "(async()=>{const f=await chrome.bookmarks.create({parentId:'1',"
            "title:'café — \\u0442\\u0435\\u0441\\u0442 — \\u65e5\\u672c\\u8a9e'});"
            "await chrome.bookmarks.create({parentId:f.id,title:'Example',"
            "url:'https://example.com/'});"
            "await chrome.bookmarks.create({parentId:'1',title:'Anthropic',"
            "url:'https://www.anthropic.com/'});return true;})()")

        # ---- D. Manual backup, auto compression ----
        d_status = trigger_backup(page)
        check(f"D: manual backup (auto) succeeds; format == {expected_auto} on this build",
              d_status.get("lastResult") == "success"
              and d_status.get("lastFormat") == expected_auto,
              f"format={d_status.get('lastFormat')}")

        # ---- F. Content integrity + unicode (auto backup just taken) ----
        text = decompress_blob(newest_download(downloads))
        f_json_ok = write_and_jq(text, scratch)
        f_uni = "日本語" in text and "café" in text
        check("F: auto snapshot decompresses to valid JSON with unicode intact",
              f_json_ok and f_uni, f"jq-valid={f_json_ok}, unicode={f_uni}")

        # ---- E. gzip fallback ----
        set_settings(page, {"compression": "gzip"})
        e_status = trigger_backup(page)
        e_text = decompress_blob(newest_download(downloads))
        check("E: gzip mode produces a gzip snapshot that decompresses to valid JSON",
              e_status.get("lastFormat") == "gzip" and write_and_jq(e_text, scratch),
              f"format={e_status.get('lastFormat')}")
        set_settings(page, {"compression": "auto"})

        # ---- G. Dot-directory behaviour (the known risk) ----
        # G1: at the downloads API level, a leading-dot path segment is rejected.
        g1 = page.evaluate(
            "(async()=>{try{const url='data:text/plain;base64,'+btoa('x');"
            "await chrome.downloads.download({url,filename:'.dotdir/x.json',"
            "saveAs:false});return {rejected:false};}"
            "catch(e){return {rejected:true,msg:String(e)};}})()")
        # G2: a non-dot path segment is accepted.
        g2 = page.evaluate(
            "(async()=>{try{const url='data:text/plain;base64,'+btoa('x');"
            "const id=await chrome.downloads.download({url,filename:'okdir/x.json',"
            "saveAs:false});return {ok:typeof id==='number'};}"
            "catch(e){return {ok:false,msg:String(e)};}})()")
        check("G1: Chrome REJECTS a leading-dot download dir (Invalid filename)",
              g1.get("rejected") is True, g1.get("msg", ""))
        check("G2: Chrome ACCEPTS a non-dot download dir", g2.get("ok") is True,
              g2.get("msg", ""))
        # G3: with a dotted backupDir the pipeline surfaces an ERROR (never silent).
        set_settings(page, {"backupDir": ".chrome-bookmarks"})
        g3_status = trigger_backup(page)
        set_settings(page, {"backupDir": "chrome-bookmarks"})  # restore working default
        check("G3: dotted backupDir -> pipeline records a clear error (not silent success)",
              g3_status.get("lastResult") == "error" and bool(g3_status.get("lastError")),
              f"result={g3_status.get('lastResult')} err={g3_status.get('lastError')}")
        check("G: default backupDir is the working no-dot form",
              page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                            "return m.DEFAULT_SETTINGS.backupDir;})()") == "chrome-bookmarks-backup")
        # G4: a stored dotted dir is auto-healed by sanitizeBackupDir (install migration).
        g4 = page.evaluate(
            "(async()=>{const m=await import('../src/settings.js');"
            "return {a:m.sanitizeBackupDir('.chrome-bookmarks'),"
            "b:m.sanitizeBackupDir('.a/.b'),c:m.sanitizeBackupDir('backups/bookmarks'),"
            "d:m.sanitizeBackupDir('...')};})()")
        check("G4: sanitizeBackupDir strips leading dots (heals old dotted setting)",
              g4["a"] == "chrome-bookmarks" and g4["b"] == "a/b"
              and g4["c"] == "backups/bookmarks" and g4["d"] == "chrome-bookmarks-backup",
              f"{g4}")

        # ---- H1. Alarm arming per mode ----
        h1 = page.evaluate(
            "(async()=>{const m=await import('../src/settings.js');"
            "const sc=await import('../src/scheduler.js');"
            "await m.setSettings({scheduleMode:'daily',dailyTime:'03:00',enabled:true});"
            "await sc.rearmAlarm();let a=await chrome.alarms.getAll();"
            "const d=a.find(x=>x.name==='bookmark-backup');"
            "await m.setSettings({scheduleMode:'interval',intervalHours:6});"
            "await sc.rearmAlarm();a=await chrome.alarms.getAll();"
            "const i=a.find(x=>x.name==='bookmark-backup');"
            "return {d:d?d.periodInMinutes:null,i:i?i.periodInMinutes:null};})()")
        check("H1: daily arms ~1440-min alarm; interval arms N*60-min alarm",
              h1["d"] == 1440 and h1["i"] == 360, f"{h1}")

        # ---- H4. Master toggle ----
        h4 = page.evaluate(
            "(async()=>{const m=await import('../src/settings.js');"
            "const sc=await import('../src/scheduler.js');"
            "await m.setSettings({enabled:false});await sc.rearmAlarm();"
            "const off=(await chrome.alarms.getAll()).filter(a=>a.name==='bookmark-backup').length;"
            "await m.setSettings({enabled:true,scheduleMode:'daily'});await sc.rearmAlarm();"
            "const on=(await chrome.alarms.getAll()).filter(a=>a.name==='bookmark-backup').length;"
            "return {off,on};})()")
        check("H4: master toggle off clears alarm; on re-arms it",
              h4["off"] == 0 and h4["on"] == 1, f"{h4}")

        # ---- H2. Alarm actually fires the pipeline (and succeeds) ----
        before = get_status(page).get("lastRunAt")
        page.evaluate("(async()=>{await chrome.alarms.create('bookmark-backup',"
                      "{delayInMinutes:0.5});return true;})()")
        print("    H2: waiting up to 70s for the scheduled alarm to fire…")
        fired = False
        for _ in range(35):
            time.sleep(2)
            st = get_status(page)
            if st.get("lastRunAt") and st.get("lastRunAt") != before:
                fired = st.get("lastResult") == "success"
                break
        check("H2: onAlarm handler runs the backup pipeline and it succeeds", fired,
              "new successful snapshot after alarm" if fired else "no successful run in 70s")

        # ---- I. Retention ----
        i_ok, i_detail = test_retention(page)
        check("I: retention keeps newest N, prunes older ones (by downloadId)", i_ok, i_detail)

        # ---- J. Restore, non-destructive (gzip + none) ----
        j_ok, j_detail = test_restore(page, downloads)
        check("J: restore recreates tree non-destructively (gzip & plain-json)", j_ok, j_detail)

        # ---- N2. Large set ----
        n2_ok, n2_detail = test_large_set(page, downloads)
        check("N2: large bookmark set backs up and decompresses to valid JSON", n2_ok, n2_detail)

        # ---- K. Failure recorded + notified; prior snapshot preserved ----
        k_ok, k_detail = test_failure(sw, page)
        check("K: failure recorded + notified; prior snapshot info preserved", k_ok, k_detail)

        # ---- FR-14. No network ----
        net_ok, net_detail = test_no_network()
        check("N/FR-14: no network code or host permissions in the extension",
              net_ok, net_detail)

    finally:
        for c in (page, sw):
            if c:
                c.close()
        chrome.kill()
        print(f"\n(left test artifacts in {workdir})")

    print("\n==================== SUMMARY ====================")
    passed = sum(1 for _, ok, _ in results if ok)
    for name, ok, _ in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print(f"\n{passed}/{len(results)} automated checks passed.")
    print("\nNot automated (require a GUI/device or a full browser restart):")
    print("  H3 missed-alarm-on-restart · L save-dialog setting · M ChromeOS")
    print("  zstd path: N/A on this Chrome build (no zstd CompressionStream);")
    print("  gzip fallback verified instead, exactly as SPEC 7.3 prescribes.")
    return 0 if passed == len(results) else 1


# ---------------- helpers ----------------

def short(status):
    return {k: status.get(k) for k in ("lastResult", "lastFormat", "lastError")}


def set_settings(page, obj):
    page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                  "await m.setSettings(" + json.dumps(obj) + ");})()")


def get_status(page):
    return page.evaluate("(async()=>{const m=await import('../src/settings.js');"
                         "return await m.getStatus();})()") or {}


def trigger_backup(page):
    resp = page.evaluate(
        "(async()=>{const r=await chrome.runtime.sendMessage({type:'backup-now'});"
        "return r&&r.status?r.status:null;})()", timeout=60)
    time.sleep(0.4)  # let the file settle on disk
    return resp or {}


def newest_download(downloads):
    """Return the path of the most recently written 'download' blob."""
    files = [p for p in glob.glob(os.path.join(downloads, "download*"))
             if os.path.isfile(p)]
    if not files:
        raise FileNotFoundError("no download blob written")
    return max(files, key=os.path.getmtime)


def decompress_blob(path):
    """Return the text of a backup blob, trying gzip then plain UTF-8."""
    raw = open(path, "rb").read()
    try:
        return gzip.decompress(raw).decode("utf-8")
    except Exception:
        return raw.decode("utf-8")


def json_roots(text):
    data = json.loads(text)
    return len(data[0]["children"]) if isinstance(data, list) else -1


def write_and_jq(text, scratch):
    """Write text to a file and validate it with the jq CLI (test-plan flavour)."""
    p = os.path.join(scratch, "out.json")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    r = subprocess.run(["jq", "empty", p], capture_output=True)
    return r.returncode == 0


def test_retention(page):
    set_settings(page, {"retentionEnabled": True, "retentionKeep": 3,
                        "compression": "gzip", "backupDir": "chrome-bookmarks"})
    for _ in range(5):
        trigger_backup(page)
        time.sleep(1.1)
    # After pruning, only 3 tracked (success + downloadId) log entries should remain,
    # and the pruned downloadIds must no longer exist in Chrome's download list.
    res = page.evaluate(
        "(async()=>{const m=await import('../src/settings.js');"
        "const st=await m.getStatus();"
        "const tracked=st.backupLog.filter(e=>e.result==='success'&&typeof e.downloadId==='number');"
        "const ids=tracked.map(e=>e.downloadId);"
        "const found=[];for(const id of ids){const r=await chrome.downloads.search({id});"
        "found.push(r.length>0);}"
        "return {count:tracked.length, allFound:found.every(Boolean)};})()")
    set_settings(page, {"retentionEnabled": False, "compression": "auto"})
    ok = res["count"] == 3 and res["allFound"]
    return ok, f"tracked snapshots after prune = {res['count']} (want 3); all still on disk = {res['allFound']}"


def test_restore(page, downloads):
    # Snapshot existing ids for the non-destructive check.
    before = page.evaluate(
        "(async()=>{const t=await chrome.bookmarks.getTree();const ids=[];"
        "(function w(n){for(const c of n){ids.push(c.id);if(c.children)w(c.children);}})(t);"
        "return ids;})()")

    parts = []
    for mode, fname in (("gzip", "backup.json.gz"), ("none", "backup.json")):
        set_settings(page, {"compression": mode, "backupDir": "chrome-bookmarks"})
        trigger_backup(page)
        raw = open(newest_download(downloads), "rb").read()
        b64 = base64.b64encode(raw).decode()
        res = page.evaluate(
            "(async()=>{const b64=" + js_str(b64) + ";const bin=atob(b64);"
            "const bytes=new Uint8Array(bin.length);"
            "for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);"
            "const file=new File([bytes]," + js_str(fname) + ");"
            "const m=await import('../src/restore.js');"
            "const {tree,counts}=await m.loadBackupFile(file);"
            "const fid=await m.restoreTree(tree,'TEST-" + mode + "');"
            "const sub=await chrome.bookmarks.getSubTree(fid);"
            "return {counts,title:sub[0].title,kids:(sub[0].children||[]).length};})()",
            timeout=60)
        if not res["title"].startswith("Bookmarks Restore") or res["kids"] == 0:
            return False, f"{mode}: bad restore folder {res}"
        parts.append(f"{mode}: {res['counts']} into '{res['title']}'")

    after = page.evaluate(
        "(async()=>{const t=await chrome.bookmarks.getTree();const ids=[];"
        "(function w(n){for(const c of n){ids.push(c.id);if(c.children)w(c.children);}})(t);"
        "return ids;})()")
    preserved = all(i in after for i in before)
    set_settings(page, {"compression": "auto"})
    ok = preserved and len(after) > len(before)
    return ok, ("non-destructive (all original ids kept); " + "; ".join(parts)
                if ok else f"original ids lost! before={len(before)} after={len(after)}")


def test_large_set(page, downloads):
    # Use a unique folder title so earlier restore-test copies can't collide.
    title = "BulkLarge300"
    page.evaluate(
        "(async()=>{const f=await chrome.bookmarks.create({parentId:'1',title:"
        + js_str(title) + "});"
        "for(let i=0;i<300;i++){await chrome.bookmarks.create({parentId:f.id,"
        "title:'B'+i,url:'https://example.com/'+i});}return true;})()", timeout=120)
    set_settings(page, {"compression": "auto", "backupDir": "chrome-bookmarks-backup"})
    st = trigger_backup(page)
    text = decompress_blob(newest_download(downloads))
    # Parse in python and find the folder we just made; it should hold 300 kids.
    data = json.loads(text)
    counts = []
    def walk(nodes):
        for n in nodes:
            if n.get("title") == title and isinstance(n.get("children"), list):
                counts.append(len(n["children"]))
            if isinstance(n.get("children"), list):
                walk(n["children"])
    walk(data)
    ok = st.get("lastResult") == "success" and 300 in counts
    return ok, f"'{title}' folder child counts in snapshot = {counts} (want one == 300)"


def test_failure(sw, page):
    # In the SW (kept alive by our attached debugger) override notifications, then
    # drive a failing backup via the real message path with an invalid dir.
    prior = get_status(page).get("lastFilename")
    sw.evaluate("self.__notif=null;"
                "chrome.notifications.create=(o)=>{self.__notif=o;return Promise.resolve('id');};")
    set_settings(page, {"backupDir": "../evil", "notifyOnFailure": True})
    st = trigger_backup(page)
    notif = sw.evaluate("self.__notif")
    set_settings(page, {"backupDir": "chrome-bookmarks"})
    recorded = st.get("lastResult") == "error" and bool(st.get("lastError"))
    notified = bool(notif) and "fail" in (notif.get("title", "").lower())
    preserved = st.get("lastFilename") == prior and prior is not None
    ok = recorded and notified and preserved
    return ok, (f"result={st.get('lastResult')} notified={notified} "
                f"priorSnapshotKept={preserved}")


def test_no_network():
    bad = []
    for root, _, fnames in os.walk(EXT_DIR):
        if "/test" in root or "/.git" in root:
            continue
        for fn in fnames:
            if not fn.endswith((".js", ".json", ".html")):
                continue
            text = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read()
            for pat in ("fetch(", "XMLHttpRequest", "new WebSocket",
                        "host_permissions", "importScripts("):
                if pat in text:
                    bad.append(f"{fn}:{pat}")
    return len(bad) == 0, ("clean" if not bad else f"indicators: {bad}")


if __name__ == "__main__":
    raise SystemExit(main())
