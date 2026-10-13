/* Cron Jobs: deutsche Texte.
 *
 * `…` im Text wird als Code gezeigt. Texte mit Werten sind Funktionen.
 * Anrede wie in Cockpit: „Sie“.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function (root) {
    "use strict";

    /* "root-Crontab", "Crontab von alice" */
    const crontabName = user => user === "root" ? "root-Crontab" : `Crontab von ${user}`;

    const ui = {
        loadedAt: t => `Geladen um ${t}`,
        serverTz: tz => `Serverzeit ${tz}`,
        refresh: "Aktualisieren",
        refreshing: "Lädt …",
        tabsLabel: "Bereiche",
        tabOverview: "Übersicht",
        tabTimers: "systemd-Timer",
        tabSystem: "System",
        close: "Schließen",
        cancel: "Abbrechen",
        retry: "Erneut versuchen",
        install: "Installieren",
        update: "Aktualisieren",
        readOnly: "Nur lesen",
        none: "keine",
        noEntries: "Keine Einträge.",
        loading: "Wird geladen …",
        today: "heute",
        tomorrow: "morgen",
        yesterday: "gestern",
        at: (day, time) => `${day} um ${time}`,
        localTime: t => `${t} Ortszeit`,
        unitDay: "Tg.",

        /* Hinweise */
        noMtaTitle: "Ausgaben von Cron-Jobs gehen auf diesem Server verloren",
        noMtaBody: "Es ist kein Mailprogramm installiert, an das cron Ausgaben schicken könnte. Für Jobs, die ihre " +
                   "Läufe erfassen, hält Cron Jobs Ergebnis und Ausgabe selbst fest.",
        cronDownTitle: "Der cron-Dienst läuft nicht",
        cronDownBody: "Geplante Jobs werden erst wieder ausgeführt, wenn er gestartet ist.",
        openServices: "In Dienste öffnen",
        noCrontabTitle: "cron ist nicht installiert",
        noCrontabBody: "Der Befehl `crontab` wurde nicht gefunden. Installieren Sie das cron-Paket Ihrer " +
                       "Distribution (etwa `cron` oder `cronie`).",
        wrapperMissingTitle: "Der Lauf-Rekorder fehlt",
        wrapperMissingBody: (n, path) => `\`${path}\` ist nicht installiert, deshalb ${n === 1 ? "kann 1 Job, der seine Läufe erfasst," : "können " + n + " Jobs, die ihre Läufe erfassen,"} nicht starten.`,
        wrapperOldTitle: "Der Lauf-Rekorder kann aktualisiert werden",
        wrapperOldBody: path => `Cron Jobs bringt eine neuere Fassung von \`${path}\` mit.`,
        wrapperInstalled: "Lauf-Rekorder installiert",
        wrapperInstalledBody: path => `\`${path}\` ist auf dem neuesten Stand.`,
        wrapperFailed: "Der Lauf-Rekorder ließ sich nicht installieren",
        wrapperNoCopy: "Cron Jobs konnte seine Kopie von cockpit-cronjobs-run nicht laden.",

        /* Zeitleiste */
        tlTitle: "Die nächsten 24 Stunden",
        tlDesc: "Alle Cron-Jobs und systemd-Timer dieses Servers, in Serverzeit.",
        legendCron: "Cron-Job",
        legendTimer: "systemd-Timer",
        tlEmpty: "In den nächsten 24 Stunden ist nichts geplant.",
        tlMore: n => `und ${n} weitere`,
        tlOverlap: (time, names) => `Um ${time} starten ${names} gleichzeitig.`,
        srcRoot: "root-Crontab",
        srcUser: user => `Crontab von ${user}`,
        srcTimer: "systemd-Timer",
        randomizedShort: "zufällig verzögert",

        /* root-Crontab */
        rootTitle: "root-Crontab",
        rootDesc: "Änderungen laufen über `crontab -u root`. Vor jeder Änderung wird ein Backup geschrieben.",
        userTitle: user => `Crontab von ${user}`,
        userDesc: user => `Änderungen laufen über \`crontab -u ${user}\`; ihre Jobs laufen als ${user}. Vor jeder ` +
                          "Änderung wird ein Backup geschrieben.",
        add: "Job hinzufügen",
        colActive: "Aktiv",
        colSchedule: "Zeitplan",
        colNext: "Nächster Lauf",
        colLast: "Letzter Lauf",
        colCommand: "Befehl",
        colActions: "Aktionen",
        colUser: "Benutzer",
        colFile: "Datei",
        colDir: "Verzeichnis",
        colScripts: "Skripte",
        colTimer: "Timer",
        activeSr: "Aktiv",
        on: "An",
        off: "Aus",
        actRun: "Jetzt ausführen",
        actEdit: "Bearbeiten",
        actMore: "Weitere Aktionen",
        actDelete: "Löschen",
        showRuns: "Läufe anzeigen",
        captureOn: "Läufe erfassen",
        captureOff: "Erfassung ausschalten",
        convert: "In systemd-Timer umwandeln",
        notRecorded: "Nicht erfasst",
        recordLink: "Erfassen",
        noRunYet: "Noch kein Lauf",
        statusOk: "OK",
        statusFailed: rc => `Fehler · Exit ${rc}`,
        statusResult: result => `Fehler · ${result}`,
        statusSignal: sig => `Beendet durch ${sig}`,
        statusAborted: "Abgebrochen",
        statusStopped: "Angehalten",
        statusRunning: "Läuft",
        runningSince: (time, dur) => `seit ${time} · ${dur}`,
        runningFor: dur => `seit ${dur}`,
        cannotCapture: "Lässt sich nicht erfassen: Der Befehl enthält ein % (den Rest gibt cron als Eingabe weiter).",
        nextBoot: "Beim nächsten Start",
        neverRuns: "Nie",
        emptyTitle: "Keine Jobs",
        emptyBody: user => `In der ${crontabName(user)} ist noch kein Job eingetragen.`,
        deniedTitle: "Administrativer Zugriff nötig",
        deniedBody: "Die root-Crontab lässt sich nur mit administrativem Zugriff lesen und ändern. Schalten Sie ihn " +
                    "oben in Cockpit über „Eingeschränkter Zugriff“ ein; die Seite lädt danach von selbst neu.",
        readErrorTitle: user => `Die ${crontabName(user)} ließ sich nicht lesen`,
        sysErrorTitle: "Die System-Crontabs ließen sich nicht lesen",
        lockedTitle: "Nur lesend geöffnet",
        lockedBody: "Diese Crontab enthält Zeilen, die beim Zurückschreiben nicht exakt erhalten blieben. " +
                    "Damit nichts verloren geht, lässt sie sich hier nicht ändern.",
        lockedEncodingBody: "Diese Crontab enthält Text, der nicht UTF-8 ist. Damit nichts verloren geht, lässt " +
                            "sie sich hier weder ändern noch ausführen.",

        /* systemd-Timer */
        timersTitle: "systemd-Timer",
        timersDesc: "Dienste, die systemd nach Zeitplan startet. Status und Protokoll stehen in Cockpit unter Dienste.",
        timersErrorTitle: "Die systemd-Timer ließen sich nicht lesen",
        timersNone: "Auf diesem Server gibt es keine systemd-Timer.",
        timerInactive: "Nicht aktiv",
        fromCrontab: "aus der root-Crontab übernommen",
        randomUpTo: span => `bis ${span} später`,
        openInCockpit: name => `${name} in Cockpit öffnen`,

        /* nur lesend */
        etcDesc: "Die System-Crontab wird als Datei verwaltet und lässt sich hier nicht ändern.",
        crondDesc: "Zusatzdateien, meist von Paketen installiert.",
        ignored: "Ignoriert",
        ignoredWhy: {
            name: "cron überspringt diese Datei wegen ihres Namens.",
            linkOwner: "cron überspringt diese Datei, weil sie ein Link ist, der nicht root gehört.",
            broken: "cron überspringt diese Datei, weil sie ein Link ins Leere ist.",
            owner: "cron überspringt diese Datei, weil sie nicht root gehört.",
            notFile: "cron überspringt diese Datei, weil sie keine normale Datei ist.",
            writable: "cron überspringt diese Datei, weil Gruppe oder andere sie ändern dürfen.",
            mode: "cron überspringt diese Datei wegen ihrer Rechte: Sie muss für den Besitzer lesbar und nicht ausführbar " +
                  "sein, ohne setuid-, setgid- oder Sticky-Bit.",
            links: "cron überspringt diese Datei, weil sie mehr als einen Hardlink hat.",
        },
        usersTitle: "Weitere Benutzer",
        usersDesc: "Crontabs weiterer Benutzer, die diese Seite nur anzeigen kann.",
        periodicTitle: "Periodische Skripte",
        periodicDesc: "Die Skripte in `/etc/cron.hourly` bis `/etc/cron.monthly` startet run-parts aus /etc/crontab " +
                      "oder anacron. Viele Systemaufgaben laufen inzwischen als systemd-Timer.",

        /* Bearbeiten */
        editTitle: "Job bearbeiten",
        addTitle: "Job hinzufügen",
        fSchedule: "Zeitplan",
        fCommand: "Befehl",
        fActive: "Job ist aktiv",
        fCapture: "Ergebnis und Ausgabe erfassen",
        captureHelp: path => `Der Job läuft dann über \`${path}\`, das Ergebnis, Dauer und Ausgabe festhält. ` +
                             "Seine Zeile in der Crontab ändert sich entsprechend.",
        save: "Speichern",
        saving: "Wird gespeichert …",
        scheduleHelp: "Fünf Felder: Minute, Stunde, Tag, Monat, Wochentag – zum Beispiel `30 2 * * 1`. " +
                      "Kürzel wie `@daily` oder `@reboot` gehen auch.",
        nextHelp: (desc, when) => `${desc} · nächster Lauf ${when}`,
        bootHelp: "Läuft einmal bei jedem Systemstart.",
        errRequired: "Bitte einen Zeitplan eingeben.",
        errCount: "Ein Zeitplan hat genau fünf Felder: Minute, Stunde, Tag, Monat, Wochentag. Oder ein Kürzel wie `@daily`.",
        errField: (name, range) => `${name}: erlaubt sind ${range}, dazu *, Listen (1,15), Bereiche (1-5) und Schritte (*/10).`,
        fieldNames: { minute: "Minute", hour: "Stunde", dom: "Tag", month: "Monat", dow: "Wochentag" },
        fieldRanges: { minute: "0–59", hour: "0–23", dom: "1–31", month: "1–12 oder jan–dec",
                       dow: "0–7 oder sun–sat (0 und 7 sind Sonntag)" },
        errNever: "Dieser Zeitplan trifft nie zu, zum Beispiel am 31. Februar.",
        errCommand: "Bitte einen Befehl eingeben.",
        errNewline: "Ein Befehl muss in eine Zeile passen.",
        errLine: "cron würde diese Zeile anders lesen als eingegeben. Bitte Zeitplan und Befehl prüfen.",
        commandHelp: user => `Läuft als ${user}. Ausgaben gehen an die lokale Mail von ${user}.`,
        commandHelpMailto: user => `Läuft als ${user}. Ausgaben gehen an die lokale Mail von ${user}, sofern MAILTO in der ` +
                                   "Crontab nichts anderes festlegt.",
        commandHelpNoMta: user => `Läuft als ${user}. Auf diesem Server ist kein Mailprogramm installiert: Ausgaben gehen ` +
            (user === "root" ? "verloren, außer der Job erfasst seine Läufe oder leitet sie um, etwa `>> /var/log/meinjob.log 2>&1`."
                : "verloren, außer der Job leitet sie um, etwa `>> $HOME/meinjob.log 2>&1`."),
        commandHelpNoMtaRecorded: user => `Läuft als ${user}. Ergebnis und Ausgabe werden erfasst.`,
        percentWarn: "cron liest % als Zeilenumbruch und gibt den Rest als Eingabe weiter. Für ein Prozentzeichen " +
                     "`\\%` schreiben, etwa `date +\\%F`.",

        /* Löschen */
        delTitle: "Job löschen?",
        delIntro: user => `Dieser Job wird aus der ${crontabName(user)} entfernt:`,
        delIntroNote: user => `Dieser Job wird mit dem Kommentar darüber aus der ${crontabName(user)} entfernt:`,
        delBackup: path => `Vorher wird die aktuelle Crontab unter \`${path}\` gesichert. Die letzten zehn Sicherungen bleiben erhalten.`,
        delRuns: "Seine erfassten Läufe werden ebenfalls gelöscht.",
        delConfirm: "Job löschen",
        deleting: "Wird gelöscht …",

        /* Ergebnisse */
        okAdded: "Job hinzugefügt",
        okEdited: "Job gespeichert",
        okDeleted: "Job gelöscht",
        okEnabled: "Job eingeschaltet",
        okDisabled: "Job ausgeschaltet",
        okCaptureOn: "Der Job erfasst jetzt seine Läufe",
        okCaptureOff: "Der Job erfasst seine Läufe nicht mehr",
        backupAt: path => `Backup der vorherigen Fassung unter \`${path}\``,
        noBackup: user => `Vorher gab es keine ${crontabName(user)}, daher kein Backup.`,
        conflictTitle: "Die Crontab wurde inzwischen geändert",
        conflictBody: user => `Die ${crontabName(user)} wurde außerhalb dieser Seite geändert. Ihre Änderung wurde nicht ` +
                              "gespeichert; die Seite zeigt jetzt den aktuellen Stand.",
        saveErrorTitle: "Speichern fehlgeschlagen",
        backupFailed: "Das Backup ließ sich nicht anlegen; die Crontab blieb unverändert.",
        unverifiedTitle: "Gespeichert, aber nicht bestätigt",
        unverifiedBody: "Die Crontab wurde geschrieben, ließ sich danach aber nicht mit dem erwarteten Inhalt " +
                        "zurücklesen. Bitte prüfen Sie den angezeigten Stand.",
        stillLoading: "Die Seite lädt gerade neu. Bitte gleich noch einmal versuchen.",
        stillBusy: "Eine andere Änderung wird gerade gespeichert.",
        lockBusy: "Die Crontab wird gerade an anderer Stelle geändert. Bitte gleich noch einmal versuchen.",

        /* Erfassung ausschalten */
        captureOffTitle: "Erfassung ausschalten?",
        captureOffBody: "Der Job läuft dann wieder direkt, wie vorher. Seine erfassten Läufe werden gelöscht.",

        /* Jetzt ausführen */
        runTitle: "Jetzt ausführen",
        runIntro: user => `Dieser Befehl wird sofort als ${user} ausgeführt:`,
        runEnv: (path, home, shell) => `Mit der Umgebung von cron: \`${path}\`, \`${home}\`, Shell \`${shell}\`.`,
        runEnvNoPath: (home, shell) => `Mit der Umgebung von cron, die hier keinen \`PATH\` setzt: \`${home}\`, Shell \`${shell}\`.`,
        runEnvOthers: list => `Außerdem gesetzt: ${list}.`,
        runRecorded: "Ergebnis und Ausgabe werden erfasst.",
        runStdin: "Der Text nach % in der Zeile wird als Eingabe übergeben, wie bei cron.",
        runKeepOpen: "Der Job wird angehalten, wenn Sie diese Seite schließen, während er läuft.",
        runStart: "Ausführen",
        runStop: "Anhalten",
        stopping: "Wird angehalten …",
        runAgain: "Erneut ausführen",
        runElapsed: t => `seit ${t}`,
        runDone: (dur, time) => `nach ${dur} · um ${time}`,
        runOutput: "Ausgabe",
        runOutputCut: "Gezeigt werden nur die letzten 256 KB der Ausgabe.",
        runCouldNotStart: "Start fehlgeschlagen",
        deniedRun: "Zum Ausführen ist administrativer Zugriff nötig.",
        noOutput: "Keine Ausgabe.",

        /* Läufe */
        runsTitle: "Läufe",
        colStart: "Start",
        colTrigger: "Auslöser",
        colDuration: "Dauer",
        colResult: "Ergebnis",
        trigManual: "Manuell",
        trigSchedule: "Zeitplan",
        showOutput: "Ausgabe anzeigen",
        hideOutput: "Ausgabe ausblenden",
        copyOutput: "Ausgabe kopieren",
        copied: "Kopiert",
        outputError: "Die Ausgabe ließ sich nicht lesen.",
        outputTruncated: "Von dieser Ausgabe wurden nur die letzten 64 KB aufbewahrt.",
        runsEmpty: "Noch keine Läufe erfasst.",
        runsNote: (n, path) => `Aufbewahrt werden die letzten ${n} Läufe mit je bis zu 64 KB Ausgabe, unter \`${path}\`.`,

        /* Übrig gebliebene Läufe */
        orphansLine: n => n === 1 ? "Die erfassten Läufe von 1 Job sind noch gespeichert, aber keine Crontab verwendet sie mehr."
            : `Die erfassten Läufe von ${n} Jobs sind noch gespeichert, aber keine Crontab verwendet sie mehr.`,
        orphansShow: "Ansehen",
        orphansTitle: "Übrig gebliebene Läufe",
        orphansIntro: "Keine Crontab verwendet diese erfassten Läufe mehr, etwa weil ihre Zeile außerhalb dieser Seite " +
                      "geändert oder entfernt wurde.",
        colJobId: "Job-ID",
        colRuns: "Läufe",
        colSize: "Größe",
        orphansNote: path => `Entfernen löscht die erfassten Ergebnisse und Ausgaben in \`${path}\`. Keine Crontab wird geändert.`,
        orphansRemove: id => `Läufe von ${id} entfernen`,
        orphansRemoveAll: "Alle entfernen",
        removing: "Wird entfernt …",
        orphansNone: "Keine übrig gebliebenen Läufe.",
        okOrphansRemoved: n => n === 1 ? "Übrig gebliebene Läufe von 1 Job entfernt" : `Übrig gebliebene Läufe von ${n} Jobs entfernt`,
        orphansKeptTitle: "Einige Läufe wurden behalten",
        orphansKept: ids => `Eine Crontab verwendet sie wieder, oder ein Lauf ist noch nicht beendet: ${ids}.`,
        orphansFailed: "Entfernen fehlgeschlagen",

        /* Sicherungen */
        backups: "Sicherungen",
        backupsTitle: user => `Sicherungen der ${crontabName(user)}`,
        backupsIntro: user => `Vor jeder Änderung sichert Cron Jobs die ${crontabName(user)}. Öffnen Sie eine Version, um ` +
                              "zu sehen, was ihre Wiederherstellung ändern würde.",
        backupsNote: (n, path) => `Beim Wiederherstellen wird die aktuelle Crontab zuerst gesichert, so lässt es sich ` +
                                  `auf dem gleichen Weg rückgängig machen. Aufbewahrt werden die letzten ${n} Sicherungen ` +
                                  `in \`${path}\`.`,
        backupsNone: "Noch keine Sicherungen. Die erste entsteht mit der ersten Änderung auf dieser Seite.",
        backupsReadError: "Die Sicherungen konnten nicht gelesen werden",
        colSaved: "Gesichert",
        colRestoring: "Wiederherstellen ändert",
        backupSame: "Nichts, sie ist die aktuelle Crontab",
        backupSameBody: user => `Diese Version ist dieselbe wie die aktuelle ${crontabName(user)}.`,
        backupEncoding: "Nicht UTF-8, hier nicht darstellbar",
        backupDelta: (removed, added) => [
            removed ? (removed === 1 ? "1 Zeile entfernt" : `${removed} Zeilen entfernt`) : null,
            added ? (added === 1 ? "1 Zeile hinzugefügt" : `${added} Zeilen hinzugefügt`) : null,
        ].filter(Boolean).join(", "),
        showChanges: "Änderungen anzeigen",
        hideChanges: "Änderungen ausblenden",
        diffIntro: user => `Wiederherstellen ändert die ${crontabName(user)} so: Zeilen mit \`-\` werden entfernt, ` +
                           "Zeilen mit `+` kommen hinzu.",
        diffLabel: "Änderungen",
        diffRemoved: "entfernt: ",
        diffAdded: "hinzugefügt: ",
        diffSkip: n => n === 1 ? "1 unveränderte Zeile" : `${n} unveränderte Zeilen`,
        diffNoNewline: "(kein Zeilenumbruch am Ende)",
        restore: "Diese Version wiederherstellen",
        restoring: "Wird wiederhergestellt …",
        restoreEncoding: user => `Die aktuelle ${crontabName(user)} ist nicht UTF-8, deshalb kann die Seite sie nicht ersetzen.`,
        okRestored: when => `Version von ${when} wiederhergestellt`,
        restoredUndo: "Zum Rückgängigmachen stellen Sie die neueste Sicherung wieder her.",
        restoreFailed: "Wiederherstellen fehlgeschlagen",
        userRunsFailed: user => `Das Verzeichnis für die Läufe der Jobs von ${user} ließ sich nicht anlegen`,

        /* Umwandeln */
        convTitle: "In systemd-Timer umwandeln",
        convIntro: "Der Job läuft danach als systemd-Timer statt über cron. Status, Protokoll und Fehler sehen Sie " +
                   "dann auch in Cockpit unter Dienste.",
        convName: "Name",
        convNameHelp: name => `Ergibt \`${name}.service\` und \`${name}.timer\` in /etc/systemd/system.`,
        convNameInvalid: "Nur Buchstaben, Ziffern, - _ und ., am Anfang ein Buchstabe oder eine Ziffer, ohne Unit-Typ am Ende.",
        convNameTaken: name => `Es gibt bereits ${name}.service oder ${name}.timer. Bitte wählen Sie einen anderen Namen.`,
        convChecking: "Zeitplan wird mit systemd-analyze geprüft …",
        convChecked: (desc, n) => `${desc} · mit systemd-analyze geprüft: ` +
            (n === 1 ? "der nächste Lauf stimmt überein." : `die nächsten ${n} Läufe stimmen überein.`),
        convMismatch: "systemd würde diesen Job zu anderen Zeiten starten als cron. Er lässt sich nicht automatisch umwandeln.",
        convCheckFailed: err => `Der Zeitplan ließ sich nicht mit systemd-analyze prüfen. ${err}`,
        convPersistent: "Verpasste Läufe nachholen",
        convPersistentHelp: "Läuft nach dem Hochfahren nach, was verpasst wurde, solange der Server aus war. cron tut " +
                            "das nicht, deshalb ist es zunächst aus.",
        convShowUnits: "Einheiten ansehen",
        convHideUnits: "Einheiten ausblenden",
        convAfter: "Danach wird die Zeile in der root-Crontab ausgeschaltet und mit einem Hinweis versehen. " +
                   "Vorher wird ein Backup angelegt.",
        convConfirm: "Umwandeln",
        converting: "Wird umgewandelt …",
        convFailed: "Umwandeln fehlgeschlagen",
        convUnitMismatch: "systemd hat den Befehl oder seine Umgebung nicht wie vorgesehen gelesen. Es wurde nichts geändert.",
        convRolledBack: "Die Crontab-Zeile wurde wieder eingeschaltet und die Einheiten entfernt.",
        convNotActive: "Nur für aktive Jobs.",
        convReboot: "Nicht für @reboot-Jobs.",
        convInvalid: "Dieser Zeitplan lässt sich nicht umwandeln.",
        convPercent: "Nicht für Befehle mit % (Eingabe für den Job).",
        convRandomDelay: "Nicht, solange die Crontab RANDOM_DELAY setzt.",
        okConverted: name => `In systemd-Timer \`${name}.timer\` umgewandelt`,
        okConvertedBody: "Die Crontab-Zeile ist ausgeschaltet und mit einem Hinweis versehen.",
        convertedTo: "Umgewandelt in systemd-Timer",

        /* Zurück zu cron */
        backToCron: "Zurück zu cron",
        backTitle: "Zurück zu cron?",
        backIntro: "Der Job läuft dann wieder über cron, wie vor der Umwandlung. In einem Schritt:",
        backLineIntro: "Diese Zeile der root-Crontab wird eingeschaltet und der Hinweis darüber entfernt:",
        backUnits: name => `\`${name}.timer\` wird angehalten und ausgeschaltet; \`${name}.service\` und \`${name}.timer\` ` +
            "werden aus /etc/systemd/system entfernt.",
        backChecking: "Die Einheiten werden geprüft …",
        backUnitsOk: "Beide Einheiten hat Cron Jobs angelegt.",
        backUnitsMissing: name => `\`${name}.timer\` gibt es nicht mehr, daher wird nur die Zeile wieder eingeschaltet.`,
        backUnitsForeign: name => `\`${name}.service\` oder \`${name}.timer\` wurde verändert oder nicht von Cron Jobs angelegt. ` +
            "Sicherheitshalber wird hier nichts geändert.",
        backCheckFailed: err => `Die Einheiten ließen sich nicht prüfen. ${err}`,
        backing: "Wird zurückgestellt …",
        backFailed: "Zurückstellen fehlgeschlagen",
        backRolledBack: "Die Crontab wurde wiederhergestellt; der Timer läuft weiter.",
        backUnitsChanged: "Sie wurden inzwischen verändert.",
        okBack: "Der Job läuft wieder über cron",
        okBackBody: name => `\`${name}.timer\` ist angehalten und entfernt.`,
        okBackUnitsLeft: name => `Der Job läuft wieder über cron; \`${name}.timer\` ist angehalten, seine Unit-Dateien sind aber noch da`,
    };

    const schedule = {
        dowAdverb: ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags"],
        months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September",
                 "Oktober", "November", "Dezember"],
        and: "und",
        or: "oder",
        reboot: "Beim Systemstart",
        everyMinute: "jede Minute",
        everyNMinutes: n => `alle ${n} Minuten`,
        hourly: "stündlich",
        hourlyAt: m => `stündlich zu Minute ${m}`,
        hourlyAtList: list => `stündlich zu Minute ${list}`,
        everyNHours: n => `alle ${n} Stunden`,
        everyNHoursAt: (n, m) => `alle ${n} Stunden zu Minute ${m}`,
        at: list => `um ${list}`,
        hourRange: (a, b) => `von ${a} bis ${b} Uhr`,
        daily: "täglich",
        dowRange: (a, b) => `${a} bis ${b}`,
        domOne: d => `am ${d}. jedes Monats`,
        domList: list => `am ${list} jedes Monats`,
        domRange: (a, b) => `vom ${a}. bis ${b}. jedes Monats`,
        domMonth: (d, mon) => `am ${d}. ${mon}`,
        inMonths: list => `im ${list}`,
        monthRange: (a, b) => `von ${a} bis ${b}`,
        ord: d => `${d}.`,
        custom: "Benutzerdefinierter Zeitplan",
        afterBoot: span => `${span} nach dem Systemstart`,
        afterStartup: span => `${span} nach dem Start von systemd`,
        afterActivation: span => `${span} nach dem Start des Timers`,
        afterLastStart: span => `alle ${span} nach dem letzten Start`,
        afterLastEnd: span => `${span} nach dem Ende des letzten Laufs`,
        randomized: ", zufällig verzögert",
    };

    const texts = { locale: "de-DE", ui, schedule };
    if (typeof module === "object" && module.exports) module.exports = texts;
    else (root.CronJobsI18n = root.CronJobsI18n || {}).de = texts;
}(typeof self !== "undefined" ? self : this));
