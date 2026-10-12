/* Fuzz: round trip and toggles never change untouched bytes; nextRun vs brute force. */
"use strict";
const assert = require("assert");
const C = require("../src/lib/cron.js");
let seed = 42;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pick = a => a[rnd(a.length)];
const WS = [" ", "\t", "  ", " \t "];
const FIELDS = [["*", "0", "*/5", "1-10", "1,2,3", "59", "0-30/10"], ["*", "3", "*/2", "9-17", "0,12", "23"],
    ["*", "1", "15", "1-7", "*/2", "31"], ["*", "1", "jan", "6-8", "*/3"], ["*", "0", "7", "mon", "1-5", "sat,sun"]];
function randLine() {
    switch (rnd(9)) {
        case 0: return "";
        case 1: return "# " + pick(["note", "MAILTO=x", "m h dom mon dow command", "0 5 * * 1 tar x"]);
        case 2: return pick(["SHELL=/bin/bash", "PATH=/usr/bin:/bin", "MAILTO=\"\""]);
        case 3: return pick(["@daily", "@reboot", "@hourly"]) + pick(WS) + "/bin/cmd " + rnd(100);
        case 4: return "#[cronjobs:off] 0 1 * * * /bin/off " + rnd(9);
        case 5: return "garbage " + rnd(1000) + (rnd(2) ? "\r" : "");
        default: {
            const f = FIELDS.map(pick);
            return (rnd(4) === 0 ? pick(WS) : "") + f.join(pick(WS)) + pick(WS) + "/usr/bin/job --x " + rnd(1000) + (rnd(3) === 0 ? pick(WS) : "");
        }
    }
}
let n = 0;
for (let k = 0; k < 3000; k++) {
    const lines = Array.from({ length: rnd(25) }, randLine);
    const text = lines.join("\n") + (rnd(5) ? "\n" : "");
    assert.ok(C.roundTrips(text), "round trip " + JSON.stringify(text));
    const e = C.parseUserCrontab(text);
    const jobs = e.map((x, i) => [x, i]).filter(x => x[0].kind === "job").map(x => x[1]);
    if (jobs.length) {
        const i = pick(jobs);
        const flipped = e.slice();
        flipped[i] = C.setEnabled(C.setEnabled(e[i], !e[i].enabled), e[i].enabled);
        assert.strictEqual(C.serializeUserCrontab(flipped), C.normalizeText(text), "double flip");
        const once = e.slice();
        once[i] = C.setEnabled(e[i], !e[i].enabled);
        const back = C.parseUserCrontab(C.serializeUserCrontab(once));
        const bj = back.filter(x => x.kind === "job");
        assert.strictEqual(bj.length, jobs.length, "job count after toggle " + JSON.stringify(text));
        const target = bj[jobs.indexOf(i)];
        assert.strictEqual(target.enabled, !e[i].enabled);
        assert.strictEqual(target.schedule, e[i].schedule);
        assert.strictEqual(target.command, e[i].command);
    }
    n++;
}
// nextRun vs brute force (UTC), random schedules
function matches(p, w) {
    const f = p.fields, dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
    if (!f[0].values.includes(w.mi) || !f[1].values.includes(w.h) || !f[3].values.includes(w.mo)) return false;
    const a = f[2].values.includes(w.d), b = f[4].values.includes(dow);
    return (f[2].star || f[4].star) ? a && b : a || b;
}
let m = 0;
for (let k = 0; k < 300; k++) {
    const s = FIELDS.map(pick).join(" ");
    const from = Date.UTC(2026, rnd(12), 1 + rnd(28), rnd(24), rnd(60));
    const p = C.parseSchedule(s);
    let ms = from + 60000, exp;
    for (let i = 0; i < 60 * 24 * 100; i++, ms += 60000) {
        const d = new Date(ms);
        if (matches(p, { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() })) { exp = ms; break; }
    }
    const got = C.nextRun(s, from, "UTC");
    if (exp === undefined) assert.ok(got === null || got - from > 100 * 86400000, s);
    else assert.strictEqual(got, exp, s + " from " + new Date(from).toISOString());
    m++;
}
console.log(`fuzz ok: ${n} crontabs, ${m} schedules`);
