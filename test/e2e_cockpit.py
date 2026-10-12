"""End-to-end test against a real Cockpit, real crontab and a running cron daemon.

DESTRUCTIVE: replaces root's crontab and writes to /usr/local/libexec and
/var/lib/cockpit-cronjobs. Only for a throwaway machine or container, e.g.:

    apt install cockpit-ws cockpit-bridge cockpit-system cron
    ln -s "$PWD/src" /usr/share/cockpit/cronjobs
    cron
    /usr/lib/cockpit/cockpit-ws --no-tls --port 9091 --address 127.0.0.1 --local-session=cockpit-bridge &
    CRONJOBS_E2E_DESTRUCTIVE=1 python3 test/e2e_cockpit.py

Runs as root (the local session is root's)."""
import json, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

if os.environ.get("CRONJOBS_E2E_DESTRUCTIVE") != "1":
    sys.exit("refusing to run: set CRONJOBS_E2E_DESTRUCTIVE=1 on a throwaway machine")

URL = os.environ.get("COCKPIT_URL", "http://127.0.0.1:9091/cockpit/@localhost/cronjobs/index.html")
WRAP = "/usr/local/libexec/cockpit-cronjobs-run"
STATE = "/var/lib/cockpit-cronjobs"
SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(SHOTS, exist_ok=True)

failures = []
passed = 0


def check(cond, msg):
    global passed
    if cond:
        passed += 1
    else:
        failures.append(msg)
        print("FAIL:", msg)


def sh(cmd, input=None):
    return subprocess.run(cmd, shell=True, input=input, capture_output=True, text=True)


def crontab():
    r = sh("crontab -l -u root")
    return r.stdout if r.returncode == 0 else None


def wait_js(page, expr, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate("() => !!(" + expr + ")"):
            return True
        page.wait_for_timeout(50)
    raise TimeoutError("wait_js timed out: " + expr)


def wait_idle(page):
    wait_js(page, "!document.querySelector('#reload').disabled && !document.querySelector('#root-body .cron-state')")
    page.wait_for_timeout(200)


def row_of(page, text):
    return page.locator("#root-body tbody tr", has_text=text)


# A clean start: no wrapper, no state, a known crontab.
sh(f"rm -rf {STATE} {WRAP}")
sh("crontab -u root -", input="MAILTO=\"\"\n# Disk trim\n30 1 * * 0 /usr/sbin/fstrim -a\n")
if not sh("pgrep -x cron || pgrep -x crond").stdout.strip():
    sys.exit("cron is not running")

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_cookies([{"name": "CockpitLang", "value": "de-de", "url": URL}])
    page = ctx.new_page()
    problems = []
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
    page.goto(URL)
    wait_js(page, "document.querySelector('#meta').textContent.includes('Serverzeit')")
    wait_idle(page)

    check("Sonntags um 01:30" in page.inner_text("#root-body") and "Disk trim" in page.inner_text("#root-body"), "real crontab shown")
    check(page.locator("#root-body tbody tr").count() == 1, "one job")

    # add a recorded job that runs every minute: installs the run recorder first
    page.click("#add")
    page.fill("#f-schedule", "* * * * *")
    page.fill("#f-command", "echo hello-from-cron; echo to-stderr >&2; date +\\%F")
    check(page.is_checked("#f-capture"), "recording on by default")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    st = os.stat(WRAP) if os.path.exists(WRAP) else None
    check(st is not None and oct(st.st_mode & 0o777) == "0o755", "wrapper installed with 755")
    check(st and open(WRAP).read() == open(os.path.join(SRC, "cockpit-cronjobs-run")).read(), "installed wrapper is the shipped file")
    line = crontab().rstrip("\n").split("\n")[-1]
    m = re.fullmatch(r"\* \* \* \* \* " + re.escape(WRAP) + r" ([a-z0-9_-]+-[0-9a-f]{4}) 'echo hello-from-cron; echo to-stderr >&2; date \+\\%F'", line)
    check(m is not None, "wrapped line in crontab: " + repr(line))
    job_id = m.group(1) if m else "x"
    backups = os.listdir(STATE + "/backups") if os.path.isdir(STATE + "/backups") else []
    check(len(backups) == 1 and oct(os.stat(STATE + "/backups").st_mode & 0o777) == "0o700" and
          oct(os.stat(STATE + "/backups/" + backups[0]).st_mode & 0o777) == "0o600", "backup with tight permissions")

    # run now: through the wrapper, recorded as manual
    row = row_of(page, "hello-from-cron")
    row.locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    log = page.inner_text("#run-log")
    check("hello-from-cron" in log and "to-stderr" in log and re.search(r"\d{4}-\d\d-\d\d", log), "run output: " + repr(log))
    check("OK" in page.inner_text("#run-label"), "run ok")
    page.screenshot(path=os.path.join(SHOTS, "e2e-run.png"))
    page.click("#run-close-btn")
    page.wait_for_timeout(800)
    recs = [json.loads(l) for l in open(f"{STATE}/runs/{job_id}/runs.jsonl")]
    check(len(recs) == 1 and recs[0]["trigger"] == "manual" and recs[0]["rc"] == 0, "manual run recorded: " + repr(recs))

    # cron runs it on the next minute
    deadline = time.time() + 75
    while time.time() < deadline:
        recs = [json.loads(l) for l in open(f"{STATE}/runs/{job_id}/runs.jsonl")]
        if any(r["trigger"] == "schedule" for r in recs):
            break
        time.sleep(2)
    sched = [r for r in recs if r["trigger"] == "schedule"]
    check(sched and sched[0]["rc"] == 0 and sched[0]["bytes"] > 20, "cron ran the wrapped job: " + repr(recs))
    if sched:
        out = open(f"{STATE}/runs/{job_id}/{sched[0]['out']}.out").read()
        check(out.startswith("hello-from-cron\nto-stderr\n"), "cron output recorded: " + repr(out))
    page.click("#reload")
    wait_idle(page)
    check("OK" in row.locator("td[data-last]").inner_text(), "last run shown")
    row.locator("[data-key^='runs:']").click()
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 2")
    check("Manuell" in page.inner_text("#runs-body") and "Zeitplan" in page.inner_text("#runs-body"), "runs dialog lists both")
    page.locator("#runs-body [data-key^='out:']").first.click()
    wait_js(page, "document.querySelector('#runs-body pre') && document.querySelector('#runs-body pre').textContent.includes('hello-from-cron')")
    check(True, "output read through Cockpit")
    page.screenshot(path=os.path.join(SHOTS, "e2e-runs.png"))
    page.keyboard.press("Escape")

    # a long job: stop kills the whole process group
    page.click("#add")
    page.fill("#f-schedule", "0 3 * * *")
    page.fill("#f-command", "sleep 307; echo never")
    page.locator("#edit-dlg .az-switch").nth(0).click()
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(crontab().rstrip("\n").endswith("0 3 * * * sleep 307; echo never"), "unrecorded job added")
    row_of(page, "sleep 307").locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-running-actions').hidden")
    time.sleep(1.5)
    running = lambda: sh("ps -eo args=").stdout.split("\n").count("sleep 307")
    check(running() == 1, "job is running")
    page.click("#run-stop")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    time.sleep(0.8)
    check(running() == 0, "stop ended the job and its children")
    check("Angehalten" in page.inner_text("#run-label"), "stopped label")
    page.click("#run-close-btn")

    # % passes the rest as input, like cron
    page.click("#add")
    page.fill("#f-schedule", "0 4 * * *")
    page.fill("#f-command", "tr a-z A-Z%input line%second")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    row_of(page, "tr a-z A-Z").locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    check(page.inner_text("#run-log").strip() == "INPUT LINE\nSECOND", "stdin like cron: " + repr(page.inner_text("#run-log")))
    page.click("#run-close-btn")

    # output that is not UTF-8 does not end the run
    page.click("#add")
    page.fill("#f-schedule", "0 5 * * *")
    page.fill("#f-command", "printf 'M\\344rz\\n'; sleep 1; umask; echo after")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    row_of(page, "printf").locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    log = page.inner_text("#run-log")
    check("M\ufffdrz" in log and "after" in log and "OK" in page.inner_text("#run-label"), "latin-1 output survives: " + repr(log))
    page.click("#run-close-btn")
    page.wait_for_timeout(800)
    rec_id = re.search(r"cockpit-cronjobs-run (\S+) 'printf", crontab()).group(1)
    out_file = [f for f in os.listdir(f"{STATE}/runs/{rec_id}") if f.endswith(".out")]
    rec_out = open(f"{STATE}/runs/{rec_id}/{out_file[0]}", "rb").read() if out_file else b""
    check(b"M\xe4rz" in rec_out and b"\n0022\n" in rec_out, "recorded job keeps umask 022 and raw bytes: " + repr(rec_out))

    # switch off and on: byte-exact
    before = crontab()
    row_of(page, "fstrim").locator(".az-switch").click()
    wait_idle(page)
    check(crontab() == before.replace("30 1 * * 0 /usr/sbin/fstrim -a", "#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a"), "switch off")
    row_of(page, "fstrim").locator(".az-switch").click()
    wait_idle(page)
    check(crontab() == before, "switch on restores bytes")

    # recording off removes wrapper use and the runs
    row.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Erfassung ausschalten").click()
    page.click("#confirm-ok")
    wait_idle(page)
    check("* * * * * echo hello-from-cron; echo to-stderr >&2; date +\\%F" in crontab(), "unwrapped again")
    check(not os.path.exists(f"{STATE}/runs/{job_id}"), "runs deleted")

    # delete everything we added
    for text in ["hello-from-cron", "sleep 307", "tr a-z A-Z", "printf"]:
        row_of(page, text).locator("[data-key^='more:']").click()
        page.locator(".cron-menu__item", has_text="Löschen").click()
        page.click("#del-confirm")
        wait_js(page, "document.querySelector('#del-dlg').hidden")
        wait_idle(page)
    check(crontab() == "MAILTO=\"\"\n# Disk trim\n30 1 * * 0 /usr/sbin/fstrim -a\n", "back to the start: " + repr(crontab()))
    check(len(os.listdir(STATE + "/backups")) == 10, "ten backups kept: " + repr(len(os.listdir(STATE + "/backups"))))
    check(os.path.exists(STATE + "/.crontab.lock"), "lock in the state dir")
    page.screenshot(path=os.path.join(SHOTS, "e2e-end.png"), full_page=True)
    check(not problems, "no console errors: " + repr(problems))
    browser.close()

print(f"\n{passed} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
