# SPDX-License-Identifier: Apache-2.0
"""The screenshots of the README (docs/*.png), taken from the page against the mock Cockpit, in English,
with the server in Berlin: the overview light and dark, and the dialogs for run now, recorded runs,
conversion and backups.
Run: python3 test/docs_shots.py [DIR]   (needs Playwright with Chromium; DIR defaults to test/docs-shots)
CI runs it in the job test and keeps the pictures as the artifact docs-screenshots; `make docs-shots`
writes them to docs/."""
import atexit, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

here = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "docs-shots")
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get("PORT", "8773"))
BASE = f"http://127.0.0.1:{PORT}/pkg/cronjobs/index.html?lang=en&tz=Europe/Berlin"

srv = subprocess.Popen([sys.executable, os.path.join(here, "serve.py"), str(PORT)])
atexit.register(srv.terminate)
time.sleep(0.6)


def wait_js(page, expr, timeout=10):
    """CSP blocks eval-based wait_for_function; poll with evaluate instead."""
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate("() => !!(" + expr + ")"):
            return
        page.wait_for_timeout(40)
    raise TimeoutError("wait_js timed out: " + expr)


def open_page(browser, dark=False):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Europe/Berlin", locale="en-US")
    if dark:
        ctx.add_init_script("localStorage.setItem('shell:style', 'dark')")
    page = ctx.new_page()
    page.goto(BASE)
    wait_js(page, "document.querySelector('#meta').textContent.includes('Server time')")
    wait_js(page, "!document.querySelector('#reload').disabled")
    page.wait_for_timeout(300)
    return page


def picture(name):
    return os.path.join(OUT, name + ".png")


def dialog(page, dlg, name):
    page.wait_for_timeout(200)
    page.locator(f"#{dlg} .az-modal").screenshot(path=picture(name))


with sync_playwright() as p:
    browser = p.chromium.launch()
    for dark, name in ((False, "overview"), (True, "overview-dark")):
        page = open_page(browser, dark)
        page.screenshot(path=picture(name), full_page=True)
        page.context.close()

    page = open_page(browser)
    rows = page.locator("#root-body tbody tr")
    # the recorded runs of the first job, the output of the newest open
    rows.nth(0).locator("[data-key^='runs:']").click()
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 3")
    page.locator("#runs-body [data-key^='out:']").first.click()
    wait_js(page, "document.querySelector('#runs-body pre')")
    dialog(page, "runs-dlg", "runs")
    page.click("#runs-close-btn")
    # run now, with its output
    rows.nth(1).locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    dialog(page, "run-dlg", "run-now")
    page.click("#run-close-btn")
    # conversion to a systemd timer, checked
    rows.nth(1).locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Convert to systemd timer").click()
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    dialog(page, "conv-dlg", "convert")
    page.keyboard.press("Escape")
    # backups: two earlier versions, what restoring the older one changes
    page.evaluate("""() => {
        const now = Math.floor(Date.now() / 1000);
        const cur = window.__mock.root;
        const p = n => '/var/lib/cockpit-cronjobs/backups/root-' + n + '.crontab';
        window.__mock.backups = [
            { path: p('20261019-030000'), content: cur.replace('30 1 * * 0', '30 2 * * 0').replace(/^@reboot .*\\n/m, ''),
              mtime: now - 86400 * 2 },
            { path: p('20261020-210000'), content: cur.replace(/^@reboot .*\\n/m, ''), mtime: now - 3600 },
        ];
    }""")
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 2")
    page.click("[data-key='bk:root-20261019-030000.crontab']")
    wait_js(page, "document.querySelector('.cron-diff')")
    dialog(page, "bk-dlg", "backups")
    browser.close()
print("written to " + OUT + ": " + ", ".join(sorted(os.listdir(OUT))))
