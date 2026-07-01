#!/usr/bin/env python3
"""
Render the extension's options page in headless Chrome and save a 1280x800 PNG
suitable for the Chrome Web Store listing. Populates a realistic "last backup
succeeded" status and a couple of sample bookmarks so the page looks representative.

Run: source ~/pydev/bin/activate && python test/screenshot.py [light|dark]
"""

import base64
import os
import sys
import time

from cdp import Chrome, Conn

EXT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHROME = "/usr/bin/google-chrome"
OUT = os.path.join(EXT_DIR, "store-assets")

W, H = 1280, 800


def main():
    theme = sys.argv[1] if len(sys.argv) > 1 else "light"
    os.makedirs(OUT, exist_ok=True)
    import tempfile
    prof = tempfile.mkdtemp(prefix="shot-")

    chrome = Chrome(CHROME, prof, EXT_DIR)
    try:
        ext_id = chrome.extension_id
        opt = chrome.open_url(f"chrome-extension://{ext_id}/options/options.html")
        page = Conn(opt["webSocketDebuggerUrl"])
        page.call("Page.enable")
        page.call("Runtime.enable")
        # Size the viewport to the store's 1280x800 requirement.
        page.call("Emulation.setDeviceMetricsOverride",
                  {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
        # Force the requested theme so the screenshot is deterministic.
        page.call("Emulation.setEmulatedMedia",
                  {"features": [{"name": "prefers-color-scheme", "value": theme}]})
        time.sleep(0.6)

        # Add a couple of sample bookmarks and a realistic success status so the
        # status card isn't empty in the shot.
        page.evaluate(
            "(async()=>{"
            "await chrome.bookmarks.create({parentId:'1',title:'Recipes'});"
            "await chrome.bookmarks.create({parentId:'1',title:'Anthropic',"
            "url:'https://www.anthropic.com/'});"
            "await chrome.storage.local.set({"
            "lastRunAt:Date.parse('2026-07-01T03:00:00'),lastResult:'success',"
            "lastError:null,"
            "lastFilename:'chrome-bookmarks-backup/bookmarks-20260701-030000.json.gz',"
            "lastFormat:'gzip'});"
            "return true;})()")
        # options.js refreshes on storage change; give it a beat, then also nudge.
        time.sleep(0.8)

        shot = page.call("Page.captureScreenshot",
                         {"format": "png",
                          "clip": {"x": 0, "y": 0, "width": W, "height": H, "scale": 1},
                          "captureBeyondViewport": True})
        path = os.path.join(OUT, f"screenshot-{theme}-1280x800.png")
        with open(path, "wb") as f:
            f.write(base64.b64decode(shot["data"]))
        print("wrote", path)
        page.close()
    finally:
        chrome.kill()


if __name__ == "__main__":
    main()
