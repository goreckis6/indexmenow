/**
 * Wejscie dla Hostingera i innych platform, ktore domyslnie szukaja
 * server.js / app.js w katalogu glownym zamiast dist/server.js.
 *
 * Prawdziwa aplikacja jest skompilowana do dist/ przez `npm run build`.
 */
require("./dist/server.js");
