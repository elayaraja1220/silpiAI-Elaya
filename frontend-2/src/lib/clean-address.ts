// Sign-in pages are reached with their instructions in the address (?next=/ai/builder, ?mode=signup, ?error=denied), because a server redirect can only
// carry them that way. This reads them once, keeps the destination in this browser tab, and takes them out of the address bar, so the person sees a plain
// /sign-in. Browser only.
import { safeNext } from "./safe-next";

export type Entry = { next: string; mode: string | null; error: string | null };

/** What the address said when the page opened. The destination is kept in this tab (sessionStorage) so a reload of the plain address still knows it. */
export function readEntry(params: URLSearchParams, storageKey: string, fallback: string): Entry {
  const asked = params.get("next");
  let next = fallback;
  try {
    if (asked !== null) {
      next = safeNext(asked, fallback);
      sessionStorage.setItem(storageKey, next);
    } else {
      next = safeNext(sessionStorage.getItem(storageKey), fallback);
    }
  } catch {
    next = safeNext(asked, fallback);
  }
  return { next, mode: params.get("mode"), error: params.get("error") };
}

/** Forgets the kept destination once it has been used. */
export function forgetEntry(storageKey: string): void {
  try { sessionStorage.removeItem(storageKey); } catch { /* nothing kept */ }
}

/** Shows the plain page address, without anything after the "?". Nothing reloads. */
export function cleanAddress(): void {
  try {
    if (window.location.search) window.history.replaceState(window.history.state, "", window.location.pathname);
  } catch { /* the address simply stays as it was */ }
}
