// What a visitor typed on the front page, kept in this browser tab while they sign in, so it is waiting in the path they chose.
// Only in sessionStorage (this tab, cleared when it closes); never sent anywhere until the person uses it. Safe in the browser only.

/** The AI builder reads this key (src/components/ai/builder.tsx). */
export const AI_IDEA_KEY = "silpi:brief";
/** The client's fixed-price form reads this key (src/components/client/client-fixed-price.tsx). */
export const FIXED_IDEA_KEY = "silpi:fixed-brief";

export function keepIdea(key: string, text: string): void {
  try { if (text.trim()) sessionStorage.setItem(key, text.trim().slice(0, 4000)); } catch { /* private mode: they simply type it again */ }
}

/** Reads the idea once and forgets it, so it is not used twice. */
export function takeIdea(key: string): string {
  try {
    const v = sessionStorage.getItem(key) ?? "";
    sessionStorage.removeItem(key);
    return v;
  } catch {
    return "";
  }
}
