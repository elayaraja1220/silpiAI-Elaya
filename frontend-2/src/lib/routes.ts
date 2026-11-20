/** One URL per screen. Used by the sidebar, the page header and in-page links. */
export type ViewId = "dashboard" | "clients" | "projects" | "existing" | "activity" | "pricing" | "settings";

export const ROUTES: Record<ViewId, string> = {
  dashboard: "/",
  clients: "/clients",
  projects: "/projects",
  existing: "/existing",
  activity: "/activity",
  pricing: "/pricing",
  settings: "/settings",
};

export const TITLES: Record<ViewId, string> = {
  dashboard: "Overview",
  clients: "Clients & quotes",
  projects: "My projects",
  existing: "Existing projects",
  activity: "Agent activity",
  pricing: "Business & pricing",
  settings: "Settings",
};

/** Which screen a URL belongs to, and a more specific title for sub-pages. */
export function viewForPath(pathname: string): { view: ViewId; title: string } {
  if (pathname === "/clients/new") return { view: "clients", title: "Get your quotation" };
  if (pathname.startsWith("/clients/")) return { view: "clients", title: "Quotation" };
  const match = (Object.keys(ROUTES) as ViewId[]).find((v) => v !== "dashboard" && (pathname === ROUTES[v] || pathname.startsWith(`${ROUTES[v]}/`)));
  const view = match ?? "dashboard";
  return { view, title: TITLES[view] };
}
