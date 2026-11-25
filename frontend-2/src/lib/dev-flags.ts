/**
 * TEMPORARY, FOR DEVELOPMENT ONLY. Delete this file (and src/lib/dev-start.ts) when everything works.
 * Safe to import from both server and browser code.
 *
 * true  = on this computer (localhost only) the "Start without payment" checkbox and the project-generation panel
 *         work without the admin token. Settings changes and every deployed host still need the admin token.
 * false = back to admin-only.
 */
// Whatever is typed here, a production build ignores it: starting without payment can never be on for real customers.
const ON_IN_DEVELOPMENT = true;
export const DEV_START_WITHOUT_PAYMENT = ON_IN_DEVELOPMENT && process.env.NODE_ENV !== "production";
export const DEV_START_HEADER = "x-silpi-dev-start";
