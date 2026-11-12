
"use client";

import { useMemo, useState } from "react";

import {
  Boxes,
  LayoutGrid,
  List,
  Plus,
  Search,
} from "lucide-react";

import projectsData from "@/mockdata/projects.json";

import type { Project } from "@/types";

import { StatusBadge } from "@/components/ui/status-badge";

const initial = projectsData as Project[];

type ViewMode = "grid" | "list";

export function ProjectsPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [view, setView] = useState<ViewMode>("grid");

  // Filter Projects
  const items = useMemo(() => {
    const searchTerm = query.toLowerCase().trim();

    return initial.filter((project) => {
      const matchesStatus =
        filter === "All" || project.status === filter;

      const searchableText = [
        project.name,
        project.description,
        project.frontend,
        project.backend,
        project.database,
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch = searchableText.includes(searchTerm);

      return matchesStatus && matchesSearch;
    });
  }, [query, filter]);

  // Project Technologies
  const getTechnologies = (project: Project) => {
    return [
      project.frontend,
      project.backend,
      project.database,
    ].filter((technology) => technology && technology !== "—");
  };

  return (
    <div className="space-y-6">

      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Your projects
          </h2>

          <p className="mt-1 text-xs text-slate-500">
            Manage generated and imported workspaces.
          </p>
        </div>

        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400"
        >
          <Plus size={14} />
          New project
        </button>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Search Input */}
        <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-white/[.08] bg-[#151923] px-3">
          <Search size={14} className="text-slate-500" />

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects..."
            aria-label="Search projects"
            className="w-full bg-transparent text-xs outline-none placeholder:text-slate-600"
          />
        </div>

        {/* Status Filter */}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter projects by status"
          className="h-9 rounded-lg border border-white/[.08] bg-[#151923] px-3 text-xs text-slate-300 outline-none"
        >
          <option value="All">All</option>
          <option value="Ready">Ready</option>
          <option value="Generating">Generating</option>
          <option value="Needs attention">Needs attention</option>
          <option value="Draft">Draft</option>
        </select>

        {/* View Toggle */}
        <div className="flex rounded-lg border border-white/[.08] bg-[#151923] p-1">
          <button
            type="button"
            onClick={() => setView("grid")}
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            className={`rounded p-1.5 transition ${
              view === "grid"
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            <LayoutGrid size={14} />
          </button>

          <button
            type="button"
            onClick={() => setView("list")}
            aria-label="List view"
            aria-pressed={view === "list"}
            className={`rounded p-1.5 transition ${
              view === "list"
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {/* Project Results */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 py-16 text-center">
          <Boxes
            size={24}
            className="mx-auto text-slate-600"
          />

          <p className="mt-3 text-xs text-slate-400">
            No projects match your search.
          </p>

          <p className="mt-1 text-[10px] text-slate-600">
            Try changing your search or status filter.
          </p>
        </div>
      ) : (
        <div
          className={
            view === "grid"
              ? "grid gap-3 md:grid-cols-2 xl:grid-cols-3"
              : "space-y-2"
          }
        >
          {items.map((project) => (
            <article
              key={project.id}
              className={`rounded-xl border border-white/[.07] bg-[#151923] p-4 transition hover:border-violet-400/25 ${
                view === "list"
                  ? "flex flex-wrap items-center justify-between gap-4"
                  : ""
              }`}
            >
              {/* Project Header */}
              <div className="flex items-start justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[.07] bg-white/[.035] text-violet-300">
                  <Boxes size={17} />
                </span>

                <StatusBadge status={project.status} />
              </div>

              {/* Project Information */}
              <div className="mt-4">
                <p className="text-xs font-semibold text-slate-200">
                  {project.name}
                </p>

                <p className="mt-1 min-h-10 text-[10px] leading-5 text-slate-500">
                  {project.description}
                </p>
              </div>

              {/* Technology Badges */}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {getTechnologies(project).map((technology) => (
                  <span
                    key={technology}
                    className="rounded-md border border-white/[.07] bg-white/[.025] px-2 py-1 text-[9px] text-slate-400"
                  >
                    {technology}
                  </span>
                ))}
              </div>

              {/* Project Footer */}
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/[.06] pt-3 text-[10px] text-slate-600">
                <span className="min-w-0 truncate">
                  {project.id} · {project.updatedAt}
                </span>

                <button
                  type="button"
                  className="shrink-0 font-medium text-violet-300 transition hover:text-violet-200"
                >
                  Open workspace →
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Footer */}
      <p className="text-center text-[10px] text-slate-600">
        Showing sample project records. Connect the projects API
        for persistent data.
      </p>
    </div>
  );
}
