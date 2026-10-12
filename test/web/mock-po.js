/* Stand-in for Cockpit's ../base1/po.js: Cockpit serves the translation that matches the
   session language and it calls cockpit.locale(), which sets cockpit.language. */
(function () {
    const params = new URLSearchParams(location.search);
    if (params.get("nopo") === "1") return;
    window.cockpit.language = params.get("lang") || "de";
}());
