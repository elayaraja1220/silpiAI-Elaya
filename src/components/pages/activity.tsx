
import {
  Activity,
  Bot,
  Clock3,
  FileSearch,
  Sparkles,
} from "lucide-react";

const events = [
  {
    icon: FileSearch,
    title: "Document analysis",
    desc: "Requirements extraction service is ready to connect.",
    time: "Waiting for backend",
    state: "Pending",
  },
  {
    icon: Sparkles,
    title: "Project generation",
    desc: "Project generator has not been started in this preview.",
    time: "No active job",
    state: "Idle",
  },
  {
    icon: Bot,
    title: "AI agent connection",
    desc: "Configure an AI provider and backend endpoint.",
    time: "Not connected",
    state: "Setup required",
  },
];

export function ActivityPage() {
  return (
    <div className="max-w-[900px] space-y-6">
      {/* Page Header */}
      <div>
        <h2 className="text-lg font-semibold">
          Agent activity
        </h2>

        <p className="mt-1 text-xs text-slate-500">
          Follow analysis, generation, execution and repair tasks.
        </p>
      </div>

      {/* Live Task Stream */}
      <div className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity
              size={16}
              className="text-violet-300"
            />

            <span className="text-xs font-semibold">
              Live task stream
            </span>
          </div>

          <span className="rounded-full bg-slate-500/10 px-2.5 py-1 text-[10px] text-slate-500">
            Demo state
          </span>
        </div>

        <div className="mt-5 space-y-5">
          {events.map((event) => {
            const Icon = event.icon;

            return (
              <div
                key={event.title}
                className="flex gap-3"
              >
                {/* Event Icon */}
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[.07] bg-white/[.03] text-slate-400">
                  <Icon size={16} />
                </span>

                {/* Event Details */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-slate-200">
                      {event.title}
                    </p>

                    <span className="text-[10px] text-slate-600">
                      {event.time}
                    </span>
                  </div>

                  <p className="mt-1 text-[10px] text-slate-500">
                    {event.desc}
                  </p>

                  <p className="mt-2 text-[9px] text-amber-300">
                    {event.state}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Activity History */}
      <div className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
        <div className="flex items-center gap-2">
          <Clock3
            size={15}
            className="text-slate-400"
          />

          <h3 className="text-xs font-semibold">
            Activity history
          </h3>
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          No execution history yet. Once the backend is
          connected, real job events and terminal output
          will appear here.
        </p>
      </div>
    </div>
  );
}
