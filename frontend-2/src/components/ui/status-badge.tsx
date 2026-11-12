
import type { ProjectStatus } from "@/types";

interface StatusBadgeProps {
  status: ProjectStatus;
}

const statusStyles: Record<ProjectStatus, string> = {
  Ready: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",

  Generating:
    "border-violet-400/20 bg-violet-400/10 text-violet-300",

  "Needs attention":
    "border-amber-400/20 bg-amber-400/10 text-amber-300",

  Draft: "border-slate-500/20 bg-slate-500/10 text-slate-400",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium ${statusStyles[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />

      {status}
    </span>
  );
}
