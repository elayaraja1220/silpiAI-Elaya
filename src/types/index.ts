export type ProjectStatus = "Ready" | "Generating" | "Needs attention" | "Draft";
export type Project = { id: string; name: string; description: string; frontend: string; backend: string; database: string; status: ProjectStatus; updatedAt: string; progress?: number; };
export type TechnologyGroup = "Frontend" | "Backend" | "Database" | "Styling" | "Language" | "Package manager";
export type Technology = { name: string; group: TechnologyGroup; detail?: string };
