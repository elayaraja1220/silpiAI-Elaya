
"use client";

import { useMemo, useState } from "react";

import {
  AlertCircle,
  Boxes,
  Check,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import type { Project } from "@/types";

import { AgentRunPanel } from "@/components/ui/agent-run-panel";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAgentRun } from "@/lib/use-agent-run";
import { formatRelativeTime } from "@/lib/utils";
import { useProjects } from "@/lib/use-projects";

type ViewMode = "grid" | "list";

type ProjectsPageProps = {
  onNavigate?: (view: "create") => void;
};

export function ProjectsPage({ onNavigate }: ProjectsPageProps) {
  const { projects, outputRoot, error, loading, reload } = useProjects();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [view, setView] = useState<ViewMode>("grid");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [instruction, setInstruction] = useState("");
  const run = useAgentRun();
  const editRunning = run.status === "running";

  const openEditor = (project: Project) => {
    if (editRunning) return;
    setEditing(project);
    setInstruction("");
    run.reset();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitEdit = async () => {
    if (!editing || !instruction.trim()) return;
    await run.start(`/api/projects/${encodeURIComponent(editing.name)}/edit`, {
      instruction: instruction.trim(),
    });
    void reload();
  };

  const copyPath = async (project: Project) => {
    if (!project.path) return;
    try {
      await navigator.clipboard.writeText(project.path);
      setCopiedId(project.id);
      setTimeout(() => setCopiedId((id) => (id === project.id ? null : id)), 2000);
    } catch {
      window.prompt("Copy the project path:", project.path);
    }
  };

  // Filter Projects
  const items = useMemo(() => {
    const searchTerm = query.toLowerCase().trim();

    return projects.filter((project) => {
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
  }, [projects, query, filter]);

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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            aria-label="Refresh projects"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/[.08] text-slate-400 transition hover:bg-white/[.05] hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>

          <button
            type="button"
            onClick={() => onNavigate?.("create")}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400"
          >
            <Plus size={14} />
            New project
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2.5 text-xs text-amber-200">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Change request panel */}
      {editing && (
        <section className="space-y-3 rounded-xl border border-violet-400/20 bg-[#151923] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold">
                <Sparkles size={14} className="text-violet-300" />
                Ask SILPI to change {editing.name}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">
                Describe new features, fixes or design changes. SILPI edits the files, rebuilds and fixes errors.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditing(null)}
              disabled={editRunning}
              aria-label="Close"
              className="text-slate-500 transition hover:text-white disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </div>

          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={editRunning}
            rows={4}
            placeholder="e.g. Add a dark mode toggle in the header, and a contact page with a validated form."
            className="w-full resize-y rounded-lg border border-white/[.09] bg-[#10141d] p-3 text-xs leading-6 outline-none transition placeholder:text-slate-600 focus:border-violet-400/50 disabled:opacity-60"
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void submitEdit()}
              disabled={editRunning || !instruction.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {editRunning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {editRunning ? "SILPI is working..." : "Apply changes"}
            </button>
          </div>

          <AgentRunPanel
            events={run.events}
            status={run.status}
            error={run.error}
            result={run.result}
            totals={run.totals}
          />
        </section>
      )}

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
      {loading && projects.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 py-16 text-xs text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          Loading projects...
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 py-16 text-center">
          <Boxes
            size={24}
            className="mx-auto text-slate-600"
          />

          <p className="mt-3 text-xs text-slate-400">
            {projects.length === 0
              ? "No generated projects yet."
              : "No projects match your search."}
          </p>

          <p className="mt-1 text-[10px] text-slate-600">
            {projects.length === 0
              ? "Create a project and it will appear here."
              : "Try changing your search or status filter."}
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
                <span className="min-w-0 truncate" title={project.path}>
                  Updated {formatRelativeTime(project.updatedAt)}
                </span>

                <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => openEditor(project)}
                  disabled={editRunning || project.status === "Generating"}
                  className="font-medium text-violet-300 transition hover:text-violet-200 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  Ask for changes
                </button>
                {project.path && (
                  <button
                    type="button"
                    onClick={() => void copyPath(project)}
                    title={project.path}
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-violet-300 transition hover:text-violet-200"
                  >
                    {copiedId === project.id ? (
                      <>
                        <Check size={12} /> Path copied
                      </>
                    ) : (
                      "Copy path"
                    )}
                  </button>
                )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Footer */}
      {outputRoot && (
        <p className="truncate text-center text-[10px] text-slate-600" title={outputRoot}>
          Reading generated projects from {outputRoot}
        </p>
      )}
    </div>
  );
}
