/**
 * Switches for parts of the screen that exist but are not shown for now. Nothing here deletes anything: set a value back to true to bring it back.
 * Safe to import from both server and browser code.
 */

/**
 * The team's "Live chat" bar at the bottom-right of the workspace pages (src/components/business/team-chat-widget.tsx).
 * Hidden for now. While it is false the bar is not drawn and does not ask the server for messages. The client's own chat on the
 * public quotation link is a separate widget and is not affected. All chat code, routes and saved conversations are kept.
 */
export const SHOW_TEAM_LIVE_CHAT = false;

/**
 * The "Hourly basis: consultant / freelancer" choice on the studio's quotation form (/clients/quote), and its hourly engagement form
 * (src/components/business/hourly-engagement-form.tsx). Hidden for now: the studio quotes fixed prices. While it is false the form opens
 * straight on the fixed-price form. Hourly quotations already made still open and work as before, and all hourly code and data are kept.
 * Clients never see the hourly choice, whatever this says.
 */
export const SHOW_HOURLY_ENGAGEMENTS = false;

/**
 * The "Dashboard" link in the AI workspace's sidebar. Shown: it opens the AI workspace's own dashboard (/ai/dashboard). Set it to false to hide the link again; the page
 * itself is unchanged either way. The Fixed Price application has its own dashboard (/client/dashboard) and its sidebar always has it.
 */
export const SHOW_AI_DASHBOARD_LINK = true;

/**
 * The "Billing" link in the AI workspace's sidebar (and in the invoice page's header). Hidden for now: plans, credits and invoices are reached from the account menu at the
 * bottom of the sidebar ("Plans and credits", "Billing and invoices"). The page and everything behind it (plans, credit packs, invoices) are unchanged at /ai/billing, and the
 * Fixed Price sidebar still has its Billing link.
 */
export const SHOW_AI_BILLING_LINK = false;

/**
 * The credit balance chip in the AI workspace's top bar. Hidden for now: the balance and the plan are in the account menu at the bottom of the sidebar. The chip is kept and
 * comes back when this is true (it opens the plans and credits page).
 */
export const SHOW_AI_CREDITS_CHIP = false;
