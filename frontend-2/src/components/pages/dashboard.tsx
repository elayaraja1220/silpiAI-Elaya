
"use client";

import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Clock,
  Code2,
  FolderKanban,
  Plus,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import { SectionHeading } from "@/components/ui/section-heading";
import { formatRelativeTime } from "@/lib/utils";
import { useProjects } from "@/lib/use-projects";

type DashboardProps = {
  onNavigate: (
    view: "create" | "projects" | "existing" | "activity" | "settings"
  ) => void;
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function Dashboard({ onNavigate }: DashboardProps) {
  const { projects, agent, loading } = useProjects();

  const readyCount = projects.filter((p) => p.status === "Ready").length;
  const attentionCount = projects.filter((p) => p.status === "Needs attention").length;
  const createdThisMonth = projects.filter(
    (p) => Date.now() - new Date(p.updatedAt).getTime() < MONTH_MS,
  ).length;
  const latest = projects[0];
  const show = (value: string | number) => (loading ? "…" : String(value));

  const agentState = !agent
    ? { label: "Checking…", tone: "border-slate-500/20 bg-slate-500/10 text-slate-400" }
    : !agent.configured
      ? { label: "Not configured", tone: "border-amber-400/20 bg-amber-400/10 text-amber-300" }
      : !agent.built
        ? { label: "Not built", tone: "border-amber-400/20 bg-amber-400/10 text-amber-300" }
        : !agent.hasApiKey
          ? { label: "API key missing", tone: "border-amber-400/20 bg-amber-400/10 text-amber-300" }
          : { label: "Ready", tone: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" };

  const agentMessage = !agent
    ? "Checking the local SILPI agent..."
    : !agent.configured
      ? "Set SILPI_AGENT_DIR in .env.local to point at your silpi-agent folder, then restart the dev server."
      : !agent.built
        ? "The agent folder was found but it is not built. Run npm install && npm run build inside the silpi-agent folder."
        : !agent.hasApiKey
          ? "Add your Anthropic API key to silpi-agent/.env (ANTHROPIC_API_KEY=...) to start generating projects."
          : "The SILPI agent (Claude) is ready. It plans, writes, builds and fixes projects on this machine.";

  // Dashboard Statistics
  const stats = [
    {
      label: "Total projects",
      value: show(projects.length),
      change: `${createdThisMonth} updated in the last 30 days`,
      icon: FolderKanban,
      tone: "text-violet-300 bg-violet-400/10",
    },
    {
      label: "Ready",
      value: show(readyCount),
      change: "Generated with a SILPI report",
      icon: CheckCircle2,
      tone: "text-emerald-300 bg-emerald-400/10",
    },
    {
      label: "Needs attention",
      value: show(attentionCount),
      change: "Missing report or source files",
      icon: AlertTriangle,
      tone: "text-amber-300 bg-amber-400/10",
    },
    {
      label: "Last generated",
      value: loading ? "…" : latest ? formatRelativeTime(latest.updatedAt) : "—",
      change: latest ? latest.name : "No projects yet",
      icon: Clock,
      tone: "text-sky-300 bg-sky-400/10",
    },
  ];

  // Getting Started Steps
  const steps = [
    {
      n: "01",
      t: "Describe your idea",
      d: "Add requirements, documents and design references.",
    },
    {
      n: "02",
      t: "Choose your stack",
      d: "Select a frontend, backend and optional database.",
    },
    {
      n: "03",
      t: "Review and generate",
      d: "Confirm the plan before creating project files.",
    },
  ];

  return (
    <div className="space-y-8">

      {/* Hero Section */}
      <section className="relative overflow-hidden rounded-2xl border border-violet-400/15 bg-[#171a28] p-6 sm:p-8">
        <div className="grid-glow absolute inset-0 opacity-60" />

        <div className="absolute -right-16 -top-28 h-72 w-72 rounded-full bg-violet-600/20 blur-[90px]" />

        <div className="relative max-w-2xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-300/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.13em] text-violet-200">
            <Sparkles size={12} />
            AI development workspace
          </div>

          <h2 className="max-w-xl text-2xl font-semibold leading-tight tracking-tight sm:text-[32px]">
            Turn your ideas into{" "}
            <span className="text-violet-300">
              working software.
            </span>
          </h2>

          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
            Describe what you want to build, add your documents
            and choose your technology stack. SILPI AI helps you
            move from requirements to a runnable project.
          </p>

          {/* Hero Actions */}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => onNavigate("create")}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400"
            >
              <Plus size={15} />
              Create new project
            </button>

            <button
              onClick={() => onNavigate("existing")}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[.04] px-4 py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[.08]"
            >
              <Code2 size={15} />
              Open existing project
            </button>
          </div>
        </div>
      </section>

      {/* Dashboard Statistics */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;

          return (
            <div
              key={stat.label}
              className="rounded-xl border border-white/[.07] bg-[#151923] p-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  {stat.label}
                </span>

                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.tone}`}
                >
                  <Icon size={16} />
                </span>
              </div>

              <p className="mt-4 text-2xl font-semibold tracking-tight">
                {stat.value}
              </p>

              <p className="mt-1 text-[10px] text-slate-500">
                {stat.change}
              </p>
            </div>
          );
        })}
      </section>

      {/* Recent Projects */}
      <section>
        <SectionHeading
          title="Recent projects"
          description="Pick up where you left off."
          action={
            <button
              onClick={() => onNavigate("projects")}
              className="text-xs font-medium text-violet-300 hover:text-violet-200"
            >
              View all projects
              <ArrowRight size={13} className="ml-1 inline" />
            </button>
          }
        />

        <div className="overflow-hidden rounded-xl border border-white/[.07] bg-[#151923]">

          {/* Table Header */}
          <div className="hidden grid-cols-[minmax(0,1.6fr)_1fr_1fr_130px] gap-4 border-b border-white/[.06] px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600 sm:grid">
            <span>Project</span>
            <span>Technology</span>
            <span>Last updated</span>
            <span>Status</span>
          </div>

          {/* Project List */}
          {!loading && projects.length === 0 && (
            <div className="px-5 py-10 text-center text-xs text-slate-500">
              No generated projects yet.{" "}
              <button
                onClick={() => onNavigate("create")}
                className="font-medium text-violet-300 hover:text-violet-200"
              >
                Create your first project
              </button>
            </div>
          )}

          {projects.slice(0, 3).map((project) => (
            <div
              key={project.id}
              className="grid gap-3 border-b border-white/[.05] px-5 py-4 last:border-0 sm:grid-cols-[minmax(0,1.6fr)_1fr_1fr_130px] sm:items-center sm:gap-4"
            >
              {/* Project Information */}
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[.07] bg-white/[.035] text-violet-300">
                  <Boxes size={17} />
                </span>

                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-200">
                    {project.name}
                  </p>

                  <p className="mt-1 truncate text-[10px] text-slate-500">
                    {project.description}
                  </p>
                </div>
              </div>

              {/* Technology Stack */}
              <div className="text-[11px] text-slate-400">
                {project.frontend}
                <span className="text-slate-600"> / </span>
                {project.backend}
              </div>

              {/* Last Updated */}
              <div className="text-[11px] text-slate-500">
                {formatRelativeTime(project.updatedAt)}
              </div>

              {/* Project Status */}
              <div>
                <StatusBadge status={project.status} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom Dashboard Sections */}
      <section className="grid gap-4 lg:grid-cols-2">

        {/* Getting Started */}
        <div className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300">
              <WandSparkles size={16} />
            </span>

            <div>
              <h3 className="text-xs font-semibold">
                How to get started
              </h3>

              <p className="mt-0.5 text-[10px] text-slate-500">
                A simple path from idea to application.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {steps.map((step) => (
              <div key={step.n} className="flex gap-3">
                <span className="text-[10px] font-semibold text-violet-300">
                  {step.n}
                </span>

                <div>
                  <p className="text-xs font-medium text-slate-200">
                    {step.t}
                  </p>

                  <p className="mt-1 text-[10px] text-slate-500">
                    {step.d}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agent Status */}
        <div className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400/10 text-emerald-300">
                <Zap size={16} />
              </span>

              <div>
                <h3 className="text-xs font-semibold">
                  Agent status
                </h3>

                <p className="mt-0.5 text-[10px] text-slate-500">
                  Local development environment
                </p>
              </div>
            </div>

            <span className={`rounded-full border px-2.5 py-1 text-[10px] ${agentState.tone}`}>
              {agentState.label}
            </span>
          </div>

          <p className="mt-5 text-xs leading-5 text-slate-400">
            {agentMessage}
          </p>

          <button
            onClick={() => onNavigate("activity")}
            className="mt-4 text-xs font-medium text-violet-300 hover:text-violet-200"
          >
            View agent activity
            <ArrowUpRight size={13} className="ml-1 inline" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <p className="text-center text-[10px] text-slate-600">
        SILPI AI · Projects are read from the local generated-projects folder.
      </p>
    </div>
  );
}
