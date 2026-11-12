
"use client";

import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Code2,
  FolderKanban,
  Plus,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";

import projectsData from "@/mockdata/projects.json";

import type { Project } from "@/types";

import { StatusBadge } from "@/components/ui/status-badge";
import { SectionHeading } from "@/components/ui/section-heading";

const projects = projectsData as Project[];

type DashboardProps = {
  onNavigate: (
    view: "create" | "projects" | "existing" | "activity"
  ) => void;
};

export function Dashboard({ onNavigate }: DashboardProps) {
  // Dashboard Statistics
  const stats = [
    {
      label: "Total projects",
      value: "12",
      change: "3 created this month",
      icon: FolderKanban,
      tone: "text-violet-300 bg-violet-400/10",
    },
    {
      label: "Successful builds",
      value: "28",
      change: "Across 8 projects",
      icon: FolderKanban,
      tone: "text-emerald-300 bg-emerald-400/10",
    },
    {
      label: "Agent tasks",
      value: "46",
      change: "6 tasks this week",
      icon: Zap,
      tone: "text-sky-300 bg-sky-400/10",
    },
    {
      label: "Time saved",
      value: "18.5h",
      change: "Estimated this month",
      icon: FolderKanban,
      tone: "text-amber-300 bg-amber-400/10",
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
                    {project.id} · {project.description}
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
                {project.updatedAt}
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

            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[10px] text-amber-300">
              Not connected
            </span>
          </div>

          <p className="mt-5 text-xs leading-5 text-slate-400">
            Connect your SILPI AI backend to enable real
            document analysis, code generation, terminal
            execution and automatic debugging.
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
        SILPI AI preview · Dashboard metrics and project records
        are sample data.
      </p>
    </div>
  );
}
