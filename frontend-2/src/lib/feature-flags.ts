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
