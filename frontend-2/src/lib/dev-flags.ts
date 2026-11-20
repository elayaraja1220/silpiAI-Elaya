/**
 * TEMPORARY, FOR DEVELOPMENT ONLY. Delete this file (and src/lib/dev-start.ts) when everything works.
 * Safe to import from both server and browser code.
 *
 * true  = on this computer (localhost only) the "Start without payment" checkbox and the project-generation panel
 *         work without the admin token. Settings changes and every deployed host still need the admin token.
 * false = back to admin-only.
 */
export const DEV_START_WITHOUT_PAYMENT = true;
export const DEV_START_HEADER = "x-silpi-dev-start";
