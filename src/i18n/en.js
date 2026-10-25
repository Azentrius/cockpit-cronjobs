/* Cron Jobs: English texts (also the fallback for every other language).
 *
 * `…` in a text is shown as code. Texts that take values are functions.
 * To add a language, copy this file to i18n/<code>.js, translate it, register it
 * under its code and add a <script> line to index.html.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root) {
    "use strict";

    /* "root crontab", "crontab of alice" */
    const crontabName = user => user === "root" ? "root crontab" : `crontab of ${user}`;

    const ui = {
        loadedAt: t => `Loaded at ${t}`,
        serverTz: tz => `Server time ${tz}`,
        refresh: "Refresh",
        refreshing: "Loading …",
        tabsLabel: "Sections",
        tabOverview: "Overview",
        tabTimers: "systemd timers",
        tabSystem: "System",
        close: "Close",
        cancel: "Cancel",
        retry: "Try again",
        install: "Install run recorder",
        update: "Update",
        readOnly: "Read only",
        sourceCode: "Source code",
        /* The tooltip of the icon in Cockpit's menu when the status is older than an hour. */
        menuStale: (summary, when) => `${summary} (as of ${when}, out of date)`,
        none: "none",
        noEntries: "No entries.",
        loading: "Loading …",
        today: "today",
        tomorrow: "tomorrow",
        yesterday: "yesterday",
        at: (day, time) => `${day} at ${time}`,
        localTime: t => `${t} your time`,
        unitDay: "d",

        /* notices */
        noMtaTitle: "Output of cron jobs is lost on this server",
        noMtaBody: "No mail program is installed that cron could send output to. For jobs that record their runs, " +
                   "Cron Jobs keeps the result and output itself.",
        cronDownTitle: "The cron service is not running",
        cronDownBody: "Scheduled jobs do not run until it is started again.",
        openServices: "Open in Services",
        noCrontabTitle: "cron is not installed",
        noCrontabBody: "The `crontab` command was not found. Install your distribution's cron package " +
                       "(for example `cron` or `cronie`).",
        noCrontabState: "The crontab shows up here once cron is installed.",
        readErrorFix: "Fix the cause on the server, then try again.",
        reloadFix: "Fix the cause on the server, then load the page again with “Refresh”.",
        wrapperMissingTitle: "The run recorder is missing",
        wrapperMissingBody: (n, path) => `\`${path}\` is not installed, so ${n === 1 ? "1 job that records its runs" : n + " jobs that record their runs"} cannot start.`,
        wrapperOldTitle: "The run recorder can be updated",
        wrapperOldBody: path => `Cron Jobs comes with a newer version of \`${path}\`.`,
        wrapperInstalled: "Run recorder installed",
        wrapperInstalledBody: path => `\`${path}\` is up to date.`,
        wrapperFailed: "Could not install the run recorder",
        wrapperNoCopy: "Cron Jobs could not load its copy of cockpit-cronjobs-run.",

        /* timeline */
        sumTitle: "Latest results",
        sumFailed: n => `${n} failed`,
        sumNoFailures: "No failures",
        sumRunning: n => `${n} running`,
        sumMissed: n => `${n} missed`,
        sumOk: n => `${n} successful`,
        sumShowOk: n => `Show ${n} successful`,
        sumHideOk: "Hide the successful ones",
        colResult: "Result",
        colJob: "Job",
        tlTitle: "The next 24 hours",
        tlDesc: "All cron jobs and systemd timers on this server, in server time.",
        legendCron: "Cron job",
        legendTimer: "systemd timer",
        tlEmpty: "Nothing is scheduled for the next 24 hours.",
        tlMore: n => `and ${n} more`,
        tlOverlap: (time, names) => `At ${time}, ${names} start at the same time.`,
        srcRoot: "root crontab",
        srcUser: user => `crontab of ${user}`,
        srcTimer: "systemd timer",
        randomizedShort: "randomly delayed",

        /* root crontab */
        rootTitle: "root crontab",
        rootDesc: "Changes go through `crontab -u root`. A backup is written before every change.",
        userTitle: user => `crontab of ${user}`,
        userDesc: user => `Changes go through \`crontab -u ${user}\`; its jobs run as ${user}. A backup is written ` +
                          "before every change.",
        add: "Add job",
        recordAll: "Record all",
        colActive: "Active",
        colSchedule: "Schedule",
        colNext: "Next run",
        colLast: "Last run",
        colCommand: "Command",
        colActions: "Actions",
        colUser: "User",
        colFile: "File",
        colDir: "Directory",
        colScripts: "Scripts",
        colTimer: "Timer",
        activeSr: "Active",
        on: "On",
        off: "Off",
        actRun: "Run now",
        actEdit: "Edit",
        actMore: "More actions",
        actDelete: "Delete",
        showRuns: "Show runs",
        captureOn: "Record runs",
        captureOff: "Stop recording",
        convert: "Convert to systemd timer",
        notRecorded: "Not recorded",
        startedAt: time => `started ${time}`,
        notInLog: "Not in cron's log",
        startedTitle: "When cron started it, from its log in the journal of the last 35 days. How the run ended is " +
                      "there only when cron logs it.",
        cronLogTitle: "From cron's log in the journal of the last 35 days; the job does not record its runs.",
        inCronLog: "cron's log",
        cronLogHintTitle: "How jobs end is not in cron's log",
        cronLogHintBody: "For jobs that do not record their runs, the page therefore cannot tell how a run ended. Started " +
                         "with the option `-L 15`, cron logs the start, the end and failures of every job, and the page shows them " +
                         "here and on the overview. On Ubuntu: `systemctl edit cron.service`, under `[Service]` the " +
                         "line `Environment=\"EXTRA_OPTS=-L 15\"` (with the quotes: without them systemd sets only " +
                         "`-L`, and cron does not start), then `systemctl restart cron`. On Debian: " +
                         "`EXTRA_OPTS=\"-L 15\"` in `/etc/default/cron`, then restart cron.",
        recordLink: "Record runs",
        noRunYet: "No run yet",
        statusOk: "OK",
        statusFailed: rc => `Failed · exit ${rc}`,
        statusResult: result => `Failed · ${result}`,
        statusSignal: sig => `Ended by ${sig}`,
        statusAborted: "Aborted",
        statusStopped: "Stopped",
        statusRunning: "Running",
        statusEnded: "Ended",
        statusMissed: "Missed",
        missedDue: time => `due ${time}`,
        missedTitle: time => `cron did not start the run due at ${time}. Show runs`,
        runningSince: (time, dur) => `since ${time} · ${dur}`,
        runningFor: dur => `for ${dur}`,
        cannotCapture: "Cannot be recorded: the command contains a % (cron passes the rest as input).",
        nextBoot: "At next boot",
        neverRuns: "Never",
        emptyTitle: "No jobs",
        emptyBody: user => `The ${crontabName(user)} has no jobs yet.`,
        deniedTitle: "Administrative access required",
        deniedBody: "The root crontab can only be read and changed with administrative access. Turn it on with " +
                    "“Limited access” at the top of Cockpit; this page reloads by itself.",
        readErrorTitle: user => `Could not read the ${crontabName(user)}`,
        readErrorState: "The crontab shows up here once it can be read.",
        sysErrorTitle: "Could not read the system crontabs",
        lockedTitle: "Opened read-only",
        lockedBody: "This crontab contains lines that would not survive being written back exactly. " +
                    "To make sure nothing is lost, it cannot be changed here.",
        lockedEncodingBody: "This crontab contains text that is not UTF-8. To make sure nothing is lost, it " +
                            "cannot be changed or run here.",

        /* systemd timers */
        timersTitle: "systemd timers",
        timersDesc: "Services that systemd starts on a schedule. Their status and log are in Cockpit under Services.",
        timersErrorTitle: "Could not read the systemd timers",
        timersErrorState: "The timers show up here once they can be read.",
        timersNone: "No systemd timers",
        timersNoneBody: "systemd starts no services on a schedule on this server.",
        timersNoSystemd: "This server does not run systemd.",
        timerInactive: "Not active",
        fromCrontab: user => `converted from the ${crontabName(user)}`,
        randomUpTo: span => `up to ${span} later`,
        openInCockpit: name => `Open ${name} in Cockpit`,

        /* read-only crontabs */
        etcDesc: "The system crontab is managed as a file and cannot be changed here.",
        crondDesc: "Additional files, usually installed by packages.",
        ignored: "Ignored",
        ignoredWhy: {
            name: "cron skips this file because of its name.",
            linkOwner: "cron skips this file because it is a link that does not belong to root.",
            broken: "cron skips this file because it is a link that points to nothing.",
            owner: "cron skips this file because it does not belong to root.",
            notFile: "cron skips this file because it is not a regular file.",
            writable: "cron skips this file because group or others may change it.",
            mode: "cron skips this file because of its permissions: it must be readable by its owner and not executable, " +
                  "without setuid, setgid or sticky bit.",
            links: "cron skips this file because it has more than one hard link.",
        },
        usersTitle: "Other users",
        usersDesc: "Crontabs of other users that this page can only show.",
        periodicTitle: "Periodic scripts",
        periodicDesc: "The scripts in `/etc/cron.hourly` to `/etc/cron.monthly` are started by run-parts from " +
                      "/etc/crontab or by anacron. Many system tasks run as systemd timers instead.",

        /* edit dialog */
        editTitle: "Edit job",
        addTitle: "Add job",
        fSchedule: "Schedule",
        fCommand: "Command",
        fActive: "Job is active",
        fCapture: "Record result and output",
        captureHelp: path => `The job then runs through \`${path}\`, which keeps its result, duration and output. ` +
                             "Its line in the crontab changes accordingly.",
        fNoOverlap: "Do not start while a run goes on",
        noOverlapHelp: "A start that finds the previous run still going on is skipped and noted with the runs. " +
                       "Without it the job starts on time, even beside the run before, as cron does.",
        noOverlapNeedsCapture: "Only for jobs that record their runs: `cockpit-cronjobs-run` keeps the job from starting twice.",
        noOverlapFailed: "The job was saved, but whether it may start while a run goes on could not be set",
        save: "Save",
        saving: "Saving …",
        scheduleHelp: "Five fields: minute, hour, day, month, weekday – for example `30 2 * * 1`. " +
                      "Shortcuts like `@daily` or `@reboot` work too.",
        nextHelp: (desc, when) => `${desc} · next run ${when}`,
        bootHelp: "Runs once at every system start.",
        errRequired: "Enter a schedule.",
        errCount: "A schedule has exactly five fields: minute, hour, day, month, weekday. Or a shortcut like `@daily`.",
        errField: (name, range) => `${name}: allowed are ${range}, plus *, lists (1,15), ranges (1-5) and steps after * or a range (*/10, 5-59/10).`,
        fieldNames: { minute: "Minute", hour: "Hour", dom: "Day", month: "Month", dow: "Weekday" },
        fieldRanges: { minute: "0–59", hour: "0–23", dom: "1–31", month: "1–12 or jan–dec",
                       dow: "0–7 or sun–sat (0 and 7 are Sunday)" },
        errNever: "This schedule never matches, for example February 31.",
        errCommand: "Enter a command.",
        errNewline: "A command must fit on one line.",
        errLine: "cron would read this line differently than entered. Check the schedule and the command.",
        commandHelp: user => `Runs as ${user}. Output goes to ${user}'s local mail.`,
        commandHelpMailto: user => `Runs as ${user}. Output goes to ${user}'s local mail unless MAILTO in the crontab says otherwise.`,
        commandHelpNoMta: user => `Runs as ${user}. No mail program is installed on this server, so the job's output is lost ` +
            (user === "root" ? "unless it records its runs or redirects it, e.g. `>> /var/log/myjob.log 2>&1`."
                : "unless it redirects it, e.g. `>> $HOME/myjob.log 2>&1`."),
        commandHelpNoMtaRecorded: user => `Runs as ${user}. Its result and output are recorded.`,
        percentWarn: "cron reads % as a line break and passes the rest as input. Write `\\%` for a percent sign, " +
                     "e.g. `date +\\%F`.",

        /* delete */
        delTitle: "Delete job?",
        delIntro: user => `This job will be removed from the ${crontabName(user)}:`,
        delIntroNote: user => `This job and the comment above it will be removed from the ${crontabName(user)}:`,
        delBackup: path => `The current crontab is saved to \`${path}\` first. The last ten backups are kept.`,
        delRuns: "Its recorded runs are deleted as well.",
        delConfirm: "Delete job",
        deleting: "Deleting …",

        /* results */
        okAdded: "Job added",
        okEdited: "Job saved",
        okDeleted: "Job deleted",
        okEnabled: "Job turned on",
        okDisabled: "Job turned off",
        okCaptureOn: "The job now records its runs",
        okCaptureOff: "The job no longer records its runs",
        okCaptureAll: n => n === 1 ? "1 job now records its runs" : `${n} jobs now record their runs`,
        backupAt: path => `Backup of the previous version at \`${path}\``,
        noBackup: user => `There was no ${crontabName(user)} before, so no backup was needed.`,
        conflictTitle: "The crontab has changed in the meantime",
        conflictBody: user => `The ${crontabName(user)} was changed outside this page. Your change was not saved; ` +
                              "the page now shows the current state.",
        saveErrorTitle: "Saving failed",
        backupFailed: "The backup could not be written; the crontab was left unchanged.",
        unverifiedTitle: "Saved, but not confirmed",
        unverifiedBody: "The crontab was written but could not be read back with the expected content. " +
                        "Please check the state shown.",
        stillLoading: "The page is reloading. Try again in a moment.",
        stillBusy: "Another change is being saved.",
        lockBusy: "The crontab is being changed elsewhere right now. Try again in a moment.",

        /* recording off */
        captureOffTitle: "Stop recording?",
        captureOffBody: "The job then runs directly again, as before. Its recorded runs are deleted.",

        /* record all */
        recordAllTitle: "Record the runs of these jobs?",
        recordAllBody: (n, path) => `${n === 1 ? "This job then runs" : "These " + n + " jobs then run"} through \`${path}\`, ` +
                                    "which keeps the result, duration and output of each run. The crontab is written once, " +
                                    "after a backup.",
        recordAllBlocked: n => `${n === 1 ? "1 job cannot" : n + " jobs cannot"} be recorded: the command contains a % ` +
                               "(cron passes the rest as input).",
        recordAllOk: n => n === 1 ? "Record 1 job" : `Record ${n} jobs`,

        /* run now */
        runTitle: "Run now",
        runIntro: user => `This command runs as ${user} right away:`,
        runEnv: (path, home, shell) => `With cron's environment: \`${path}\`, \`${home}\`, shell \`${shell}\`.`,
        runEnvNoPath: (home, shell) => `With cron's environment, which sets no \`PATH\` here: \`${home}\`, shell \`${shell}\`.`,
        runEnvOthers: list => `Also set: ${list}.`,
        runLogind: "On this server cron also opens a logind session for every job (`XDG_SESSION_ID`, `XDG_RUNTIME_DIR` " +
                   "and others). Run now does not, so those variables are missing here.",
        runRecorded: "Result and output are recorded.",
        runStdin: "The text after % in the line is passed as input, as cron does.",
        runKeepOpen: "The job stops if you close this page while it runs.",
        runStart: "Run job",
        runStop: "Stop job",
        stopping: "Stopping …",
        runAgain: "Run again",
        runElapsed: t => `for ${t}`,
        runDone: (dur, time) => `after ${dur} · at ${time}`,
        runOutput: "Output",
        runOutputCut: "Only the last 256 KiB of the output are shown.",
        runCouldNotStart: "Could not start",
        deniedRun: "Running jobs needs administrative access.",
        noOutput: "No output.",

        /* runs */
        runsTitle: "Runs",
        colStart: "Start",
        colTrigger: "Started by",
        colDuration: "Duration",
        colResult: "Result",
        trigManual: "Manually",
        trigSchedule: "Schedule",
        trigSystemd: "systemd",
        showOutput: "Show output",
        hideOutput: "Hide output",
        copyOutput: "Copy output",
        copied: "Copied",
        outputError: "Could not read the output. Close this dialog and open the runs again.",
        outputTruncated: "Only the last 64 KiB of this output were kept.",
        runsEmpty: "No runs recorded yet.",
        runsNote: (n, path) => `The last ${n} runs are kept, with up to 64 KiB of output each, in \`${path}\`.`,
        runsJournalNote: unit => `Runs of \`${unit}\` come from the journal; how far back it goes depends on its settings.`,
        noOverlapNote: "The job does not start while a run of it goes on.",
        skippedNote: (n, when) => `${n === 1 ? "1 start was" : n + " starts were"} skipped because a run was still going on, ` +
                                  `the last ${when}.`,
        journalFailed: "The journal could not be read",
        journalFix: "Close this dialog and open the runs again. If the error stays, check the systemd-journald service.",

        /* leftover runs */
        orphansLine: n => n === 1 ? "The recorded runs of 1 job are still kept, but no crontab uses them any more."
            : `The recorded runs of ${n} jobs are still kept, but no crontab uses them any more.`,
        orphansShow: "Review runs",
        orphansTitle: "Leftover runs",
        orphansIntro: "No crontab uses these recorded runs any more, for example because their line was changed " +
                      "or removed outside this page.",
        colJobId: "Job ID",
        colRuns: "Runs",
        colSize: "Size",
        orphansNote: path => `Removing deletes the recorded results and output in \`${path}\`. No crontab is changed.`,
        orphansRemove: id => `Remove the runs of ${id}`,
        orphansRemoveAll: "Remove all runs",
        removing: "Removing …",
        orphansNone: "No leftover runs.",
        okOrphansRemoved: n => n === 1 ? "Leftover runs of 1 job removed" : `Leftover runs of ${n} jobs removed`,
        orphansKeptTitle: "Some runs were kept",
        orphansKept: ids => `A crontab uses them again, or a run is going on: ${ids}.`,
        orphansFailed: "Removing failed",

        /* Backups */
        backups: "Backups",
        backupsTitle: user => `Backups of the ${crontabName(user)}`,
        backupsIntro: user => `Before every change, Cron Jobs saves the ${crontabName(user)}. Open a version to see what ` +
                              "restoring it would change.",
        backupsNote: (n, path) => `Restoring saves the current crontab as a backup first, so a restore can be undone ` +
                                  `the same way. The last ${n} backups are kept in \`${path}\`.`,
        backupsNone: "No backups yet. The first one is made with the first change on this page.",
        backupsReadError: "The backups could not be read",
        backupsReadFix: path => "Close this dialog and open the backups again. If the error stays, check " +
                                `\`${path}\` on the server.`,
        colSaved: "Saved",
        colRestoring: "Restoring changes",
        backupSame: "Nothing, it is the current crontab",
        backupSameBody: user => `This version is the same as the current ${crontabName(user)}.`,
        backupEncoding: "Not UTF-8, cannot be shown here",
        backupDelta: (removed, added) => [
            removed ? (removed === 1 ? "1 line removed" : `${removed} lines removed`) : null,
            added ? (added === 1 ? "1 line added" : `${added} lines added`) : null,
        ].filter(Boolean).join(", "),
        showChanges: "Show changes",
        hideChanges: "Hide changes",
        diffIntro: user => `Restoring this version changes the ${crontabName(user)} like this: lines marked ` +
                           "`-` are removed, lines marked `+` are added.",
        diffLabel: "Changes",
        diffRemoved: "removed: ",
        diffAdded: "added: ",
        diffSkip: n => n === 1 ? "1 unchanged line" : `${n} unchanged lines`,
        diffNoNewline: "(no newline at the end)",
        restore: "Restore this version",
        restoring: "Restoring …",
        restoreEncoding: user => `The current ${crontabName(user)} is not UTF-8, so the page cannot replace it.`,
        okRestored: when => `Version saved ${when} restored`,
        restoredUndo: "To undo it, restore the newest backup.",
        restoreFailed: "Restoring failed",
        userRunsFailed: user => `The directory for the runs of ${user}'s jobs could not be made`,

        /* convert */
        convTitle: "Convert to systemd timer",
        convIntro: user => "The job then runs as a systemd timer instead of through cron" +
                   (user === "root" ? "" : `, as ${user}, in that user's home and with the environment cron gives it`) +
                   ". Its status, log and errors also show up in Cockpit under Services.",
        convName: "Name",
        convNameHelp: name => `Becomes \`${name}.service\` and \`${name}.timer\` in /etc/systemd/system.`,
        convNameInvalid: "Letters, digits, - _ and . only, starting with a letter or digit, without a unit type at the end.",
        convNameTaken: name => `A unit called ${name}.service or ${name}.timer already exists. Please choose another name.`,
        convChecking: "Checking the schedule with systemd-analyze …",
        convChecked: (desc, n) => `${desc} · checked with systemd-analyze: ` +
            (n === 1 ? "the next run is the same." : `the next ${n} runs are the same.`),
        convMismatch: "systemd would run this job at other times than cron. It cannot be converted automatically.",
        convCheckFailed: err => `The schedule could not be checked with systemd-analyze. ${err}`,
        convPersistent: "Catch up on missed runs",
        convPersistentHelp: "After a start, runs what was missed while the server was off. cron does not do that, " +
                            "so it is off at first.",
        convShowUnits: "Show units",
        convHideUnits: "Hide units",
        convLogind: "On this server cron opens a logind session for every job (`XDG_SESSION_ID`, `XDG_RUNTIME_DIR` " +
                    "and others). The timer's service does not, so those variables are missing there.",
        convAfter: user => `Afterwards the line in the ${crontabName(user)} is turned off and gets a note. A backup is made first.`,
        convConfirm: "Convert job",
        converting: "Converting …",
        convFailed: "Conversion failed",
        convUnitMismatch: "systemd did not read the command or its environment as intended. Nothing was changed.",
        convUnitsTaken: "The units of this name were changed or taken by another conversion meanwhile. " +
                        "The crontab was not changed, and the units were left as they are.",
        convRolledBack: "The crontab line was turned back on and the units were removed.",
        convNotActive: "Only for active jobs.",
        convReboot: "Not for @reboot jobs.",
        convInvalid: "This schedule cannot be converted.",
        convPercent: "Not for commands with % (input for the job).",
        convRandomDelay: "Not while the crontab sets RANDOM_DELAY.",
        okConverted: name => `Converted to systemd timer \`${name}.timer\``,
        okConvertedBody: "The crontab line is turned off and has a note.",
        convertedTo: "Converted to systemd timer",

        /* back to cron */
        backToCron: "Back to cron",
        backTitle: "Back to cron?",
        backIntro: "The job then runs through cron again, as before the conversion. In one step:",
        backLineIntro: user => `This line of the ${crontabName(user)} is turned on, and the note above it is removed:`,
        backUnits: name => `\`${name}.timer\` is stopped and turned off; \`${name}.service\` and \`${name}.timer\` ` +
            "are removed from /etc/systemd/system.",
        backChecking: "Checking the units …",
        backUnitsOk: "Both units were created by Cron Jobs.",
        backUnitsMissing: name => `There is no \`${name}.timer\` any more, so only the line is turned back on.`,
        backUnitsForeign: name => `\`${name}.service\` or \`${name}.timer\` was changed, or was not created by Cron Jobs. ` +
            "To be safe, nothing is changed here.",
        backCheckFailed: err => `The units could not be checked. ${err}`,
        backing: "Going back …",
        backFailed: "Going back failed",
        backRolledBack: "The crontab was put back as it was; the timer keeps running.",
        backUnitsChanged: "They were changed in the meantime.",
        okBack: "The job runs through cron again",
        okBackBody: name => `\`${name}.timer\` is stopped and removed.`,
        okBackUnitsLeft: name => `The job runs through cron again; \`${name}.timer\` is stopped, but its unit files were left`,
    };

    const schedule = {
        dowAdverb: ["on Sundays", "on Mondays", "on Tuesdays", "on Wednesdays", "on Thursdays", "on Fridays", "on Saturdays"],
        dowName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        months: ["January", "February", "March", "April", "May", "June", "July", "August", "September",
                 "October", "November", "December"],
        and: "and",
        or: "or",
        reboot: "At system start",
        everyMinute: "every minute",
        everyNMinutes: n => `every ${n} minutes`,
        hourly: "hourly",
        hourlyAt: m => `hourly at minute ${m}`,
        hourlyAtList: list => `hourly at minutes ${list}`,
        everyNHours: n => `every ${n} hours`,
        everyNHoursAt: (n, m) => `every ${n} hours at minute ${m}`,
        at: list => `at ${list}`,
        hourRange: (a, b) => `from ${String(a).padStart(2, "0")}:00 to ${String(b).padStart(2, "0")}:59`,
        daily: "daily",
        dowRange: (a, b) => `${a} to ${b}`,
        domOne: d => `on day ${d} of every month`,
        domList: list => `on days ${list} of every month`,
        domRange: (a, b) => `on days ${a} to ${b} of every month`,
        domMonth: (d, mon) => `on ${mon} ${d}`,
        inMonths: list => `in ${list}`,
        monthRange: (a, b) => `from ${a} to ${b}`,
        ord: d => String(d),
        custom: "Custom schedule",
        afterBoot: span => `${span} after boot`,
        afterStartup: span => `${span} after systemd started`,
        afterActivation: span => `${span} after the timer started`,
        afterLastStart: span => `every ${span} after the last start`,
        afterLastEnd: span => `${span} after the last run ended`,
        randomized: ", randomly delayed",
    };

    const texts = { locale: "en-US", ui, schedule };
    if (typeof module === "object" && module.exports) module.exports = texts;
    else (root.CronJobsI18n = root.CronJobsI18n || {}).en = texts;
}(typeof self !== "undefined" ? self : this));
