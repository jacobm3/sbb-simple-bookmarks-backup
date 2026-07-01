"""
Minimal Chrome DevTools Protocol (CDP) helper over a raw websocket.

We use this instead of Playwright/Puppeteer because there is no Node on this box.
It is deliberately tiny: launch Chrome with remote debugging, list targets, open
a websocket to a target, and run CDP methods (mainly Runtime.evaluate).
"""

import json
import subprocess
import time
import itertools
import requests
import websocket


class CDPError(Exception):
    pass


class Conn:
    """A websocket connection to one CDP target (a page, or a service worker)."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None)
        self.ids = itertools.count(1)

    def call(self, method, params=None, timeout=60):
        """Send a CDP command and wait for its matching response."""
        msg_id = next(self.ids)
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        # Read messages until we get the one matching our id (skip events).
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(deadline - time.time())
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise CDPError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise CDPError(f"timeout waiting for {method}")

    def evaluate(self, expression, timeout=60):
        """Run JS in the target and return the value. Awaits promises.

        The expression should be an async IIFE or plain expression that returns a
        JSON-serializable value. Throws CDPError on a JS exception.
        """
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            exc = result["exceptionDetails"]
            desc = exc.get("exception", {}).get("description") or json.dumps(exc)
            raise CDPError("JS exception: " + desc)
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


class Chrome:
    """Launches Chrome with remote debugging and exposes target discovery."""

    def __init__(self, chrome_path, user_data_dir, extension_dir, port=9222):
        self.port = port
        self.extension_dir = extension_dir
        args = [
            chrome_path,
            "--headless=new",                       # new headless supports MV3 SWs + extensions
            f"--remote-debugging-port={port}",
            "--remote-allow-origins=*",              # allow our websocket handshake
            f"--user-data-dir={user_data_dir}",
            # Chrome 137+ removed the --load-extension switch from the branded build.
            # We instead load the unpacked extension via the CDP Extensions.loadUnpacked
            # command, which this flag re-enables over the debugging endpoint.
            "--enable-unsafe-extension-debugging",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-features=DialMediaRouteProvider",
            "about:blank",
        ]
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        self._wait_ready()
        # Load our unpacked extension via CDP (see comment above).
        self._browser = Conn(self.browser_ws())
        self.extension_id = self._browser.call(
            "Extensions.loadUnpacked", {"path": extension_dir}
        )["id"]

    def _wait_ready(self, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                requests.get(f"http://localhost:{self.port}/json/version", timeout=2)
                return
            except Exception:
                time.sleep(0.3)
        raise CDPError("Chrome did not become ready")

    def browser_ws(self):
        v = requests.get(f"http://localhost:{self.port}/json/version", timeout=5).json()
        return v["webSocketDebuggerUrl"]

    def targets(self):
        return requests.get(f"http://localhost:{self.port}/json", timeout=5).json()

    def wait_for_target(self, predicate, timeout=30):
        """Poll the target list until predicate(target) is true."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            for t in self.targets():
                if predicate(t):
                    return t
            time.sleep(0.3)
        raise CDPError("target not found in time")

    def open_url(self, url):
        """Open a new tab at url and return its target dict."""
        requests.put(f"http://localhost:{self.port}/json/new?{url}", timeout=5)
        return self.wait_for_target(lambda t: t.get("url", "").startswith(url.split("#")[0]))

    def kill(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
