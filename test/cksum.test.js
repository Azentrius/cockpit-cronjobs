// SPDX-License-Identifier: Apache-2.0
/* cksum() must match coreutils `cksum < file` byte for byte. */
const C = require("../src/lib/cron.js");
const { execFileSync } = require("child_process");
const samples = ["", "\n", "a", "0 3 * * * /bin/true\n", "café naïve € 😀 ñ\n", "x".repeat(255), "y".repeat(256),
                 "z".repeat(65536 + 3), "#[cronjobs:off] 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/\r\n"];
for (let i = 0; i < 200; i++) {
    let s = ""; const n = Math.floor(Math.random() * 3000);
    for (let j = 0; j < n; j++) s += String.fromCharCode(32 + Math.floor(Math.random() * 300));
    samples.push(s);
}
let ok = 0;
for (const s of samples) {
    const want = execFileSync("cksum", { input: Buffer.from(s, "utf8") }).toString().trim();
    const got = C.cksum(s);
    if (want !== got) { console.error("MISMATCH", JSON.stringify(s.slice(0, 40)), want, got); process.exit(1); }
    ok++;
}
console.log("cksum ok:", ok);
