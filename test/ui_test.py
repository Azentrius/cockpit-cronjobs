# SPDX-License-Identifier: Apache-2.0
"""Browser tests for Cron Jobs against the mock Cockpit (with Cockpit's strict CSP).
Run: python3 test/ui_test.py   (needs Playwright with Chromium)"""
import atexit, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

here = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(here, "shots")
os.makedirs(SHOTS, exist_ok=True)
PORT = int(os.environ.get("PORT", "8772"))
BASE = f"http://127.0.0.1:{PORT}/pkg/cronjobs/index.html"
WRAP = "/usr/local/libexec/cockpit-cronjobs-run"
with open(os.path.join(here, "..", "src", "app.js"), encoding="utf-8") as f:
    VERSION = re.search(r'const VERSION = "([^"]+)";', f.read()).group(1)

srv = subprocess.Popen([sys.executable, os.path.join(here, "serve.py"), str(PORT)])
atexit.register(srv.terminate)
time.sleep(0.6)

failures = []
passed = 0


def check(cond, msg):
    global passed
    if cond:
        passed += 1
    else:
        failures.append(msg)
        print("FAIL:", msg)
        if os.environ.get("GITHUB_ACTIONS"):
            # Shows up as an annotation on the check run, readable without the full log.
            print("::error title=Browser test::" + msg.replace("\n", " ")[:900])


def wait_js(page, expr, timeout=10):
    """CSP blocks eval-based wait_for_function; poll with evaluate instead."""
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate("() => !!(" + expr + ")"):
            return True
        page.wait_for_timeout(40)
    raise TimeoutError("wait_js timed out: " + expr)


def open_page(browser, query="", width=1280, height=900, dark=False, cookie=None, storage_lang=None):
    ctx = browser.new_context(viewport={"width": width, "height": height}, timezone_id="Europe/Berlin", locale="de-DE")
    if dark:
        ctx.add_init_script("localStorage.setItem('shell:style', 'dark')")
    if cookie:
        ctx.add_cookies([{"name": "CockpitLang", "value": cookie, "url": f"http://127.0.0.1:{PORT}/"}])
    if storage_lang:
        ctx.add_init_script(f"localStorage.setItem('cockpit.lang', '{storage_lang}')")
    page = ctx.new_page()
    page.problems = []
    page.on("console", lambda m: page.problems.append(m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: page.problems.append("pageerror: " + str(e)))
    page.goto(BASE + ("?" + query if query else ""))
    wait_js(page, "document.querySelector('#meta').textContent.includes('Serverzeit') || "
                  "document.querySelector('#meta').textContent.includes('Server time') || "
                  "document.querySelector('#root-body .az-empty')")
    wait_idle(page)
    return page


def mock(page, expr):
    return page.evaluate("() => window.__mock." + expr)


def root_text(page):
    return page.evaluate("() => window.__mock.root")


def wait_idle(page):
    wait_js(page, "!document.querySelector('#reload').disabled")
    page.wait_for_timeout(120)


def row(page, n):
    return page.locator("#root-body tbody tr").nth(n)


def changed_lines(before, after):
    a, b = before.split("\n"), after.split("\n")
    return [(x, y) for x, y in zip(a, b) if x != y] if len(a) == len(b) else ("length", len(a), len(b))


def shot(page, name, full=True):
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=full)


def reload_with_root(page, text):
    page.evaluate("t => { window.__mock.root = t; }", text)
    page.click("#reload")
    wait_idle(page)


def focused_key(page):
    return page.evaluate("() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null")


def show_tab(page, name):
    """overview, timers or system"""
    page.click("#tab-" + name)
    wait_js(page, "!document.querySelector('#panel-" + name + "').hidden")


def selected_tab(page):
    return page.evaluate("() => document.querySelector('#tabs [aria-selected=\"true\"]').id")


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- overview: light, dark, narrow ----------
    page = open_page(browser)
    body = page.inner_text("body")
    # the page frame: a one-line header without a description, Refresh as the only filled button
    check(page.locator(".az-page-desc, #page-desc").count() == 0, "no description in the header")
    check(page.inner_text(".az-page-header h1").strip() == "Cron Jobs" and page.locator(".az-page-title__suffix").count() == 0,
          "title Cron Jobs without a suffix")
    refresh = page.evaluate("""() => { const b = document.querySelector('#reload');
        return { cls: b.className, icon: b.firstElementChild.matches('svg.az-icon'), text: b.innerText.trim(),
                 meta: b.previousElementSibling.matches('.az-meta'), inHeader: !!b.closest('.az-page-header') }; }""")
    check(refresh == {"cls": "az-btn az-btn--primary", "icon": True, "text": "Aktualisieren", "meta": True, "inHeader": True},
          "Refresh: primary, icon on the left, the state next to it: " + repr(refresh))
    filled = page.evaluate("() => Array.from(document.querySelectorAll('.az-btn--primary')).filter(b => !b.closest('.az-backdrop')).map(b => b.id)")
    check(filled == ["reload"], "no other az-btn--primary outside dialogs: " + repr(filled))
    check(page.get_attribute("#add", "class") == "az-btn az-btn--secondary az-btn--sm", "Add job is an outlined small button")
    check(selected_tab(page) == "tab-overview" and not page.locator("#panel-overview").is_hidden() and
          page.locator("#panel-timers").is_hidden() and page.locator("#panel-system").is_hidden(), "Overview is shown on opening")
    order = page.evaluate("""() => { const t = document.querySelector('#tabs');
        return [t.previousElementSibling.className, t.nextElementSibling.id, t.nextElementSibling.nextElementSibling.id,
                t.nextElementSibling.nextElementSibling.nextElementSibling.id,
                ['notices', 'alerts', 'sys-alerts'].some(id => document.getElementById(id).closest('[role=tabpanel]'))]; }""")
    check(order == ["az-page-header", "notices", "alerts", "sys-alerts", False],
          "tabs right under the header, messages right under the tabs, outside the panels: " + repr(order))
    check("Am 2. jedes Monats um 03:00" in body, "describe monthly")
    check("Sonntags um 01:30" in body, "describe weekly")
    check("Montags um 05:00" in body, "disabled job shown (old marker)")
    check("Alle 10 Minuten" in body, "describe every 10 minutes")
    check("Beim Systemstart" in body and "Beim nächsten Start" in body, "@reboot")
    check("GeoIP database for Plausible" in body, "comment note shown")
    check(page.locator("b").count() == 0 and "<b>not bold</b>" in body, "command is escaped")
    check("Serverzeit UTC" in page.inner_text("#meta"), "server tz in meta")
    check(page.locator("#root-body tbody tr").count() == 5, "5 root jobs")
    check(page.locator("#root-body tr.is-off").count() == 1, "1 disabled row")
    check("/opt/plausible/update-geoip.sh" in row(page, 0).inner_text() and WRAP not in row(page, 0).inner_text(),
          "captured job shows the plain command")
    check("Fehler · Exit 1" in row(page, 0).inner_text(), "last run of captured job")
    check("Nicht erfasst" in row(page, 1).inner_text() and row(page, 1).locator("[data-key='capture:25']").count() == 1,
          "not recorded + record link")
    check(row(page, 2).locator("td[data-last]").inner_text().strip() == "—", "disabled, not recorded: dash")
    check("/home/eve/run.sh" not in page.inner_text("#tl-card"), "skipped cron.d file not in timeline")
    check(f"Cron Jobs {VERSION}" in page.inner_text("footer"), "signature version")
    check(re.search(r"Ortszeit", page.inner_text("#root-body")) is not None, "local time hint (browser Berlin, server UTC)")
    check(page.inner_text("#notices").strip() == "", "no notices on a healthy server")
    # timeline
    tl = page.inner_text("#tl-card")
    check(not page.locator("#tl-card").is_hidden(), "timeline visible")
    for name in ["cron.hourly", "certbot", "apt-daily.timer", "logrotate.timer", "cron.php"]:
        check(name in tl, "timeline row " + name)
    check("sysstat.dpkg-old" not in tl, "ignored cron.d file not in timeline")
    check("motd-news.timer" not in tl, "inactive timer not in timeline")
    check("gleichzeitig" in tl, "overlap hint")
    check(page.locator(".cron-tl-band").count() >= 2, "frequent jobs as band")
    check(page.locator(".cron-tl-mark.is-timer:not(.is-legend)").count() >= 3, "timer marks")
    check(page.locator(".cron-tl-midnight").count() == 1, "midnight line")
    light = page.evaluate("""() => { const r = getComputedStyle(document.querySelector('#reload'));
        const t = getComputedStyle(document.querySelector('#tab-overview'));
        return [r.backgroundColor, t.color, t.borderBottomColor]; }""")
    check(light == ["rgb(10, 10, 15)", "rgb(10, 10, 15)", "rgb(125, 95, 34)"],
          "light: Refresh in ink, selected tab in ink with a bronze line: " + repr(light))
    shot(page, "de-light-1280")
    # System tab: /etc/crontab, /etc/cron.d, other users, periodic scripts
    show_tab(page, "system")
    check(page.locator("#crond-body .az-label--warning").count() == 2, "ignored cron.d files flagged (name, owner)")
    check(page.locator("#crond-body .az-label--warning").nth(1).get_attribute("title").startswith("cron überspringt diese Datei, weil"),
          "owner reason as hint")
    check(not page.locator("#etc-card").is_hidden() and not page.locator("#crond-card").is_hidden(), "/etc/crontab and /etc/cron.d")
    check(not page.locator("#users-card").is_hidden() and "www-data" in page.inner_text("#users-body"), "users card")
    check("logrotate" in page.inner_text("#periodic-body") and "keine" in page.inner_text("#periodic-body"), "periodic scripts")
    check(page.locator("#tl-card").is_hidden() and page.locator("#timers-card").is_hidden(), "only the System cards")
    shot(page, "de-light-1280-system")
    # timers
    show_tab(page, "timers")
    tm = page.inner_text("#timers-card")
    check(page.locator("#timers-body tbody tr").count() == 6, "6 timers")
    check("aus der root-Crontab übernommen" in tm, "converted timer recognised")
    check("Fehler · Exit 32" in tm and "Läuft" in tm and "Nicht aktiv" in tm, "timer states")
    check("Täglich um 06:00 und 18:00, zufällig verzögert" in tm, "timer described")
    check("15min nach dem Systemstart" in tm, "monotonic timer described")
    page.locator("#timers-body tbody tr", has_text="apt-daily.timer").locator("button").click()
    check(mock(page, "jumps[0][0]") == "/system/services#/apt-daily.timer", "open timer in Cockpit")
    fonts = page.evaluate("() => document.fonts.check('15px \"DM Sans\"') && document.fonts.check('16px \"DM Serif Display\"')")
    check(fonts, "fonts available")
    loaded = page.evaluate("() => Array.from(document.fonts).filter(f => f.status === 'loaded').map(f => f.family)")
    check(any("DM Sans" in f for f in loaded), "DM Sans loaded: " + repr(loaded))
    check(not page.evaluate("() => document.documentElement.classList.contains('pf-v6-theme-dark')"), "light theme")
    shot(page, "de-light-1280-timers")
    check(not page.problems, "no console problems (light): " + repr(page.problems))
    page.context.close()

    page = open_page(browser, dark=True)
    check(page.evaluate("() => document.documentElement.classList.contains('pf-v6-theme-dark')"), "dark class set")
    bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    check(bg == "rgb(10, 10, 15)", "dark background (Azentrius ink) " + bg)
    pbg = page.evaluate("() => getComputedStyle(document.querySelector('#reload')).backgroundColor")
    check(pbg == "rgb(200, 169, 110)", "Refresh gold in dark " + pbg)
    sel = page.evaluate("() => { const s = getComputedStyle(document.querySelector('#tab-overview')); return [s.color, s.borderBottomColor]; }")
    check(sel == ["rgb(200, 169, 110)", "rgb(200, 169, 110)"], "selected tab gold in dark: " + repr(sel))
    shot(page, "de-dark-1280")
    show_tab(page, "system")
    shot(page, "de-dark-1280-system")
    page.evaluate("() => window.dispatchEvent(new CustomEvent('cockpit-style', { detail: { style: 'light' } }))")
    check(not page.evaluate("() => document.documentElement.classList.contains('pf-v6-theme-dark')"), "cockpit-style event switches")
    check(not page.problems, "no console problems (dark): " + repr(page.problems))
    page.context.close()

    for dark in (False, True):
        page = open_page(browser, width=390, height=844, dark=dark)
        sw = page.evaluate("() => document.documentElement.scrollWidth")
        check(sw <= 390, f"no horizontal scroll on mobile ({sw}, dark={dark})")
        small = page.evaluate("""() => Array.from(document.querySelectorAll('button, .az-switch'))
            .filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.textContent || b.className)""")
        check(not small, "touch targets >= 44px: " + repr(small))
        row(page, 0).locator("[data-key^=more]").click()
        msmall = page.evaluate("""() => Array.from(document.querySelectorAll('.cron-menu__item'))
            .filter(b => b.getBoundingClientRect().height < 44).length""")
        check(msmall == 0, "menu items >= 44px on mobile")
        mr = page.evaluate("() => { const r = document.querySelector('.cron-menu').getBoundingClientRect(); return [r.left, r.right]; }")
        check(mr[0] >= 0 and mr[1] <= 390, "menu inside the viewport " + repr(mr))
        shot(page, "de-%s-390-menu" % ("dark" if dark else "light"), full=False)
        page.keyboard.press("Escape")
        shot(page, "de-%s-390" % ("dark" if dark else "light"))
        check(not page.problems, "no console problems (mobile): " + repr(page.problems))
        page.context.close()

    # ---------- tabs and Refresh ----------
    page = open_page(browser, "delay=300&mta=no")
    tabs_state = """() => Array.from(document.querySelectorAll('#tabs [role=tab]')).map(t => [t.id, t.getAttribute('aria-selected'),
        t.getAttribute('tabindex'), document.getElementById(t.getAttribute('aria-controls')).hidden])"""
    # mouse
    page.click("#tab-timers")
    check(page.evaluate(tabs_state) == [["tab-overview", "false", "-1", True], ["tab-timers", "true", None, False],
                                         ["tab-system", "false", "-1", True]], "click: timers shown " + repr(page.evaluate(tabs_state)))
    check(not page.locator("#timers-card").is_hidden() and page.locator("#root-body").is_hidden(), "timers card only")
    page.click("#tab-system")
    check(selected_tab(page) == "tab-system" and not page.locator("#crond-card").is_hidden(), "click: System shown")
    # keyboard: arrows (with wrap-around), Home, End; the tab shown follows the focus
    page.focus("#tab-system")
    keys = []
    for key in ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight", "Home", "End"]:
        page.keyboard.press(key)
        keys.append([selected_tab(page), page.evaluate("() => document.activeElement.id")])
    check(keys == [["tab-timers"] * 2, ["tab-overview"] * 2, ["tab-system"] * 2, ["tab-overview"] * 2,
                   ["tab-overview"] * 2, ["tab-system"] * 2], "keyboard: " + repr(keys))
    page.keyboard.press("Tab")
    check(not page.evaluate("() => !!document.activeElement.closest('#tabs')"), "only the tab shown is in the tab order")
    check(page.evaluate("() => location.hash") == "", "switching does not change the address")
    # Refresh: off and "Lädt …" while loading, keeps the tab
    calls = len(mock(page, "calls"))
    page.click("#tab-timers")
    check(len(mock(page, "calls")) == calls, "switching loads nothing")
    page.click("#reload")
    wait_js(page, "document.querySelector('#reload').disabled")
    loading_state = page.evaluate("""() => { const b = document.querySelector('#reload');
        return [b.innerText.trim(), b.getAttribute('aria-busy'), b.firstElementChild.matches('svg.az-icon')]; }""")
    check(loading_state == ["Lädt …", "true", True], "Refresh while loading: " + repr(loading_state))
    wait_idle(page)
    check(page.inner_text("#reload").strip() == "Aktualisieren" and page.get_attribute("#reload", "aria-busy") == "false",
          "Refresh after loading")
    check(selected_tab(page) == "tab-timers", "Refresh keeps the tab")
    # messages for the whole page are visible in every tab: a notice, an alert, the system read error
    page.evaluate("() => { window.__mock.failSystem = true; }")
    page.click("#reload")
    wait_idle(page)
    page.evaluate("() => { window.__mock.failSystem = false; }")
    for name in ["overview", "timers", "system"]:
        show_tab(page, name)
        visible = page.evaluate("""() => ['notices', 'sys-alerts'].map(id => {
            const el = document.getElementById(id); return !!el.offsetParent && el.innerText.trim().length > 0; })""")
        check(visible == [True, True], f"notice and error visible in {name}: " + repr(visible))
    show_tab(page, "overview")
    row(page, 1).locator(".az-switch").click()
    wait_idle(page)
    for name in ["timers", "system", "overview"]:
        show_tab(page, name)
        check(page.locator("#alerts").is_visible() and "ausgeschaltet" in page.inner_text("#alerts"), f"alert visible in {name}")
    check(not page.problems, "no console problems (tabs): " + repr(page.problems))
    page.context.close()

    # focus that goes back to something in another tab shows that tab first: a switch is
    # turned off, and while it saves the System tab is opened
    page = open_page(browser, "delay=300")
    row(page, 1).locator(".az-switch").click()
    show_tab(page, "system")
    wait_idle(page)
    check(selected_tab(page) == "tab-overview" and focused_key(page) == "toggle:25",
          "focus back on the switch, in its tab: " + repr([selected_tab(page), focused_key(page)]))
    page.context.close()

    # ---------- switching, editing, adding, deleting ----------
    page = open_page(browser)
    before = root_text(page)
    row(page, 1).locator(".az-switch").click()
    wait_idle(page)
    check(changed_lines(before, root_text(page)) == [("30 1 * * 0 /usr/sbin/fstrim -a", "#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a")],
          "toggle off changes exactly one line: " + repr(changed_lines(before, root_text(page))))
    check("Job ausgeschaltet" in page.inner_text("#alerts"), "toggle success alert")
    check("/var/lib/cockpit-cronjobs/backups/root-" in page.inner_text("#alerts"), "backup path in alert")
    check(mock(page, "backups.length") == 1 and mock(page, "backups[0].content") == before, "backup of previous content")
    check(focused_key(page) == "toggle:25", "focus stays on toggle: " + repr(focused_key(page)))
    row(page, 1).locator(".az-switch").click()
    wait_idle(page)
    check(root_text(page) == before, "toggle on restores original bytes")
    # old marker of cronctl
    row(page, 2).locator(".az-switch").click()
    wait_idle(page)
    check(changed_lines(before, root_text(page)) == [("#[cronctl:off] 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/",
                                                      "0 5 * * 1 tar -zcf /var/backups/home.tgz /home/")], "old marker switched on")
    row(page, 2).locator(".az-switch").click()
    wait_idle(page)
    check("#[cronjobs:off] 0 5 * * 1 tar" in root_text(page), "switched off with the new marker")
    before = root_text(page)

    # edit a job that is not recorded
    row(page, 1).locator("[data-key^=edit]").click()
    check(page.locator("#edit-dlg").is_visible(), "edit dialog visible")
    check(page.input_value("#f-schedule") == "30 1 * * 0", "schedule prefilled")
    check(not page.is_checked("#f-capture"), "capture off for unrecorded job")
    check(page.evaluate("() => document.activeElement.id") == "f-schedule", "focus in schedule field")
    check("Sonntags um 01:30 · nächster Lauf" in page.inner_text("#f-schedule-help"), "live help")
    shot(page, "de-light-edit", full=False)
    page.fill("#f-schedule", "61 * * * *")
    check("Minute: erlaubt sind 0–59" in page.inner_text("#edit-dlg"), "field error minute")
    check(page.get_attribute("#f-schedule", "aria-invalid") == "true", "aria-invalid set")
    writes = mock(page, "writes")
    page.click("#edit-save")
    page.wait_for_timeout(200)
    check(mock(page, "writes") == writes, "invalid schedule not saved")
    page.fill("#f-schedule", "31 2 31 2 *")
    check("trifft nie zu" in page.inner_text("#edit-dlg"), "never-matching schedule rejected")
    page.fill("#f-schedule", "*/15  * * * 1-5")
    check("Alle 15 Minuten, montags bis freitags" in page.inner_text("#f-schedule-help"), "help for */15 1-5")
    page.fill("#f-command", "/usr/sbin/fstrim -av")
    page.press("#f-command", "Enter")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(changed_lines(before, root_text(page)) == [("30 1 * * 0 /usr/sbin/fstrim -a", "*/15 * * * 1-5 /usr/sbin/fstrim -av")],
          "edit changes one line: " + repr(changed_lines(before, root_text(page))))
    check("Job gespeichert" in page.inner_text("#alerts"), "edit success alert")
    check(focused_key(page) == "edit:25", "focus back on edit button")

    # edit a recorded job: the wrapper and its ID stay
    before = root_text(page)
    row(page, 0).locator("[data-key^=edit]").click()
    check(page.input_value("#f-command") == "/opt/plausible/update-geoip.sh", "plain command in edit field")
    check(page.is_checked("#f-capture"), "capture on for recorded job")
    page.fill("#f-command", "/opt/plausible/update-geoip.sh --force")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(changed_lines(before, root_text(page)) == [("0 3 2 * *\t" + WRAP + " update-geoip-1a2b '/opt/plausible/update-geoip.sh'",
                                                      "0 3 2 * * " + WRAP + " update-geoip-1a2b '/opt/plausible/update-geoip.sh --force'")],
          "recorded job keeps wrapper and id: " + repr(changed_lines(before, root_text(page))))
    check(mock(page, "wrapperInstalls.length") == 0, "wrapper not reinstalled when current")

    # add: escape, required fields, % warning, recording on by default
    page.click("#add")
    check(page.locator("#edit-title").inner_text() == "Job hinzufügen", "add title")
    check("Fünf Felder" in page.inner_text("#f-schedule-help"), "empty schedule help")
    check(page.is_checked("#f-capture"), "new jobs record their runs by default")
    page.keyboard.press("Escape")
    check(page.locator("#edit-dlg").is_hidden(), "escape closes")
    check(page.evaluate("() => document.activeElement.id") == "add", "focus returns to add")
    page.click("#add")
    page.click("#edit-save")
    check("Bitte einen Zeitplan eingeben." in page.inner_text("#edit-dlg"), "required schedule")
    check("Bitte einen Befehl eingeben." in page.inner_text("#edit-dlg"), "required command")
    page.fill("#f-schedule", "@daily")
    page.fill("#f-command", "date +%F > /tmp/heute")
    check(not page.locator("#f-command-warn").is_hidden() and "Zeilenumbruch" in page.inner_text("#f-command-warn"), "percent warning")
    check(page.is_disabled("#f-capture") and "nicht erfassen" in page.inner_text("#f-capture-help"), "no recording with %")
    page.fill("#f-command", "date +\\%F > /tmp/heute")
    check(page.locator("#f-command-warn").is_hidden() and page.is_enabled("#f-capture"), "escaped percent ok")
    page.locator("#edit-dlg .az-switch").nth(1).click()
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    last = root_text(page).rstrip("\n").split("\n")[-1]
    check(re.fullmatch(r"#\[cronjobs:off\] @daily " + re.escape(WRAP) + r" date-[0-9a-f]{4} 'date \+\\%F > /tmp/heute'", last),
          "added disabled, recorded job at end: " + repr(last))
    check("Job hinzugefügt" in page.inner_text("#alerts"), "add alert")

    # delete (the escaped HTML job)
    before_del = root_text(page)
    row(page, 3).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Löschen").click()
    check(page.locator("#del-dlg").is_visible(), "delete dialog")
    check("echo '<b>not bold</b>'" in page.inner_text("#del-line"), "delete shows line")
    check("/var/lib/cockpit-cronjobs/backups/" in page.inner_text("#del-backup"), "delete shows backup dir")
    check(page.locator("#del-runs").is_hidden(), "no runs note for unrecorded job")
    check(page.evaluate("() => document.activeElement.id") == "del-cancel", "focus on cancel in delete dialog")
    shot(page, "de-light-delete", full=False)
    for _ in range(5):
        page.keyboard.press("Tab")
    check(page.evaluate("() => !!document.activeElement.closest('#del-dlg')"), "focus trapped in dialog")
    page.click("#del-confirm")
    wait_js(page, "document.querySelector('#del-dlg').hidden")
    wait_idle(page)
    removed = [l for l in before_del.split("\n") if l not in root_text(page).split("\n")]
    check(removed == ["*/10 * * * * test -x /opt/x && echo '<b>not bold</b>' > /dev/null"], "deleted one line: " + repr(removed))
    check("Job gelöscht" in page.inner_text("#alerts"), "delete alert")

    # conflict: someone changes the crontab elsewhere
    page.evaluate("() => { window.__mock.conflictNext = window.__mock.root + '0 4 * * * /usr/bin/other\\n'; }")
    writes = mock(page, "writes")
    row(page, 0).locator(".az-switch").click()
    wait_idle(page)
    check(mock(page, "writes") == writes, "conflict: no write")
    check("inzwischen geändert" in page.inner_text("#alerts"), "conflict alert")
    check("/usr/bin/other" in page.inner_text("#root-body"), "conflict: fresh state shown")
    check(row(page, 0).locator("input[type=checkbox]").is_checked(), "conflict: switch reset")

    # errors stay in the dialog
    page.evaluate("() => { window.__mock.failWrite = '\"-\":28: bad minute\\nerrors in crontab file, can\\'t install.'; }")
    row(page, 1).locator("[data-key^=edit]").click()
    page.fill("#f-command", "/usr/sbin/fstrim -a")
    page.click("#edit-save")
    wait_js(page, "!document.querySelector('#edit-alert').hidden")
    check("errors in crontab file" in page.inner_text("#edit-alert"), "write error in dialog")
    check(page.locator("#edit-dlg").is_visible(), "dialog stays open on error")
    page.evaluate("() => { window.__mock.failWrite = null; window.__mock.failBackup = 'install: cannot create directory: Read-only file system'; }")
    writes = mock(page, "writes")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-alert').innerText.includes('Backup')")
    check(mock(page, "writes") == writes, "backup failure: no write")
    page.evaluate("() => { window.__mock.failBackup = null; }")
    page.click("#edit-cancel")
    check(not page.problems, "no console problems (flows): " + repr(page.problems))
    page.context.close()

    # ---------- row menu and recording ----------
    page = open_page(browser)
    more = row(page, 1).locator("[data-key^=more]")
    more.focus()
    page.keyboard.press("Enter")
    check(page.locator("#row-menu").is_visible(), "menu opens with the keyboard")
    check(more.get_attribute("aria-expanded") == "true", "aria-expanded on menu button")
    items = page.locator("#row-menu [role=menuitem]").all_inner_texts()
    check(items[0].startswith("Läufe erfassen") and any("In systemd-Timer umwandeln" in i for i in items) and items[-1] == "Löschen",
          "menu items for an unrecorded job: " + repr(items))
    check(page.evaluate("() => document.activeElement.textContent.startsWith('Läufe erfassen')"), "focus on first item")
    page.keyboard.press("ArrowDown")
    check(page.evaluate("() => document.activeElement.textContent.startsWith('In systemd-Timer')"), "arrow down")
    page.keyboard.press("End")
    check(page.evaluate("() => document.activeElement.textContent === 'Löschen'"), "end key")
    page.keyboard.press("Escape")
    check(page.locator("#row-menu").count() == 0 and focused_key(page) == "more:25", "escape closes menu, focus back")
    row(page, 2).locator("[data-key^=more]").click()
    dis = page.locator("#row-menu [aria-disabled=true]").all_inner_texts()
    check(any("Nur für aktive Jobs" in d for d in dis), "convert disabled for inactive job: " + repr(dis))
    page.mouse.click(5, 5)
    check(page.locator("#row-menu").count() == 0, "click outside closes menu")
    row(page, 4).locator("[data-key^=more]").click()
    dis = page.locator("#row-menu [aria-disabled=true]").all_inner_texts()
    check(any("@reboot" in d for d in dis), "convert disabled for @reboot: " + repr(dis))
    page.keyboard.press("Escape")

    # record via the link in the table
    before = root_text(page)
    page.click("[data-key='capture:25']")
    wait_idle(page)
    ch = changed_lines(before, root_text(page))
    check(len(ch) == 1 and re.fullmatch(r"30 1 \* \* 0 " + re.escape(WRAP) + r" fstrim-[0-9a-f]{4} '/usr/sbin/fstrim -a'", ch[0][1]),
          "record link wraps the command: " + repr(ch))
    check("erfasst jetzt" in page.inner_text("#alerts"), "record alert")
    check("Noch kein Lauf" in row(page, 1).inner_text(), "no run yet")

    # runs dialog
    row(page, 0).locator("[data-key^=runs]").click()
    check(page.locator("#runs-dlg").is_visible(), "runs dialog")
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 3")
    rt = page.inner_text("#runs-body")
    check(page.locator("#runs-body tbody tr").count() == 3, "3 runs")
    check("Manuell" in rt and "Zeitplan" in rt and "Fehler · Exit 1" in rt and "4 min 12 s" in rt, "runs content: " + rt[:200])
    check("/var/lib/cockpit-cronjobs/runs/" in page.inner_text("#runs-note"), "runs note")
    page.locator("#runs-body [data-key^='out:']").first.click()
    wait_js(page, "document.querySelector('#runs-body pre') && document.querySelector('#runs-body pre').textContent.includes('download failed')")
    check("letzten 64 KB" in page.inner_text("#runs-body"), "truncated note")
    check(page.locator("#runs-body [data-key^='copy:']").count() == 1, "copy button")
    check(page.locator("#runs-body [data-key^='out:']").first.get_attribute("aria-expanded") == "true", "aria-expanded on output toggle")
    shot(page, "de-light-runs", full=False)
    page.keyboard.press("Escape")
    check(page.locator("#runs-dlg").is_hidden() and focused_key(page) == "runs:24", "runs dialog closes, focus back")

    # a run in progress
    page.evaluate("() => { window.__mock.runs['update-geoip-1a2b'].running = [{ start: Math.floor(Date.now() / 1000) - 75 }]; }")
    page.click("#reload")
    wait_idle(page)
    check("Läuft" in row(page, 0).inner_text() and "seit" in row(page, 0).inner_text(), "running state in table")

    # recording off through the menu: confirm, unwrap, delete runs
    before = root_text(page)
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Erfassung ausschalten").click()
    check(page.locator("#confirm-dlg").is_visible() and "gelöscht" in page.inner_text("#confirm-body"), "confirm dialog")
    page.click("#confirm-ok")
    wait_idle(page)
    check(changed_lines(before, root_text(page)) == [("0 3 2 * *\t" + WRAP + " update-geoip-1a2b '/opt/plausible/update-geoip.sh'",
                                                      "0 3 2 * * /opt/plausible/update-geoip.sh")], "recording off unwraps")
    check(mock(page, "removedRuns") == ["update-geoip-1a2b"], "runs of the job deleted")
    check(not page.problems, "no console problems (menu): " + repr(page.problems))
    page.context.close()

    # ---------- leftover runs ----------
    page = open_page(browser)
    check(page.locator("#orphans").is_visible() and "Die erfassten Läufe von 1 Job " in page.inner_text("#orphans"),
          "leftover line under the root crontab: " + repr(page.inner_text("#orphans")))
    page.click("[data-key=orphans]")
    check(page.locator("#orph-dlg").is_visible(), "leftover dialog")
    check(page.evaluate("() => document.activeElement.id") == "orph-close-btn", "focus on close in the leftover dialog")
    ot = page.inner_text("#orph-body")
    check("gone-0000" in ot and "update-geoip-1a2b" not in ot, "only the job no line uses: " + ot)
    check("8 KB" in ot and "OK" in ot and page.locator("#orph-body tbody tr").count() == 1, "size and last run: " + ot)
    check(page.locator("#orph-all").is_hidden(), "no 'remove all' for one job")
    check("/var/lib/cockpit-cronjobs/runs/" in page.inner_text("#orph-note"), "leftover note names the directory")
    shot(page, "de-light-orphans", full=False)
    # a crontab mentions the ID again meanwhile: the root script keeps it, the page reloads
    page.evaluate("() => { window.__mock.root += '# gone-0000 is coming back\\n'; }")
    page.click("[data-key='orph:gone-0000']")
    wait_js(page, "document.querySelector('#orph-dlg').hidden")
    wait_idle(page)
    check("behalten" in page.inner_text("#alerts") and "gone-0000" in page.inner_text("#alerts"),
          "kept job reported: " + page.inner_text("#alerts"))
    check(mock(page, "removedRuns") == [] and mock(page, "orphanCalls") == [["gone-0000"]], "nothing removed while mentioned")
    check(page.locator("#orphans").is_hidden(), "a comment that mentions the ID keeps it")
    reload_with_root(page, root_text(page).replace("# gone-0000 is coming back\n", "# not-gone-00001\n"))
    check(page.locator("#orphans").is_visible(), "a longer word is no mention")
    # mentioned in /etc/cron.d, or a run going on: not offered
    page.evaluate("() => { window.__mock.sys.crond.keep = '0 1 * * * root " + WRAP + " gone-0000 true\\n'; }")
    page.click("#reload")
    wait_idle(page)
    check(page.locator("#orphans").is_hidden(), "mentioned in /etc/cron.d: not offered")
    page.evaluate("""() => { delete window.__mock.sys.crond.keep;
                             window.__mock.runs['gone-0000'].running = [{ start: Math.floor(Date.now() / 1000) - 5 }]; }""")
    page.click("#reload")
    wait_idle(page)
    check(page.locator("#orphans").is_hidden(), "a run going on: not offered")
    # three leftovers: remove one, then the rest
    page.evaluate("""() => {
        const now = Math.floor(Date.now() / 1000);
        window.__mock.runs['gone-0000'].running = [];
        window.__mock.runs['old-1111'] = { runs: [{ start: now - 86400, end: now - 86390, rc: 2, trigger: 'schedule',
                                                    bytes: 0, truncated: false, out: '' }], running: [], kb: 2048 };
        window.__mock.runs['older-2222'] = { runs: [], running: [], kb: 4 };
    }""")
    page.click("#reload")
    wait_idle(page)
    check("Die erfassten Läufe von 3 Jobs " in page.inner_text("#orphans"), "three leftovers")
    page.click("[data-key=orphans]")
    ids = page.locator("#orph-body tbody tr td:first-child").all_inner_texts()
    check(ids == ["gone-0000", "old-1111", "older-2222"], "newest last run first: " + repr(ids))
    ot = page.inner_text("#orph-body")
    check("2 MB" in ot and "Fehler · Exit 2" in ot and "Noch kein Lauf" in ot, "sizes and results: " + ot)
    check(page.locator("#orph-all").is_visible(), "'remove all' for several jobs")
    page.click("[data-key='orph:old-1111']")
    wait_js(page, "document.querySelectorAll('#orph-body tbody tr').length === 2")
    check(page.locator("#orph-dlg").is_visible() and mock(page, "removedRuns") == ["old-1111"], "one removed, dialog stays")
    check((focused_key(page) or "").startswith("orph:"), "focus on the next remove button: " + repr(focused_key(page)))
    page.evaluate("() => { window.__mock.lockBusy = true; }")
    page.click("#orph-all")
    wait_js(page, "!document.querySelector('#orph-alert').hidden")
    check("an anderer Stelle" in page.inner_text("#orph-alert") and page.locator("#orph-dlg").is_visible(),
          "lock busy shown in the dialog")
    page.evaluate("() => { window.__mock.lockBusy = false; }")
    page.click("#orph-all")
    wait_js(page, "document.querySelector('#orph-dlg').hidden")
    wait_idle(page)
    check(mock(page, "removedRuns") == ["old-1111", "gone-0000", "older-2222"], "all removed: " + repr(mock(page, "removedRuns")))
    check("von 2 Jobs entfernt" in page.inner_text("#alerts"), "removed alert: " + page.inner_text("#alerts"))
    check(page.locator("#orphans").is_hidden(), "no leftover line any more")
    check(not page.problems, "no console problems (leftovers): " + repr(page.problems))
    page.context.close()

    # ---------- backups ----------
    page = open_page(browser)
    original = root_text(page)
    check(page.locator("#backups").is_visible() and page.inner_text("#backups").strip() == "Sicherungen" and
          page.locator("#backups svg").count() == 1 and "az-btn--secondary" in page.get_attribute("#backups", "class"),
          "backups button with an icon in the root card")
    page.click("#backups")
    wait_js(page, "!document.querySelector('#bk-dlg').hidden && document.querySelector('#bk-body .cron-state')")
    wait_js(page, "document.querySelector('#bk-body').innerText.includes('Noch keine')")
    check(page.evaluate("() => document.activeElement.id") == "bk-close-btn", "focus on close in the backups dialog")
    check("/var/lib/cockpit-cronjobs/backups/" in page.inner_text("#bk-note") and "letzten 10 " in page.inner_text("#bk-note"),
          "backups note: " + page.inner_text("#bk-note"))
    page.keyboard.press("Escape")
    check(page.locator("#bk-dlg").is_hidden() and focused_key(page) == "backups", "escape closes, focus back on the button")
    # four versions: one like now, one with another time, an older one with one more line, one that is not UTF-8
    newer = original.replace("30 1 * * 0 /usr/sbin/fstrim -a", "45 1 * * 0 /usr/sbin/fstrim -a")
    older = original + "15 4 * * * /usr/local/bin/old.sh\n"
    page.evaluate("""o => {
        const now = Math.floor(Date.now() / 1000);
        const p = n => '/var/lib/cockpit-cronjobs/backups/root-' + n + '.crontab';
        window.__mock.backups = [
            { path: p('20261011-030000'), content: o.older, mtime: now - 86400 },
            { path: p('20261012-090000'), content: o.newer, mtime: now - 3600 },
            { path: p('20261012-100000'), content: o.same, mtime: now - 600 },
            { path: p('20261012-100500'), content: '# caf\\u0001\\n', mtime: now - 300, latin1: true },
        ];
        window.__mock.backupSeq = 50;
    }""", {"older": older, "newer": newer, "same": original})
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 4")
    names = page.locator("#bk-body tbody tr td:first-child .az-mono").all_inner_texts()
    check(names == ["root-20261012-100500.crontab", "root-20261012-100000.crontab", "root-20261012-090000.crontab",
                    "root-20261011-030000.crontab"], "newest first: " + repr(names))
    deltas = page.locator("#bk-body tbody tr td:nth-child(2)").all_inner_texts()
    check(deltas == ["Nicht UTF-8, hier nicht darstellbar", "Nichts, sie ist die aktuelle Crontab",
                     "1 Zeile entfernt, 1 Zeile hinzugefügt", "1 Zeile hinzugefügt"], "what restoring changes: " + repr(deltas))
    check(page.inner_text("#bk-body tbody tr:nth-child(3) td:first-child").startswith("Heute um "), "saved time in words")
    check(page.locator("[data-key='bk:root-20261012-100500.crontab']").count() == 0, "a backup that is not UTF-8 cannot be opened")
    # what restoring the version from 09:00 changes, line by line
    page.click("[data-key='bk:root-20261012-090000.crontab']")
    wait_js(page, "document.querySelector('.cron-diff')")
    lines = page.evaluate("""() => Array.from(document.querySelectorAll('.cron-diff > div')).map(d =>
        d.classList.contains('cron-diff__skip') ? 'skip ' + d.textContent : d.dataset.op + d.querySelector('.cron-diff__text').textContent)""")
    check([x for x in lines if x[0] in "-+"] == ["-30 1 * * 0 /usr/sbin/fstrim -a", "+45 1 * * 0 /usr/sbin/fstrim -a"],
          "changed lines: " + repr(lines))
    check(lines[0].startswith("skip ") and "unveränderte Zeilen" in lines[0] and len([x for x in lines if x[0] == " "]) == 6,
          "three unchanged lines around, the rest folded: " + repr(lines))
    check(page.get_attribute("[data-key='bk:root-20261012-090000.crontab']", "aria-expanded") == "true" and
          focused_key(page) == "bk:root-20261012-090000.crontab", "expanded, focus stays on its button")
    check(page.inner_text(".cron-diff .is-del .az-sr") == "entfernt: " and page.inner_text(".cron-diff .is-add .az-sr") == "hinzugefügt: ",
          "removed and added lines say so to screen readers")
    colors = page.evaluate("""() => ['.is-del', '.is-add'].map(s => getComputedStyle(document.querySelector('.cron-diff ' + s)).backgroundColor)""")
    check(colors == ["rgb(251, 197, 197)", "rgb(209, 241, 187)"], "removed red, added green: " + repr(colors))
    check(page.inner_text("[data-key='restore:root-20261012-090000.crontab']").strip() == "Diese Version wiederherstellen" and
          page.locator("#bk-dlg .az-btn--primary").count() == 1, "one restore button, the only primary one")
    shot(page, "de-light-backups", full=False)
    page.set_viewport_size({"width": 375, "height": 800})
    page.wait_for_timeout(150)
    widths = page.evaluate("""() => [document.documentElement.scrollWidth, document.querySelector('#bk-dlg .az-modal').scrollWidth,
                                      document.querySelector('#bk-dlg .az-modal').clientWidth]""")
    check(widths[0] <= 375 and widths[1] <= widths[2], "phone: the dialog fits, long lines scroll inside: " + repr(widths))
    shot(page, "de-light-backups-375", full=False)
    page.set_viewport_size({"width": 1280, "height": 900})
    # the version like now: nothing to restore
    page.click("[data-key='bk:root-20261012-100000.crontab']")
    wait_js(page, "document.querySelector(\"[data-key='restore:root-20261012-100000.crontab']\")")
    check("dieselbe wie die aktuelle" in page.inner_text("#bk-body") and
          page.locator("[data-key='restore:root-20261012-100000.crontab']").is_disabled() and
          page.locator(".cron-diff").count() == 0, "same as now: no difference, restore off")
    # restore the version from 09:00
    page.click("[data-key='bk:root-20261012-090000.crontab']")
    page.click("[data-key='restore:root-20261012-090000.crontab']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == newer, "restored byte for byte")
    check(mock(page, "backups[window.__mock.backups.length - 1].content") == original, "the version before is the newest backup now")
    alerts = page.inner_text("#alerts")
    check("wiederhergestellt" in alerts and "/var/lib/cockpit-cronjobs/backups/root-" in alerts and "Rückgängigmachen" in alerts,
          "restored alert: " + alerts)
    check(focused_key(page) == "backups", "focus back on the backups button: " + repr(focused_key(page)))
    check("45 1 * * 0" in page.inner_text("#root-body"), "the page shows the restored crontab")
    # undo: the newest backup brings back the bytes from before
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 5")
    newest = page.locator("#bk-body tbody tr td:first-child .az-mono").first.inner_text()
    page.click("[data-key='bk:" + newest + "']")
    page.click("[data-key='restore:" + newest + "']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == original, "restoring back gives the original bytes")
    # the crontab changed meanwhile: nothing restored, the page says so
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length > 0")
    page.click("[data-key='bk:root-20261011-030000.crontab']")
    page.evaluate("t => { window.__mock.conflictNext = t; }", original + "# changed elsewhere\n")
    page.click("[data-key='restore:root-20261011-030000.crontab']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == original + "# changed elsewhere\n", "changed meanwhile: nothing restored")
    check("geändert" in page.inner_text("#alerts"), "changed meanwhile: said so: " + page.inner_text("#alerts"))
    # writing fails: the dialog stays and says why
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length > 0")
    page.click("[data-key='bk:root-20261011-030000.crontab']")
    page.evaluate("() => { window.__mock.failWrite = 'crontab: errors in crontab file, cannot install.'; }")
    page.click("[data-key='restore:root-20261011-030000.crontab']")
    wait_js(page, "!document.querySelector('#bk-alert').hidden")
    check("Wiederherstellen fehlgeschlagen" in page.inner_text("#bk-alert") and "cannot install" in page.inner_text("#bk-alert") and
          page.locator("#bk-dlg").is_visible(), "write failed: shown in the dialog")
    page.evaluate("() => { window.__mock.failWrite = null; }")
    page.click("#bk-close-btn")
    # the backups cannot be read: said so in the dialog
    page.evaluate("() => { window.__mock.lockBusy = true; }")
    page.click("#backups")
    wait_js(page, "!document.querySelector('#bk-alert').hidden")
    check("an anderer Stelle" in page.inner_text("#bk-alert") and page.locator("#bk-body tbody tr").count() == 0,
          "list locked: " + page.inner_text("#bk-alert"))
    page.evaluate("() => { window.__mock.lockBusy = false; window.__mock.failBackups = 'cat: Input/output error'; }")
    page.click("#bk-close")
    page.click("#backups")
    wait_js(page, "!document.querySelector('#bk-alert').hidden")
    check("konnten nicht gelesen werden" in page.inner_text("#bk-alert") and "Input/output error" in page.inner_text("#bk-alert"),
          "list unreadable: " + page.inner_text("#bk-alert"))
    page.evaluate("() => { window.__mock.failBackups = null; }")
    page.click("#bk-close")
    check(not page.problems, "no console problems (backups): " + repr(page.problems))
    page.context.close()
    # a root crontab that is not UTF-8 can be compared, but not replaced; dark colours
    page = open_page(browser, dark=True)
    page.evaluate("""o => { window.__mock.latin1 = true; window.__mock.root += '# caf\\x01\\n';
                            window.__mock.backups = [{ path: '/var/lib/cockpit-cronjobs/backups/root-20261012-090000.crontab',
                                                       content: o.newer, mtime: Math.floor(Date.now() / 1000) - 60 }]; }""",
                  {"newer": newer})
    page.click("#reload")
    wait_idle(page)
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 1")
    page.click("[data-key='bk:root-20261012-090000.crontab']")
    check(page.locator("[data-key='restore:root-20261012-090000.crontab']").is_disabled() and
          "nicht UTF-8" in page.inner_text(".cron-bk-detail"), "not UTF-8 now: restore off, said why")
    colors = page.evaluate("""() => ['.is-del', '.is-add'].map(s => getComputedStyle(document.querySelector('.cron-diff ' + s)).backgroundColor)""")
    check(colors == ["rgb(53, 26, 20)", "rgb(30, 43, 23)"], "dark: removed and added colours: " + repr(colors))
    shot(page, "de-dark-backups", full=False)
    check(not page.problems, "no console problems (backups, dark): " + repr(page.problems))
    page.context.close()

    # ---------- run now ----------
    page = open_page(browser)
    extra = ("PATH=/usr/local/bin:/usr/bin:/bin\n0 4 * * * /opt/fail.sh\n0 6 * * * sleep 600\n"
             "0 5 * * * mail -s hi root%hello%world\n")
    reload_with_root(page, root_text(page) + extra)
    row(page, 1).locator("[data-key^='run:']").click()
    check(page.locator("#run-dlg").is_visible(), "run dialog")
    rt = page.inner_text("#run-dlg")
    check("sofort als root" in rt and "/usr/sbin/fstrim -a" in rt, "run confirm text")
    check("PATH=/usr/bin:/bin" in rt and "HOME=/root" in rt and "/bin/sh" in rt, "cron environment shown: " + rt)
    check(page.evaluate("() => document.activeElement.id") == "run-start", "focus on run")
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    rt = page.inner_text("#run-dlg")
    check("OK" in page.inner_text("#run-label") and "Loading 12 feeds" in page.inner_text("#run-log") and "nach" in rt, "run done: " + rt)
    started = mock(page, "runs_started[0]")
    check("PATH=/usr/bin:/bin" in started["env"] and "HOME=/root" in started["env"] and "SHELL=/bin/sh" in started["env"]
          and not any(e.startswith("CRONJOBS_TRIGGER") for e in started["env"]), "manual run environment: " + repr(started["env"]))
    check(started["command"] == "/usr/sbin/fstrim -a" and started["shell"] == "/bin/sh" and started["home"] == "/root" and started["input"] is None,
          "manual run command: " + repr(started))
    check(started["opts"]["superuser"] == "require" and started["opts"]["err"] == "out", "run as root, stderr merged")
    check(page.evaluate("() => document.activeElement.id") == "run-close-btn", "focus on close after run")
    shot(page, "de-light-run-done", full=False)
    page.click("#run-close-btn")
    check(focused_key(page) == "run:25", "focus back on run button")
    # recorded job: the wrapped line runs, crontab variables apply below them only
    row(page, 0).locator("[data-key^='run:']").click()
    check("werden erfasst" in page.inner_text("#run-env"), "recorded note in run dialog")
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    started = mock(page, "runs_started[1]")
    check(started["command"].startswith(WRAP + " update-geoip-1a2b "), "recorded job runs through the wrapper: " + started["command"])
    check("CRONJOBS_TRIGGER=manual" in started["env"], "recorded run marked as manual")
    page.click("#run-close-btn")
    # failing job sees the crontab's PATH
    row(page, 5).locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    check("Fehler · Exit 1" in page.inner_text("#run-label"), "failed run")
    check("PATH=/usr/local/bin:/usr/bin:/bin" in mock(page, "runs_started[2].env"), "crontab PATH applies")
    page.click("#run-again")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden && window.__mock.runs_started.length === 4")
    check(True, "run again")
    page.click("#run-close-btn")
    # stop a long job; escape does not close while running
    row(page, 6).locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-running-actions').hidden")
    page.wait_for_timeout(300)
    check("Läuft" in page.inner_text("#run-label") and "seit" in page.inner_text("#run-time"), "running state")
    page.keyboard.press("Escape")
    check(page.locator("#run-dlg").is_visible(), "escape does not close a running job")
    shot(page, "de-light-run-running", full=False)
    page.click("#run-stop")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    check("Angehalten" in page.inner_text("#run-label"), "stopped")
    page.keyboard.press("Escape")
    check(page.locator("#run-dlg").is_hidden(), "escape closes after stop")
    # % passes input like cron
    row(page, 7).locator("[data-key^='run:']").click()
    check("als Eingabe" in page.inner_text("#run-env"), "stdin note")
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    st = mock(page, "runs_started[5]")
    check(st["command"] == "mail -s hi root" and st["input"] == "hello\nworld\n", "stdin from %: " + repr(st))
    page.click("#run-close-btn")
    check(not page.problems, "no console problems (run): " + repr(page.problems))
    page.context.close()

    # ---------- convert to a systemd timer ----------
    page = open_page(browser)
    row(page, 1).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    check(page.locator("#conv-dlg").is_visible(), "convert dialog")
    check(page.input_value("#conv-name") == "fstrim-2", "name suggested past fstrim.timer: " + page.input_value("#conv-name"))
    check(page.inner_text("#conv-cron") == "30 1 * * 0" and "OnCalendar=Sun *-*-* 01:30:00" in page.inner_text("#conv-cal"), "calendar shown")
    wait_js(page, "!document.querySelector('#conv-check').innerText.includes('wird mit')")
    check("die nächsten 5 Läufe stimmen überein" in page.inner_text("#conv-check"), "verified with systemd-analyze")
    page.click("#conv-units-toggle")
    check(not page.locator("#conv-units").is_hidden() and "ExecStart='/bin/sh' -c '/usr/sbin/fstrim -a'" in page.inner_text("#conv-service"),
          "units shown")
    check("OnCalendar=Sun *-*-* 01:30:00" in page.inner_text("#conv-timer") and "Persistent=false" in page.inner_text("#conv-timer"), "timer unit")
    page.locator("#conv-dlg .az-switch").click()
    check("Persistent=true" in page.inner_text("#conv-timer"), "persistent switch updates unit")
    page.fill("#conv-name", "bad name")
    check(page.is_disabled("#conv-ok") and "Nur Buchstaben" in page.inner_text("#conv-name-help"), "invalid name")
    page.fill("#conv-name", "logrotate")
    shot(page, "de-light-convert", full=False)
    page.click("#conv-ok")
    wait_js(page, "!document.querySelector('#conv-alert').hidden")
    check("Es gibt bereits logrotate.service" in page.inner_text("#conv-alert"), "name taken")
    before = root_text(page)
    before_convert = before
    page.fill("#conv-name", "fstrim-weekly")
    page.click("#conv-ok")
    wait_js(page, "document.querySelector('#conv-dlg').hidden")
    wait_idle(page)
    units = mock(page, "units")
    check("fstrim-weekly" in units and "fstrim-weekly.timer" in mock(page, "enabled"), "units written and enabled")
    after = root_text(page).split("\n")
    k = after.index("#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a") if "#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a" in after else -1
    check(k > 0 and after[k - 1].startswith("# Converted to systemd timer fstrim-weekly.timer by Cockpit Cron Jobs on "),
          "crontab line off with note: " + repr(after[k - 1:k + 1] if k > 0 else after))
    check(len(after) == len(before.split("\n")) + 1, "one line added")
    check("fstrim-weekly.timer" in page.inner_text("#alerts") and "umgewandelt" in page.inner_text("#alerts"), "convert alert")
    check("fstrim-weekly.timer" in page.inner_text("#timers-body"), "new timer listed")
    # mismatch between cron and systemd blocks the conversion
    page.evaluate("() => { window.__mock.analyzeShift = 60000; }")
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    wait_js(page, "!document.querySelector('#conv-check').innerText.includes('wird mit')")
    check("anderen Zeiten" in page.inner_text("#conv-check") and page.is_disabled("#conv-ok"), "mismatch blocks")
    page.click("#conv-cancel")
    page.evaluate("() => { window.__mock.analyzeShift = 0; window.__mock.failEnable = 'Failed to enable unit: Access denied'; }")
    # enable fails: crontab and units are put back
    before = root_text(page)
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    page.click("#conv-ok")
    wait_js(page, "!document.querySelector('#conv-alert').hidden")
    wait_idle(page)
    check("Access denied" in page.inner_text("#conv-alert") and "wieder eingeschaltet" in page.inner_text("#conv-alert"), "rollback reported")
    check(root_text(page) == before, "crontab restored after failed enable")
    check(list(mock(page, "units").keys()) == ["fstrim-weekly"], "units of failed conversion removed")
    page.click("#conv-cancel")
    # systemd reads the command differently: nothing changes
    page.evaluate("() => { window.__mock.failEnable = null; window.__mock.mangleExec = true; }")
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    page.click("#conv-ok")
    wait_js(page, "!document.querySelector('#conv-alert').hidden")
    check("nicht wie vorgesehen" in page.inner_text("#conv-alert") and root_text(page) == before, "unit mismatch refused")
    check(list(mock(page, "units").keys()) == ["fstrim-weekly"], "mismatching units removed")
    page.click("#conv-cancel")

    # back to cron: the converted line is recognised, and going back restores the crontab byte for byte
    conv = page.locator("#root-body tbody tr", has_text="/usr/sbin/fstrim -a")
    ct = conv.inner_text()
    check("Umgewandelt in systemd-Timer" in ct and "fstrim-weekly.timer" in ct and "Converted to" not in ct,
          "converted job recognised: " + ct)
    conv.locator("button", has_text="fstrim-weekly.timer").click()
    check(mock(page, "jumps")[-1][0] == "/system/services#/fstrim-weekly.timer", "link to the timer")
    conv.locator("[data-key^=more]").click()
    items = page.locator("#row-menu [role=menuitem]").all_inner_texts()
    check(any(i.startswith("Zurück zu cron") for i in items) and not any("umwandeln" in i for i in items),
          "menu offers back to cron: " + repr(items))
    # units changed by hand: nothing is done
    page.evaluate("() => { window.__mock.units['fstrim-weekly'].foreign = true; }")
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    check(page.locator("#back-dlg").is_visible(), "back dialog")
    wait_js(page, "!document.querySelector('#back-check').innerText.includes('geprüft')")
    check("verändert" in page.inner_text("#back-check") and page.is_disabled("#back-ok"), "foreign units: refused")
    page.click("#back-cancel")
    # the timer cannot be stopped: the crontab is put back
    page.evaluate("""() => { delete window.__mock.units['fstrim-weekly'].foreign;
                             window.__mock.failDisable = 'Failed to disable unit: Access denied'; }""")
    converted = root_text(page)
    conv.locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    check("angelegt" in page.inner_text("#back-check") and "fstrim-weekly.service" in page.inner_text("#back-units"),
          "own units: " + page.inner_text("#back-dlg"))
    check("30 1 * * 0  /usr/sbin/fstrim -a" in page.inner_text("#back-line"), "line shown")
    shot(page, "de-light-back", full=False)
    page.click("#back-ok")
    wait_js(page, "!document.querySelector('#back-alert').hidden")
    wait_idle(page)
    check("Access denied" in page.inner_text("#back-alert") and "wiederhergestellt" in page.inner_text("#back-alert"),
          "rollback reported: " + page.inner_text("#back-alert"))
    check(root_text(page) == converted and "fstrim-weekly" in mock(page, "units"), "nothing changed when the timer cannot be stopped")
    page.click("#back-cancel")
    # back to cron
    page.evaluate("() => { window.__mock.failDisable = null; }")
    conv.locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    page.click("#back-ok")
    wait_js(page, "document.querySelector('#back-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == before_convert, "back to cron gives the crontab from before the conversion, byte for byte")
    check("fstrim-weekly" not in mock(page, "units") and mock(page, "unitsRemoved") == ["fstrim-weekly"] and
          "fstrim-weekly.timer" not in mock(page, "enabled"), "units stopped and removed")
    check("wieder über cron" in page.inner_text("#alerts"), "back alert: " + page.inner_text("#alerts"))
    # a converted line whose timer is gone: only the line goes back on
    reload_with_root(page, "# Converted to systemd timer old-job.timer by Cockpit Cron Jobs on 2026-01-02; "
                           "the line below is no longer used.\n#[cronjobs:off] 0 4 * * * /usr/local/bin/old-job\n")
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    check("gibt es nicht mehr" in page.inner_text("#back-check") and page.locator("#back-units").is_hidden(),
          "missing units: only the line")
    page.click("#back-ok")
    wait_js(page, "document.querySelector('#back-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == "0 4 * * * /usr/local/bin/old-job\n", "line back on, note gone: " + repr(root_text(page)))
    check(not page.problems, "no console problems (convert): " + repr(page.problems))
    page.context.close()

    # ---------- run recorder notices ----------
    page = open_page(browser, "wrapper=missing")
    check("Der Lauf-Rekorder fehlt" in page.inner_text("#notices") and "1 Job" in page.inner_text("#notices"), "missing wrapper notice")
    page.click("#wrapper-install")
    wait_js(page, "window.__mock.wrapperInstalls.length === 1")
    wait_js(page, "!document.querySelector('#notices').innerText.includes('fehlt')")
    inst = mock(page, "wrapperInstalls[0]")
    check(inst["target"] == WRAP and inst["bytes"] > 2000, "wrapper copy fetched and installed: " + repr(inst))
    check(mock(page, "wrapper.text").startswith("#!/bin/sh\n# cockpit-cronjobs-run"), "installed text is the shipped file")
    check("Lauf-Rekorder installiert" in page.inner_text("#alerts"), "installed alert")
    page.context.close()
    page = open_page(browser, "wrapper=missing")
    page.click("[data-key='capture:25']")
    # the page shows no loading while it installs the recorder, only while it saves: wait for the saved line
    wait_js(page, "window.__mock.root.includes('fstrim-')")
    wait_idle(page)
    check(mock(page, "wrapperInstalls.length") == 1 and "fstrim-" in root_text(page), "recording installs the wrapper first")
    page.context.close()
    page = open_page(browser, "wrapper=0")
    check("kann aktualisiert werden" in page.inner_text("#notices"), "outdated wrapper notice")
    page.click("#wrapper-install")
    wait_js(page, "window.__mock.wrapperInstalls.length === 1")
    page.context.close()

    # ---------- races (review) ----------
    page = open_page(browser, "delay=300")
    page.click("#reload")
    page.wait_for_timeout(50)
    check(page.locator("#root-body button[data-key^=edit]").first.is_disabled(), "row actions frozen while loading")
    check(page.locator("#add").is_disabled(), "add frozen while loading")
    wait_idle(page)
    check(page.locator("#root-body button[data-key^=edit]").first.is_enabled(), "row actions enabled after load")
    row(page, 1).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Löschen").click()
    page.evaluate("() => { window.__mock.root = 'MAILTO=\"\"\\n' + window.__mock.root; }")
    page.evaluate("() => window.__mock.setSuperuser('root')")
    page.wait_for_timeout(100)
    wait_idle(page)
    changed = root_text(page)
    writes = mock(page, "writes")
    page.click("#del-confirm")
    wait_js(page, "document.querySelector('#del-dlg').hidden")
    wait_idle(page)
    check(mock(page, "writes") == writes and root_text(page) == changed, "stale delete refused")
    check("inzwischen geändert" in page.inner_text("#alerts"), "stale delete reports conflict")
    row(page, 1).locator("[data-key^=edit]").click()
    page.fill("#f-command", "/usr/sbin/fstrim -av")
    page.evaluate("() => { window.__mock.root = '# new\\n' + window.__mock.root; }")
    page.evaluate("() => window.__mock.setSuperuser('sudo')")
    page.wait_for_timeout(100)
    wait_idle(page)
    changed = root_text(page)
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == changed, "stale edit refused")
    # deleting a recorded job takes its note and its runs
    before = root_text(page)
    page.evaluate("""() => { window.__seen = new Set();
        window.__seenTimer = setInterval(() => window.__seen.add(document.querySelector('#orphans').innerText), 5); }""")
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="Löschen").click()
    check("Kommentar" in page.inner_text("#del-intro") and "# GeoIP" in page.inner_text("#del-line"), "delete dialog shows note")
    check(not page.locator("#del-runs").is_hidden(), "delete dialog mentions runs")
    check(WRAP not in page.inner_text("#del-line"), "delete dialog shows plain command")
    page.click("#del-confirm")
    wait_js(page, "document.querySelector('#del-dlg').hidden")
    wait_idle(page)
    gone = [l for l in before.split("\n") if l not in root_text(page).split("\n")]
    check(gone == ["# GeoIP database for Plausible", "0 3 2 * *\t" + WRAP + " update-geoip-1a2b '/opt/plausible/update-geoip.sh'"],
          "job and note removed: " + repr(gone))
    check(mock(page, "removedRuns") == ["update-geoip-1a2b"], "runs removed with job")
    wait_js(page, "document.querySelector('#orphans').innerText.includes('von 1 Job ')")
    seen = page.evaluate("() => { clearInterval(window.__seenTimer); return Array.from(window.__seen); }")
    check(not any("2 Jobs" in s for s in seen), "a job deleted here never shows up as leftover: " + repr(seen))
    check("MAILTO" in root_text(page), "MAILTO kept")
    page.evaluate("() => { window.__mock.lockBusy = true; }")
    row(page, 0).locator(".az-switch").click()
    wait_idle(page)
    check("an anderer Stelle" in page.inner_text("#alerts"), "lock busy message")
    check(row(page, 0).locator("input").is_checked(), "switch reset after lock busy")
    check("caf\ufffd" in page.inner_text("#crond-body"), "latin1 file decoded leniently")
    check(not page.problems, "no console problems (races): " + repr(page.problems))
    page.context.close()

    # a root crontab that is not UTF-8 opens read-only
    page = open_page(browser)
    page.evaluate("() => { window.__mock.latin1 = true; window.__mock.root += '# caf\\x01\\n'; }")
    page.click("#reload")
    wait_idle(page)
    check("nicht UTF-8" in page.inner_text("#root-body"), "not UTF-8: read-only notice")
    check(page.locator("#root-body [data-key^='run:'], #root-body [data-key^='edit:'], #root-body input[type=checkbox]").count() == 0,
          "not UTF-8: no run, edit or switch")
    check(not page.problems, "no console problems (latin1): " + repr(page.problems))
    page.context.close()

    # cronie: CRON_TZ moves the job's times, also in the conversion
    page = open_page(browser, "flavor=cronie")
    reload_with_root(page, "CRON_TZ=America/New_York\n0 3 * * * /usr/local/bin/ny-report\n")
    check("0 3 * * * · America/New_York" in page.inner_text("#root-body"), "CRON_TZ shown with the schedule")
    row(page, 0).locator("[data-key^=more]").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    wait_js(page, "!document.querySelector('#conv-check').innerText.includes('wird mit')")
    check("OnCalendar=*-*-* 03:00:00 America/New_York" in page.inner_text("#conv-cal"), "calendar in CRON_TZ")
    check("stimmen überein" in page.inner_text("#conv-check"), "verified in CRON_TZ")
    page.click("#conv-cancel")
    reload_with_root(page, "RANDOM_DELAY=10\n0 3 * * * /usr/local/bin/x\n")
    row(page, 0).locator("[data-key^=more]").click()
    check("RANDOM_DELAY" in page.inner_text("#row-menu"), "RANDOM_DELAY blocks conversion")
    page.context.close()

    # /etc/cron.d: links, types, modes and hard links, as Debian's cron and cronie read them
    # (raw mode in hex and owner of the entry, then mode, owner, hard links of what it opens)
    CROND = {
        "link-ok": ["a1ff:0:81a4:0:1", "0 1 * * * root /usr/bin/true\n"],
        "link-user": ["a1ff:1000:81a4:0:1", "0 2 * * * root /usr/bin/true\n"],
        "link-broken": ["a1ff:0:::", ""],
        "a-dir": ["41ed:0:41ed:0:2", ""],
        "group-writable": ["81b4:0:81b4:0:1", "0 3 * * * root /usr/bin/true\n"],
        "hard-linked": ["81a4:0:81a4:0:2", "0 4 * * * root /usr/bin/true\n"],
        "executable": ["81ed:0:81ed:0:1", "0 5 * * * root /usr/bin/true\n"],
    }
    WHY = {"linkOwner": "Link ist, der nicht root gehört", "broken": "Link ins Leere", "notFile": "keine normale Datei",
           "writable": "Gruppe oder andere", "links": "mehr als einen Hardlink", "mode": "wegen ihrer Rechte"}
    EXPECT = {
        "debian": {"link-ok": None, "link-user": "linkOwner", "link-broken": "broken", "a-dir": "notFile",
                   "group-writable": "writable", "hard-linked": "links", "executable": None},
        "cronie": {"link-ok": None, "link-user": None, "link-broken": "broken", "a-dir": "notFile",
                   "group-writable": "writable", "hard-linked": None, "executable": "mode"},
    }
    for flavor, expect in EXPECT.items():
        page = open_page(browser, "flavor=" + flavor)
        page.evaluate("""m => Object.entries(m).forEach(([f, [meta, text]]) => {
            window.__mock.sys.crond[f] = text; window.__mock.sys.crondMeta[f] = meta; })""", CROND)
        page.click("#reload")
        wait_idle(page)
        got = page.evaluate("""() => Object.fromEntries(Array.from(document.querySelectorAll('#crond-body tbody tr')).map(tr => [
            tr.querySelector('.az-mono').textContent,
            { why: (tr.querySelector('.cron-ignored-why') || {}).textContent || null,
              label: !!tr.querySelector('.az-label--warning'), cells: tr.innerText }]))""")
        tl = page.inner_text("#tl-card")
        for f, reason in expect.items():
            row_info = got.get(f)
            if reason is None:
                check(row_info is not None and row_info["why"] is None and not row_info["label"] and f in tl,
                      f"{flavor}: {f} is read: {row_info!r}")
            else:
                check(row_info is not None and row_info["label"] and row_info["why"] and WHY[reason] in row_info["why"]
                      and f not in tl, f"{flavor}: {f} skipped ({reason}): {row_info!r}")
        check(got["link-broken"]["cells"].count("—") == 3, f"{flavor}: a file without jobs shows dashes: {got['link-broken']!r}")
        if flavor == "debian":
            show_tab(page, "system")
            page.locator("#crond-card").scroll_into_view_if_needed()
            shot(page, "de-light-crond", full=False)
        check(not page.problems, f"no console problems (cron.d, {flavor}): " + repr(page.problems))
        page.context.close()

    page = open_page(browser, "tz=Europe/Berlin&tzmode=fallback")
    check("Serverzeit Europe/Berlin" in page.inner_text("#meta"), "tz fallback to /etc/localtime")
    page.context.close()

    # ---------- without admin access, then with ----------
    page = open_page(browser, "su=none")
    check("Administrativer Zugriff nötig" in page.inner_text("#root-body"), "denied state")
    check(page.locator("#add").is_hidden(), "no add button when denied")
    check(page.locator("#orphans").is_hidden(), "no leftover runs without admin")
    check(not page.locator("#tl-card").is_hidden(), "timeline without admin")
    show_tab(page, "system")
    check(page.locator("#users-card").is_hidden(), "users card hidden without admin")
    check(not page.locator("#etc-card").is_hidden(), "system crontabs without admin")
    show_tab(page, "timers")
    check(not page.locator("#timers-card").is_hidden(), "timers without admin")
    show_tab(page, "overview")
    shot(page, "de-light-denied")
    page.evaluate("() => window.__mock.setSuperuser('sudo')")
    wait_js(page, "document.querySelectorAll('#root-body tbody tr').length === 5")
    show_tab(page, "system")
    check(not page.locator("#users-card").is_hidden(), "users card after admin")
    page.context.close()

    # ---------- empty crontab ----------
    page = open_page(browser, "root=none")
    check("Keine Jobs" in page.inner_text("#root-body"), "empty state")
    check(page.locator("#add").is_hidden(), "header add hidden when empty")
    shot(page, "de-light-empty")
    page.click("[data-key=add-empty]")
    page.fill("#f-schedule", "0 4 * * *")
    page.fill("#f-command", "/usr/local/bin/backup.sh")
    page.locator("#edit-dlg .az-switch").nth(0).click()
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(root_text(page) == "0 4 * * * /usr/local/bin/backup.sh\n", "first job written without recording: " + repr(root_text(page)))
    check("kein Backup" in page.inner_text("#alerts"), "no-backup note")
    page.context.close()

    # ---------- English, server in Berlin ----------
    page = open_page(browser, "lang=en&tz=Europe/Berlin")
    t = page.inner_text("body")
    check(page.inner_text("#reload").strip() == "Refresh" and page.locator(".az-page-desc").count() == 0, "en header: Refresh, no description")
    check([page.inner_text("#tab-" + n).strip() for n in ("overview", "timers", "system")] == ["Overview", "systemd timers", "System"],
          "en tabs")
    check("On day 2 of every month at 03:00" in t, "en describe")
    check("Server time Europe/Berlin" in t, "en tz")
    check("The next 24 hours" in t and "systemd timers" in t and "Last run" in t, "en sections")
    check("your time" not in page.inner_text("#root-body"), "no local hint when tz equal")
    check(page.evaluate("() => document.documentElement.lang") == "en", "html lang en")
    check("no crontab uses them any more" in page.inner_text("#orphans"), "en leftover line")
    check(page.inner_text("#backups").strip() == "Backups", "en backups button")
    shot(page, "en-light-1280")
    row(page, 0).locator("[data-key^=more]").click()
    check("Stop recording" in page.inner_text("#row-menu"), "en menu")
    page.context.close()

    # ---------- language like Cockpit ----------
    page = open_page(browser, "nopo=1")
    check(page.inner_text("#tabs").startswith("Overview"), "fallback English without po.js and cookie")
    page.context.close()
    page = open_page(browser, "nopo=1", cookie="de-de")
    check(page.inner_text("#tabs").startswith("Übersicht"), "German from CockpitLang cookie")
    page.context.close()
    page = open_page(browser, "lang=en", cookie="de-de")
    check(page.inner_text("#tabs").startswith("Übersicht"), "cookie (Cockpit menu choice) wins")
    page.context.close()
    page = open_page(browser, "nopo=1", storage_lang="de")
    check(page.inner_text("#tabs").startswith("Übersicht"), "German from localStorage cockpit.lang")
    page.context.close()
    page = open_page(browser, "lang=fr")
    check(page.inner_text("#tabs").startswith("Overview"), "other languages fall back to English")
    page.context.close()

    # ---------- server situations ----------
    page = open_page(browser, "mta=no")
    check("gehen auf diesem Server verloren" in page.inner_text("#notices"), "no-MTA notice")
    row(page, 1).locator("[data-key^=edit]").click()
    check("kein Mailprogramm" in page.inner_text("#f-command-help"), "no-MTA hint for unrecorded job")
    page.locator("#edit-dlg .az-switch").nth(0).click()
    check("werden erfasst" in page.inner_text("#f-command-help"), "recorded hint once recording is on")
    shot(page, "de-light-edit-nomta", full=False)
    page.context.close()

    page = open_page(browser, "cron=inactive")
    check("Der cron-Dienst läuft nicht" in page.inner_text("#notices"), "cron down notice")
    page.locator("#notices button").click()
    check(mock(page, "jumps[0][0]") == "/system/services#/cron.service", "open cron service")
    page.context.close()

    page = open_page(browser, "systemd=no")
    check(not page.locator("#tl-card").is_hidden(), "timeline without systemd")
    show_tab(page, "timers")
    check(page.locator("#timers-card").is_hidden() and page.locator("#timers-none").is_visible() and
          "keine systemd-Timer" in page.inner_text("#timers-none"), "the timers tab says there are none")
    show_tab(page, "overview")
    row(page, 1).locator("[data-key^=more]").click()
    check("umwandeln" not in page.inner_text("#row-menu"), "no conversion without systemd")
    check(not page.problems, "no console problems (no systemd): " + repr(page.problems))
    page.context.close()

    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.goto(BASE)
    wait_idle(page)
    page.evaluate("() => { window.__mock.failSystem = true; }")
    page.click("#reload")
    wait_js(page, "document.querySelector('#sys-alerts').innerText.length > 0")
    check("System crontabs" in page.inner_text("#sys-alerts") or "System-Crontabs" in page.inner_text("#sys-alerts"), "system read error alert")
    check(page.locator("#etc-card").is_hidden(), "etc hidden on error")
    page.context.close()

    browser.close()

srv.terminate()
print(f"\n{passed} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
