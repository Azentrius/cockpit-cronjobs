# SPDX-License-Identifier: Apache-2.0
"""End-to-end test against a real Cockpit, real crontab and a running cron daemon.

DESTRUCTIVE: replaces root's crontab and writes to /usr/local/libexec and
/var/lib/cockpit-cronjobs. Only for a throwaway machine or container, e.g.:

    apt install cockpit-ws cockpit-bridge cockpit-system cron
    ln -s "$PWD/src" /usr/share/cockpit/cronjobs
    cron
    /usr/lib/cockpit/cockpit-ws --no-tls --port 9091 --address 127.0.0.1 --local-session=cockpit-bridge &
    CRONJOBS_E2E_DESTRUCTIVE=1 python3 test/e2e_cockpit.py

Runs as root (the local session is root's). CI runs it the same way on the runner's
throwaway VM (job e2e in .github/workflows/test.yml)."""
import json, os, pwd, re, shutil, subprocess, sys, time
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


def crontab_of(user):
    """The crontab of user, as bytes (None when there is none)."""
    r = subprocess.run(["crontab", "-l", "-u", user], capture_output=True)
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


# A clean start: no wrapper, no state, a known crontab; a second user with a crontab.
sh(f"rm -rf {STATE} {WRAP} /tmp/cj-e2e-whoami")
sh("crontab -u root -", input="MAILTO=\"\"\n# Disk trim\n30 1 * * 0 /usr/sbin/fstrim -a\n")
USER = "cjuser"
sh(f"id -u {USER} || useradd -m -s /bin/sh {USER}")
USER_TAB = "MAILTO=\"\"\n# reports for cjuser\n15 3 * * * /bin/true\n"
# Who runs a job, where and with which environment, all of it: from cron, with run now, as a unit.
WHO = "id -un; pwd; env | sort"
# What systemd gives every service for its own bookkeeping; a converted job may have these too.
SYSTEMD_OWN = {"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE"}


def who_parts(text):
    """(user, working directory, {NAME: value}) from the output of WHO."""
    lines = (text or "").rstrip("\n").split("\n")
    return (lines[0] if lines else None, lines[1] if len(lines) > 1 else None,
            dict(line.split("=", 1) for line in lines[2:] if "=" in line))


def env_diff(a, b, ignore=()):
    """{NAME: (a's value, b's value)} for every variable the two environments do not share."""
    names = (set(a) | set(b)) - set(ignore)
    return {k: (a.get(k), b.get(k)) for k in sorted(names) if a.get(k) != b.get(k)}


def read(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read()


def wait_file(path, timeout=75):
    deadline = time.time() + timeout
    while time.time() < deadline and not os.path.exists(path):
        time.sleep(2)
    time.sleep(1)   # the job may still be writing
    return read(path)


# /etc/environment as pam_env reads it: cron gives these to every job, so run now and a
# converted unit must too (quotes, "export", a comment that ends the value)
ETC_ENV = "/etc/environment"
etc_env_before = read(ETC_ENV)
with open(ETC_ENV, "a") as f:
    f.write("\n# cj-e2e\nexport CJ_E2E_EXPORT=\"quoted value\"\nCJ_E2E_PLAIN=plain # a comment\n"
            "CJ_E2E_SINGLE='single'\nCJ_E2E_INNER=\"a\"b\"\n")
sh(f"crontab -u {USER} -", input=USER_TAB)
if not sh("pgrep -x cron || pgrep -x crond").stdout.strip():
    sys.exit("cron is not running")

# One entry in /etc/cron.d per rule of Debian's cron (see C.cronDSkip), created now so
# that cron has read them by the end: name -> (reason the page gives, what cron logs).
CROND_DIR = "/etc/cron.d"
CROND_SRC = "/etc/cj-e2e"
CROND = {
    "cj-e2e-ok": (None, None),
    "cj-e2e-exec": (None, None),
    "cj-e2e-link": (None, None),
    "cj-e2e-linkuser": ("linkOwner", "WRONG SYMLINK OWNER"),
    "cj-e2e-broken": ("broken", "CAN'T OPEN SYMLINK"),
    "cj-e2e-owner": ("owner", "WRONG FILE OWNER"),
    "cj-e2e-dir": ("notFile", "NOT A REGULAR FILE"),
    "cj-e2e-writable": ("writable", "INSECURE MODE"),
    "cj-e2e-hard": ("links", "NUMBER OF HARD LINKS > 1"),
}
crond_since = int(time.time())
sh(f"rm -rf {CROND_SRC} {CROND_DIR}/cj-e2e-*")
os.makedirs(CROND_SRC)


def crond_file(path, mode=0o644):
    with open(path, "w") as f:
        f.write(f"0 5 1 1 * root true {os.path.basename(path)}\n")
    os.chmod(path, mode)


crond_file(f"{CROND_DIR}/cj-e2e-ok")
crond_file(f"{CROND_DIR}/cj-e2e-exec", 0o755)
crond_file(f"{CROND_SRC}/link")
os.symlink(f"{CROND_SRC}/link", f"{CROND_DIR}/cj-e2e-link")
crond_file(f"{CROND_SRC}/linkuser")
os.symlink(f"{CROND_SRC}/linkuser", f"{CROND_DIR}/cj-e2e-linkuser")
os.lchown(f"{CROND_DIR}/cj-e2e-linkuser", 65534, 65534)
os.symlink(f"{CROND_SRC}/missing", f"{CROND_DIR}/cj-e2e-broken")
crond_file(f"{CROND_DIR}/cj-e2e-owner")
os.chown(f"{CROND_DIR}/cj-e2e-owner", 65534, 65534)
os.mkdir(f"{CROND_DIR}/cj-e2e-dir")
crond_file(f"{CROND_DIR}/cj-e2e-writable", 0o664)
crond_file(f"{CROND_DIR}/cj-e2e-hard")
os.link(f"{CROND_DIR}/cj-e2e-hard", f"{CROND_SRC}/hard")

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_cookies([{"name": "CockpitLang", "value": "de-de", "url": URL}])
    page = ctx.new_page()
    problems = []
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
    # The console names the status of a failed load, not the file.
    page.on("response", lambda r: problems.append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None)
    page.goto(URL)
    wait_js(page, "document.querySelector('#meta').textContent.includes('Serverzeit')")
    wait_idle(page)

    check("Sonntags um 01:30" in page.inner_text("#root-body") and "Disk trim" in page.inner_text("#root-body"), "real crontab shown")
    check(page.locator("#root-body tbody tr").count() == 1, "one job")
    check(page.inner_text("#reload").strip() == "Aktualisieren" and page.inner_text("#tabs").startswith("Übersicht"),
          "page frame under real Cockpit: Refresh and tabs")

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
    # the job runs every minute, so cron may already have recorded a scheduled run as well
    manual = [r for r in recs if r["trigger"] == "manual"]
    check(len(manual) == 1 and manual[0]["rc"] == 0 and all(r["trigger"] in ("manual", "schedule") for r in recs),
          "manual run recorded: " + repr(recs))

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
    page.locator("#edit-dlg .cron-checkbox").nth(0).click()
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
    page.fill("#f-command", "printf 'caf\\351\\n'; sleep 1; umask; echo after")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    row_of(page, "printf").locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    log = page.inner_text("#run-log")
    check("caf\ufffd" in log and "after" in log and "OK" in page.inner_text("#run-label"), "latin-1 output survives: " + repr(log))
    page.click("#run-close-btn")
    page.wait_for_timeout(800)
    rec_id = re.search(r"cockpit-cronjobs-run (\S+) 'printf", crontab()).group(1)
    out_file = [f for f in os.listdir(f"{STATE}/runs/{rec_id}") if f.endswith(".out")]
    rec_out = open(f"{STATE}/runs/{rec_id}/{out_file[0]}", "rb").read() if out_file else b""
    check(b"caf\xe9" in rec_out and b"\n0022\n" in rec_out, "recorded job keeps umask 022 and raw bytes: " + repr(rec_out))

    # switch off and on: byte-exact
    before = crontab()
    row_of(page, "fstrim").locator(".az-switch").click()
    wait_idle(page)
    check(crontab() == before.replace("30 1 * * 0 /usr/sbin/fstrim -a", "#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a"), "switch off")
    row_of(page, "fstrim").locator(".az-switch").click()
    wait_idle(page)
    check(crontab() == before, "switch on restores bytes")

    # convert to a systemd timer and back: units written and running, then gone again,
    # and the crontab byte for byte as before
    unit = "cj-e2e-fstrim"
    row_of(page, "fstrim").locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    page.fill("#conv-name", unit)
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    check("stimmen überein" in page.inner_text("#conv-check"), "schedule checked with systemd-analyze")
    page.click("#conv-ok")
    wait_js(page, "document.querySelector('#conv-dlg').hidden")
    wait_idle(page)
    converted = crontab()
    check(f"\n# Converted to systemd timer {unit}.timer by Cockpit Cron Jobs on " in converted and
          "\n#[cronjobs:off] 30 1 * * 0 /usr/sbin/fstrim -a\n" in converted, "line off with a note: " + repr(converted))
    check(sh(f"systemctl is-enabled {unit}.timer").stdout.strip() == "enabled" and
          sh(f"systemctl is-active {unit}.timer").stdout.strip() == "active", "timer enabled and active")
    check(not os.path.exists(f"{STATE}/converting/{unit}") and
          oct(os.stat(f"{STATE}/converting").st_mode & 0o777) == "0o700", "a finished conversion keeps no token")
    check("Umgewandelt in systemd-Timer" in row_of(page, "fstrim").inner_text(), "converted job recognised")
    row_of(page, "fstrim").locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    check("angelegt" in page.inner_text("#back-check"), "units recognised as ours: " + page.inner_text("#back-check"))
    page.screenshot(path=os.path.join(SHOTS, "e2e-back.png"))
    page.click("#back-ok")
    wait_js(page, "document.querySelector('#back-dlg').hidden")
    wait_idle(page)
    check(crontab() == before, "back to cron: crontab byte for byte as before: " + repr(crontab()))
    check(not os.path.exists(f"/etc/systemd/system/{unit}.service") and not os.path.exists(f"/etc/systemd/system/{unit}.timer"),
          "unit files removed")
    check(sh(f"systemctl is-active {unit}.timer").stdout.strip() != "active" and
          unit not in sh("systemctl list-units --all --no-legend 'cj-e2e-*'").stdout, "timer gone from systemd")

    # recording off removes wrapper use and the runs
    row.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Erfassung ausschalten").click()
    page.click("#confirm-ok")
    wait_idle(page)
    check("* * * * * echo hello-from-cron; echo to-stderr >&2; date +\\%F" in crontab(), "unwrapped again")
    check(not os.path.exists(f"{STATE}/runs/{job_id}"), "runs deleted")

    # a recorded line removed by hand leaves its runs behind; they are offered and removed on request,
    # but not while another crontab still mentions the ID
    sh("crontab -u root -", input="".join(l + "\n" for l in crontab().rstrip("\n").split("\n") if f" {rec_id} " not in l))
    with open("/etc/cron.d/cronjobs-e2e", "w") as f:
        f.write(f"# {rec_id} is kept while this file mentions it\n")
    page.click("#reload")
    wait_idle(page)
    check(page.locator("#orphans").is_hidden(), "an ID mentioned in /etc/cron.d is not offered")
    os.remove("/etc/cron.d/cronjobs-e2e")
    page.click("#reload")
    wait_idle(page)
    check(page.locator("#orphans").is_visible(), "leftover runs offered")
    page.click("[data-key=orphans]")
    check(rec_id in page.inner_text("#orph-body") and "KiB" in page.inner_text("#orph-body"),
          "leftover job listed with its size: " + page.inner_text("#orph-body"))
    page.screenshot(path=os.path.join(SHOTS, "e2e-orphans.png"))
    page.click(f"[data-key='orph:{rec_id}']")
    wait_js(page, "document.querySelector('#orph-dlg').hidden")
    wait_idle(page)
    check(not os.path.exists(f"{STATE}/runs/{rec_id}"), "leftover runs removed")
    check(page.locator("#orphans").is_hidden(), "no leftover line any more")

    # delete everything we added
    for text in ["hello-from-cron", "sleep 307", "tr a-z A-Z"]:
        row_of(page, text).locator("[data-key^='more:']").click()
        page.locator(".cron-menu__item", has_text="Löschen").click()
        page.click("#del-confirm")
        wait_js(page, "document.querySelector('#del-dlg').hidden")
        wait_idle(page)
    check(crontab() == "MAILTO=\"\"\n# Disk trim\n30 1 * * 0 /usr/sbin/fstrim -a\n", "back to the start: " + repr(crontab()))
    check(len(os.listdir(STATE + "/backups")) == 10, "ten backups kept: " + repr(len(os.listdir(STATE + "/backups"))))
    check(os.path.exists(STATE + "/.crontab.lock"), "lock in the state dir")

    # cron's environment, all of it: the same command from cron, with run now and as a converted
    # unit sees the same user, directory and variables (PAM's from /etc/environment and the
    # locale, the crontab's, cron's own; no USER from Debian's cron)
    start = crontab()
    sh("rm -f /tmp/cj-e2e-root-cron /tmp/cj-e2e-root-out")
    sh("crontab -u root -", input=start + "* * * * * { " + WHO + "; } > /tmp/cj-e2e-root-cron\n"
                                          "0 5 1 1 * { " + WHO + "; } > /tmp/cj-e2e-root-out\n")
    page.click("#reload")
    wait_idle(page)
    by_cron = who_parts(wait_file("/tmp/cj-e2e-root-cron"))
    check(by_cron[0] == "root" and by_cron[1] == "/root" and by_cron[2].get("CJ_E2E_EXPORT") == "quoted value" and
          "USER" not in by_cron[2], "cron ran the job as root with /etc/environment: " + repr(by_cron))
    who_row = row_of(page, "0 5 1 1 *")   # yearly: the conversion checks its next 5 runs too
    who_row.locator("[data-key^='run:']").click()
    check("Außerdem gesetzt:" in page.inner_text("#run-env") and "CJ_E2E_EXPORT" in page.inner_text("#run-env"),
          "the run dialog names the other variables: " + page.inner_text("#run-env"))
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    page.click("#run-close-btn")
    by_now = who_parts(read("/tmp/cj-e2e-root-out"))
    check(by_now[:2] == by_cron[:2] and not env_diff(by_cron[2], by_now[2]),
          "run now: the environment cron gives, all of it: " + repr(env_diff(by_cron[2], by_now[2])))
    unit = "cj-e2e-who"
    who_row.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    page.fill("#conv-name", unit)
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    page.click("#conv-ok")
    wait_js(page, "document.querySelector('#conv-dlg').hidden")
    wait_idle(page)
    os.remove("/tmp/cj-e2e-root-out")
    started = sh(f"systemctl start {unit}.service")
    by_unit = who_parts(read("/tmp/cj-e2e-root-out"))
    check(started.returncode == 0 and by_unit[:2] == by_cron[:2] and not env_diff(by_cron[2], by_unit[2], SYSTEMD_OWN),
          "the converted unit: the environment cron gives, all of it: " + started.stderr +
          repr(env_diff(by_cron[2], by_unit[2], SYSTEMD_OWN)) + "\n" + (read(f"/etc/systemd/system/{unit}.service") or ""))
    # the converted job keeps its history: the run of its service, from the journal
    page.click("#reload")
    wait_idle(page)
    check("OK" in who_row.locator("td[data-last]").inner_text(), "the converted row shows the service's last run: " +
          who_row.locator("td[data-last]").inner_text())
    who_row.locator("[data-key^='runs:']").click()
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 1", timeout=30)
    runs_rows = page.locator("#runs-body tbody tr").all_inner_texts()
    check(len(runs_rows) == 1 and "OK" in runs_rows[0] and "systemd" in runs_rows[0] and f"{unit}.service" in page.inner_text("#runs-note"),
          "its run from the journal: " + repr(runs_rows))
    page.click("#runs-close-btn")
    who_row.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    page.click("#back-ok")
    wait_js(page, "document.querySelector('#back-dlg').hidden")
    wait_idle(page)
    check(not os.path.exists(f"/etc/systemd/system/{unit}.service"), "back to cron: the unit removed")
    sh("crontab -u root -", input=start)
    sh("rm -f /tmp/cj-e2e-root-cron /tmp/cj-e2e-root-out")
    page.click("#reload")
    wait_idle(page)
    check(crontab() == start, "root's crontab as before")

    # backups: listed as on disk, the difference as diff shows it, restoring and restoring back gives the original bytes
    def crontab_bytes():
        return subprocess.run(["crontab", "-l", "-u", "root"], capture_output=True, check=True).stdout

    def backup_path(name):
        return os.path.join(STATE, "backups", name)

    def shown_changes():
        return page.evaluate("""() => Array.from(document.querySelectorAll('.cron-diff__line'))
            .filter(d => d.dataset.op !== ' ').map(d => d.dataset.op + d.querySelector('.cron-diff__text').textContent)""")

    original = crontab_bytes()
    with open("/tmp/cj-e2e-current", "wb") as f:
        f.write(original)
    on_disk = sorted(os.listdir(STATE + "/backups"), key=lambda n: os.stat(backup_path(n)).st_mtime_ns, reverse=True)
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 10")
    names = page.locator("#bk-body tbody tr td:first-child .az-mono").all_inner_texts()
    check(names == on_disk, "backups listed newest first, as on disk: " + repr(names) + " " + repr(on_disk))
    for name in on_disk[:3]:
        page.click(f"[data-key='bk:{name}']")
        wait_js(page, "document.querySelector('.cron-diff')")
        by_diff = subprocess.run(["diff", "--old-line-format=-%L", "--new-line-format=+%L", "--unchanged-line-format=",
                                  "/tmp/cj-e2e-current", backup_path(name)], capture_output=True).stdout.decode().splitlines()
        check(shown_changes() == by_diff, f"difference to {name} as diff shows it: {shown_changes()!r} {by_diff!r}")
        page.click(f"[data-key='bk:{name}']")
    target = on_disk[1]
    with open(backup_path(target), "rb") as f:
        wanted = f.read()
    page.click(f"[data-key='bk:{target}']")
    page.screenshot(path=os.path.join(SHOTS, "e2e-backups.png"))
    page.click(f"[data-key='restore:{target}']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(crontab_bytes() == wanted, "restored byte for byte: " + repr(crontab_bytes()))
    check("wiederhergestellt" in page.inner_text("#alerts"), "restored alert: " + page.inner_text("#alerts"))
    page.click("#backups")
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 10")
    newest = page.locator("#bk-body tbody tr td:first-child .az-mono").first.inner_text()
    with open(backup_path(newest), "rb") as f:
        check(f.read() == original, "the version before the restore is the newest backup")
    page.click(f"[data-key='bk:{newest}']")
    page.click(f"[data-key='restore:{newest}']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(crontab_bytes() == original, "restoring back gives the original bytes: " + repr(crontab_bytes()))
    os.remove("/tmp/cj-e2e-current")

    # the latest results: a recorded job and a systemd timer that fail show up within a minute of
    # their run, failed first, while the page stays open (it reads runs and timers every half minute)
    start = crontab()
    sh("crontab -u root -", input=start + f"* * * * * {WRAP} sumfail-0001 'echo about to fail; exit 3'\n")
    fail_timer = "cj-e2e-fail"
    r = sh(f"systemd-run --unit={fail_timer} --on-calendar='*-*-* *:*:00' --timer-property=AccuracySec=1s "
           "/bin/sh -c 'echo failing from systemd; exit 1'")
    check(r.returncode == 0, "a failing timer: " + r.stderr)
    page.click("#reload")
    wait_idle(page)
    loaded = time.time()
    deadline = loaded + 100
    rows = []
    while time.time() < deadline:
        rows = page.locator("#sum-body tbody tr").all_inner_texts() if page.locator("#sum-card").is_visible() else []
        if any("exit 3" in x.lower() and "about to fail" in x for x in rows) and any(fail_timer + ".timer" in x and "exit 1" in x.lower() for x in rows):
            break
        time.sleep(2)
    took = time.time() - loaded
    check(any("Fehler · Exit 3" in x and "about to fail" in x and "root-Crontab" in x for x in rows) and
          any(fail_timer + ".timer" in x and "Fehler · Exit 1" in x for x in rows) and took < 100,
          f"the failing job and timer in the latest results after {took:.0f} s, without reloading: " + repr(rows))
    fails = [i for i, x in enumerate(rows) if "Fehler" in x]
    check(fails and fails == list(range(len(fails))), "failures first: " + repr(rows))
    page.locator("#sum-card").scroll_into_view_if_needed()
    page.screenshot(path=os.path.join(SHOTS, "e2e-summary.png"))
    # the timer's runs, from the journal: failed, with what it wrote
    page.click(f"[data-key='sum-timer:{fail_timer}.timer']")
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 1", timeout=30)
    jrows = page.locator("#runs-body tbody tr").all_inner_texts()
    check(jrows and all("Fehler · Exit 1" in x for x in jrows), "the timer's runs from the journal: " + repr(jrows))
    page.locator("#runs-body [data-key^='out:']").first.click()
    wait_js(page, "document.querySelector('#runs-body pre')")
    check(page.text_content("#runs-body pre") == "failing from systemd", "its output: " + repr(page.text_content("#runs-body pre")))
    page.screenshot(path=os.path.join(SHOTS, "e2e-journal-runs.png"))
    page.click("#runs-close-btn")
    sh(f"systemctl stop {fail_timer}.timer; systemctl reset-failed {fail_timer}.service {fail_timer}.timer")
    sh("crontab -u root -", input=start)
    shutil.rmtree(f"{STATE}/runs/sumfail-0001", ignore_errors=True)
    page.click("#reload")
    wait_idle(page)
    check(crontab() == start and fail_timer not in page.inner_text("#sum-body"), "back as before")

    # another user's crontab: a card of its own, written as that user's crontab with backups of its own,
    # and cron runs the jobs as that user
    card = page.locator(f"#user-crontabs section[data-user='{USER}']")
    check(card.count() == 1 and f"Crontab von {USER}" in card.inner_text() and "Täglich um 03:15" in card.inner_text(),
          "a card for the crontab of " + USER)
    start = crontab_of(USER)
    check(start == USER_TAB.encode(), "the user's crontab as written: " + repr(start))
    card.locator("label.az-switch").filter(has=page.locator(f"[data-key='toggle:{USER}:2']")).click()
    wait_idle(page)
    check(crontab_of(USER) == start.replace(b"15 3 * * *", b"#[cronjobs:off] 15 3 * * *"), "switched off: " + repr(crontab_of(USER)))
    card.locator("label.az-switch").filter(has=page.locator(f"[data-key='toggle:{USER}:2']")).click()
    wait_idle(page)
    check(crontab_of(USER) == start, "switched on again: the bytes from before")
    card.locator(f"[data-key='add:{USER}']").click()
    page.fill("#f-schedule", "* * * * *")
    page.fill("#f-command", "{ " + WHO + "; } > /tmp/cj-e2e-whoami")
    page.locator("label.cron-checkbox").filter(has=page.locator("#f-capture")).click()   # the plain line; recording comes below
    check(not page.is_checked("#f-capture"), "recording off for the plain job")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    check(crontab_of(USER) == start + ("* * * * * { " + WHO + "; } > /tmp/cj-e2e-whoami\n").encode(),
          "job added: " + repr(crontab_of(USER)))
    user_backups = f"{STATE}/backups/users/{USER}"
    names = sorted(os.listdir(user_backups)) if os.path.isdir(user_backups) else []
    check(len(names) == 3 and all(n.startswith(USER + "-") for n in names) and
          oct(os.stat(user_backups).st_mode & 0o777) == "0o700" and
          all(oct(os.stat(f"{user_backups}/{n}").st_mode & 0o777) == "0o600" for n in names),
          "backups of the user's own, with tight permissions: " + repr(names))
    deadline = time.time() + 75
    while time.time() < deadline and not os.path.exists("/tmp/cj-e2e-whoami"):
        time.sleep(2)
    time.sleep(1)   # the job may still be writing
    who = open("/tmp/cj-e2e-whoami").read() if os.path.exists("/tmp/cj-e2e-whoami") else None
    check(who is not None and who.split("\n")[0] == USER and os.stat("/tmp/cj-e2e-whoami").st_uid == pwd.getpwnam(USER).pw_uid,
          "cron ran the new job as " + USER + ": " + repr(who))
    card.locator(f"[data-key='backups:{USER}']").click()
    wait_js(page, "document.querySelectorAll('#bk-body tbody tr').length === 3")
    oldest = page.locator("#bk-body tbody tr td:first-child .az-mono").last.inner_text()
    with open(f"{user_backups}/{oldest}", "rb") as fh:
        check(fh.read() == start, "the oldest backup is the crontab from the start")
    page.click(f"[data-key='bk:{oldest}']")
    page.click(f"[data-key='restore:{oldest}']")
    wait_js(page, "document.querySelector('#bk-dlg').hidden")
    wait_idle(page)
    check(crontab_of(USER) == start, "restored byte for byte: " + repr(crontab_of(USER)))
    check(crontab() == "MAILTO=\"\"\n# Disk trim\n30 1 * * 0 /usr/sbin/fstrim -a\n", "root's crontab untouched")
    # run now: as cron ran it above, the same user, working directory and environment
    card.locator(f"[data-key='add:{USER}']").click()
    page.fill("#f-schedule", "0 5 1 1 *")
    page.fill("#f-command", WHO)
    page.locator("label.cron-checkbox").filter(has=page.locator("#f-capture")).click()
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    card.locator("tbody tr", has_text="0 5 1 1 *").locator("[data-key^='run:']").click()
    check(f"als {USER} ausgeführt" in page.inner_text("#run-intro"), "run dialog names the user: " + page.inner_text("#run-intro"))
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    log = page.text_content("#run-log")   # not inner_text: a value may end in a space
    cron_ran, now_ran = who_parts(who), who_parts(log)
    check("OK" in page.inner_text("#run-label") and cron_ran[0] == now_ran[0] == USER and cron_ran[1] == now_ran[1] and
          not env_diff(cron_ran[2], now_ran[2]) and cron_ran[2].get("CJ_E2E_INNER") == "a\"b",
          "run now: the user, working directory and environment cron gave, all of it: " +
          repr(env_diff(cron_ran[2], now_ran[2])) + " " + repr(log))
    page.screenshot(path=os.path.join(SHOTS, "e2e-user-run.png"))
    page.click("#run-close-btn")

    # recording a job of the second user: the runs land in the user's own directory, written by the user
    card.locator(f"[data-key='add:{USER}']").click()
    page.fill("#f-schedule", "* * * * *")
    page.fill("#f-command", "echo recorded-for-" + USER)
    check(page.is_checked("#f-capture"), "recording on by default for the user's job")
    page.click("#edit-save")
    wait_js(page, "document.querySelector('#edit-dlg').hidden")
    wait_idle(page)
    line = crontab_of(USER).decode().rstrip("\n").split("\n")[-1]
    m = re.fullmatch(r"\* \* \* \* \* " + re.escape(WRAP) + r" ([a-z0-9_-]+-[0-9a-f]{4}) 'echo recorded-for-" + USER + "'", line)
    check(m is not None, "the user's line goes through the run recorder: " + repr(line))
    uid = pwd.getpwnam(USER).pw_uid
    home = os.stat(f"{STATE}/users/{USER}")
    check(oct(os.stat(STATE).st_mode & 0o777) == "0o711" and oct(os.stat(f"{STATE}/users").st_mode & 0o777) == "0o711" and
          oct(home.st_mode & 0o777) == "0o700" and home.st_uid == uid,
          "a directory of the user's own for its runs, reachable but not listable")
    rec_dir = f"{STATE}/users/{USER}/runs/{m.group(1) if m else 'x'}"
    deadline = time.time() + 75
    recs = []
    while time.time() < deadline and not recs:
        if os.path.exists(rec_dir + "/runs.jsonl"):
            recs = [json.loads(x) for x in open(rec_dir + "/runs.jsonl")]
        if not recs:
            time.sleep(2)
    check(any(r["trigger"] == "schedule" and r["rc"] == 0 for r in recs) and os.stat(rec_dir).st_uid == uid,
          "cron ran the user's job through the recorder, as the user: " + repr(recs))
    if recs and recs[0]["out"]:
        out_file = f"{rec_dir}/{recs[0]['out']}.out"
        check(open(out_file).read() == f"recorded-for-{USER}\n" and os.stat(out_file).st_uid == uid, "the output recorded")
    page.click("#reload")
    wait_idle(page)
    row = card.locator("tbody tr", has_text="recorded-for-" + USER)
    check("OK" in row.locator("td[data-last]").inner_text(), "the last run in the user's card: " + row.inner_text())
    # run now goes through the recorder too, as the user
    row.locator("[data-key^='run:']").click()
    page.click("#run-start")
    wait_js(page, "!document.querySelector('#run-done-actions').hidden")
    check("OK" in page.inner_text("#run-label") and "recorded-for-" + USER in page.inner_text("#run-log"),
          "run now of the user's recorded job: " + page.inner_text("#run-log"))
    page.click("#run-close-btn")
    page.wait_for_timeout(800)
    manual = [r for r in (json.loads(x) for x in open(rec_dir + "/runs.jsonl")) if r["trigger"] == "manual"]
    check(len(manual) == 1 and manual[0]["rc"] == 0, "run now recorded in the user's directory: " + repr(manual))
    row.locator("[data-key^='runs:']").click()
    wait_js(page, "document.querySelectorAll('#runs-body tbody tr').length >= 1")
    check(f"/var/lib/cockpit-cronjobs/users/{USER}/runs/" in page.inner_text("#runs-note"), "the runs dialog names the user's directory")
    page.locator("#runs-body [data-key^='out:']").first.click()
    wait_js(page, "document.querySelector('#runs-body pre') && document.querySelector('#runs-body pre').textContent.includes('recorded-for-')")
    check(True, "the user's output read through Cockpit")
    page.screenshot(path=os.path.join(SHOTS, "e2e-user-runs.png"))
    page.keyboard.press("Escape")
    row.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Erfassung ausschalten").click()
    page.click("#confirm-ok")
    wait_idle(page)
    check(crontab_of(USER).decode().rstrip("\n").split("\n")[-1] == "* * * * * echo recorded-for-" + USER and
          not os.path.exists(rec_dir), "recording off: the plain line, the user's runs gone")

    # the user's directory belongs to the user: a link there leads nowhere the user could not go.
    # With the runs directory a link to a directory of root's, nothing there shows up as runs, and
    # turning recording off for a line that names a directory there removes nothing of root's.
    root_only = "/tmp/cj-e2e-root-only"
    os.makedirs(root_only + "/trap-0001", exist_ok=True)
    with open(root_only + "/trap-0001/runs.jsonl", "w") as fh:
        fh.write('{"start":1,"end":2,"rc":0,"trigger":"schedule","bytes":0,"truncated":false,"out":""}\n')
    user_runs = f"{STATE}/users/{USER}/runs"
    shutil.rmtree(user_runs, ignore_errors=True)
    os.symlink(root_only, user_runs)
    os.lchown(user_runs, uid, -1)
    r = sh(f"crontab -u {USER} -", input=crontab_of(USER).decode() + f"0 4 1 1 * {WRAP} trap-0001 'true'\n")
    check(r.returncode == 0, "a recorded line of the user's own: " + r.stderr)
    page.click("#reload")
    wait_idle(page)
    trap = card.locator("tbody tr", has_text="0 4 1 1 *")
    check(trap.count() == 1 and "OK" not in trap.locator("td[data-last]").inner_text(),
          "nothing behind the link shown as runs: " + trap.inner_text())
    trap.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Erfassung ausschalten").click()
    page.click("#confirm-ok")
    wait_idle(page)
    page.wait_for_timeout(1500)
    check(crontab_of(USER).decode().rstrip("\n").split("\n")[-1] == "0 4 1 1 * true" and
          os.path.isfile(root_only + "/trap-0001/runs.jsonl"),
          "recording off: the plain line, root's directory behind the link untouched")
    os.remove(user_runs)
    shutil.rmtree(root_only)

    # converting a job of the second user: the unit runs it as that user, in its home, with the
    # environment cron gives it there; back to cron gives the crontab back byte for byte
    sh("rm -f /tmp/cj-e2e-user-unit")
    sh(f"crontab -u {USER} -", input=crontab_of(USER).decode() + "0 6 29 2 * { " + WHO + "; } > /tmp/cj-e2e-user-unit\n")
    page.click("#reload")
    wait_idle(page)
    conv_before = crontab_of(USER)
    user_unit = "cj-e2e-user-who"
    urow = card.locator("tbody tr", has_text="0 6 29 2 *")
    urow.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="In systemd-Timer umwandeln").click()
    page.fill("#conv-name", user_unit)
    wait_js(page, "!document.querySelector('#conv-ok').disabled")
    check(f"als {USER}" in page.inner_text("#conv-intro"), "the dialog says as whom it runs: " + page.inner_text("#conv-intro"))
    page.click("#conv-ok")
    wait_js(page, "document.querySelector('#conv-dlg').hidden")
    wait_idle(page)
    unit_text = read(f"/etc/systemd/system/{user_unit}.service") or ""
    check(unit_text.startswith(f"# Created by Cockpit Cron Jobs from this line of the crontab of {USER}:\n") and
          f"\nUser={USER}\n" in unit_text and sh(f"systemctl is-active {user_unit}.timer").stdout.strip() == "active",
          "the unit of the user's job, timer running: " + unit_text)
    started = sh(f"systemctl start {user_unit}.service")
    by_unit = who_parts(read("/tmp/cj-e2e-user-unit"))
    check(started.returncode == 0 and by_unit[0] == USER and by_unit[1] == cron_ran[1] and
          os.path.exists("/tmp/cj-e2e-user-unit") and os.stat("/tmp/cj-e2e-user-unit").st_uid == uid and
          not env_diff(cron_ran[2], by_unit[2], SYSTEMD_OWN),
          "the converted unit runs as the user, where and with what cron gives it: " + started.stderr +
          repr(env_diff(cron_ran[2], by_unit[2], SYSTEMD_OWN)) + "\n" + unit_text)
    urow.locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "!document.querySelector('#back-ok').disabled")
    page.click("#back-ok")
    wait_js(page, "document.querySelector('#back-dlg').hidden")
    wait_idle(page)
    check(crontab_of(USER) == conv_before and not os.path.exists(f"/etc/systemd/system/{user_unit}.service") and
          not os.path.exists(f"/etc/systemd/system/{user_unit}.timer"),
          "back to cron: the user's crontab byte for byte, the units gone: " + repr(crontab_of(USER)))
    # a note the user writes into their own crontab, naming units converted from root's: not theirs, nothing removed
    fake = "cj-e2e-rootjob"
    with open(f"/etc/systemd/system/{fake}.service", "w") as f:
        f.write("# Created by Cockpit Cron Jobs from this line of the root crontab:\n#   0 2 1 * * true\n[Unit]\n"
                f"Description={fake} (from the root crontab)\n\n[Service]\nType=oneshot\nUser=root\nExecStart=/bin/true\n")
    with open(f"/etc/systemd/system/{fake}.timer", "w") as f:
        f.write(f"[Unit]\nDescription={fake} (from the root crontab)\n\n[Timer]\nOnCalendar=*-*-01 02:00:00\n")
    forged_before = crontab_of(USER)
    sh(f"crontab -u {USER} -", input=forged_before.decode() + f"# Converted to systemd timer {fake}.timer by Cockpit Cron Jobs "
       "on 2026-10-14; the line below is no longer used.\n#[cronjobs:off] 0 2 1 * * true\n")
    page.click("#reload")
    wait_idle(page)
    card.locator("tbody tr", has_text="0 2 1 * *").locator("[data-key^='more:']").click()
    page.locator(".cron-menu__item", has_text="Zurück zu cron").click()
    wait_js(page, "document.querySelector('#back-check').classList.contains('is-bad')")
    check(page.is_disabled("#back-ok") and os.path.exists(f"/etc/systemd/system/{fake}.service"),
          "root's units are not the user's to remove: " + page.inner_text("#back-check"))
    page.keyboard.press("Escape")
    os.remove(f"/etc/systemd/system/{fake}.service")
    os.remove(f"/etc/systemd/system/{fake}.timer")
    sh(f"crontab -u {USER} -", input=forged_before.decode())
    page.click("#reload")
    wait_idle(page)
    page.locator(f"#user-crontabs section[data-user='{USER}']").scroll_into_view_if_needed()
    page.screenshot(path=os.path.join(SHOTS, "e2e-user.png"))

    # /etc/cron.d: the page marks exactly what cron skips, with cron's reason, and cron's log agrees
    page.click("#reload")
    wait_idle(page)
    why_text = {"linkOwner": "Link ist, der nicht root gehört", "broken": "Link ins Leere", "owner": "weil sie nicht root gehört",
                "notFile": "keine normale Datei", "writable": "Gruppe oder andere", "links": "mehr als einen Hardlink"}
    shown = page.evaluate("""() => Object.fromEntries(Array.from(document.querySelectorAll('#crond-body tbody tr')).map(tr => [
        tr.querySelector('.az-mono').textContent, (tr.querySelector('.cron-ignored-why') || {}).textContent || null]))""")
    for name, (reason, _) in CROND.items():
        why = shown.get(name, "not listed")
        good = why is None if reason is None else (why not in (None, "not listed") and why_text[reason] in why)
        check(good, f"cron.d {name}: page shows {why!r}, cron's reason is {reason}")
    page.click("#tab-system")
    page.locator("#crond-card").scroll_into_view_if_needed()
    page.screenshot(path=os.path.join(SHOTS, "e2e-crond.png"))

    def cron_says(name, log):
        path = re.compile(re.escape(f"{CROND_DIR}/{name}") + r"(\)|\s|$)")
        return [line for line in log.split("\n") if path.search(line)]

    def cron_log():
        return sh(f"journalctl -u cron --no-pager -o cat --since @{crond_since}").stdout

    expected = [(name, msg) for name, (_, msg) in CROND.items() if msg]
    deadline = time.time() + 75
    log = cron_log()
    while time.time() < deadline and not all(any(msg in line for line in cron_says(name, log)) for name, msg in expected):
        time.sleep(3)
        log = cron_log()
    for name, (reason, msg) in CROND.items():
        said = cron_says(name, log)
        if msg:
            check(any(msg in line for line in said), f"cron logs {msg!r} for {name}: {said!r}")
        else:
            check(not any(m in line for line in said for _, m in expected), f"cron reads {name}: {said!r}")
    sh(f"rm -rf {CROND_SRC} {CROND_DIR}/cj-e2e-*")
    sh(f"crontab -r -u {USER}; userdel -r {USER}; rm -f /tmp/cj-e2e-whoami")
    if etc_env_before is None:
        os.remove(ETC_ENV)
    else:
        with open(ETC_ENV, "w") as f:
            f.write(etc_env_before)

    page.click("#tab-overview")
    page.screenshot(path=os.path.join(SHOTS, "e2e-end.png"), full_page=True)
    check(not problems, "no console errors: " + repr(problems))
    browser.close()

print(f"\n{passed} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
