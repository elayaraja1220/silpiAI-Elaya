// How a build's state is named and coloured, shared by the builder page, a build's own page and the sidebar's list of builds.
export const STATUS_TONE: Record<string, "green" | "red" | "amber" | "slate" | "indigo"> = { completed: "green", failed: "red", cancelled: "slate", paused: "amber", awaiting_approval: "indigo", planning: "indigo", running: "indigo" };
export const STATUS_LABEL: Record<string, string> = { planning: "Planning", awaiting_approval: "Waiting for your approval", running: "Building", paused: "Paused", completed: "Done", failed: "Failed", cancelled: "Cancelled" };
