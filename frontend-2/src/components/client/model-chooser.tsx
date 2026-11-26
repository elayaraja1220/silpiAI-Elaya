import Link from "next/link";
import { ArrowRight, Check, FileText, Sparkles } from "lucide-react";

const FIXED = [
  "Custom project development",
  "Requirement analysis",
  "Project quotation",
  "Technology selection",
  "Fixed project budget",
  "Milestone-based development",
  "Advance payment",
  "Project tracking",
  "Private demo preview",
  "Final project delivery",
];

const SAAS = [
  "AI-powered application development",
  "Requirement analysis",
  "AI agent workspace",
  "Automated project generation",
  "Monthly subscription",
  "Yearly subscription",
  "Credit-based AI usage",
  "Project management",
  "Development preview",
  "AI-powered development tools",
];

function Card({ id, tone, icon, title, text, features, cta, href, badge }: { id: string; tone: "violet" | "emerald"; icon: React.ReactNode; title: string; text: string; features: string[]; cta: string; href: string; badge: string }) {
  const accent = tone === "violet"
    ? { ring: "hover:border-violet-400/50 hover:shadow-violet-900/30", glow: "from-violet-500/20", icon: "bg-violet-500/15 text-violet-300", tick: "text-violet-300", button: "bg-violet-500 hover:bg-violet-400 shadow-violet-900/40", badge: "border-violet-400/30 bg-violet-500/10 text-violet-200" }
    : { ring: "hover:border-emerald-400/50 hover:shadow-emerald-900/30", glow: "from-emerald-500/15", icon: "bg-emerald-500/15 text-emerald-300", tick: "text-emerald-300", button: "bg-emerald-500 hover:bg-emerald-400 shadow-emerald-900/40", badge: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" };
  return (
    <article data-testid={`model-${id}`} className={`group relative flex flex-col overflow-hidden rounded-3xl border border-white/[.08] bg-[#121622] p-6 shadow-[0_8px_30px_-12px_rgba(0,0,0,.6)] transition duration-200 hover:-translate-y-0.5 hover:shadow-2xl sm:p-8 ${accent.ring}`}>
      <div aria-hidden className={`pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-gradient-to-br ${accent.glow} to-transparent blur-2xl`} />
      <div className="relative flex items-start justify-between gap-3">
        <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${accent.icon}`}>{icon}</span>
        <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${accent.badge}`}>{badge}</span>
      </div>
      <h2 className="relative mt-5 text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="relative mt-2 text-sm leading-6 text-slate-400">{text}</p>
      <ul className="relative mt-6 grid gap-x-4 gap-y-2.5 text-sm text-slate-300 sm:grid-cols-2">
        {features.map((f) => <li key={f} className="flex items-start gap-2"><Check size={15} className={`mt-0.5 shrink-0 ${accent.tick}`} aria-hidden /><span>{f}</span></li>)}
      </ul>
      <Link href={href} className={`relative mt-8 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${accent.button}`}>
        {cta} <ArrowRight size={16} className="transition group-hover:translate-x-0.5" />
      </Link>
    </article>
  );
}

/** The client's first choice: a fixed-price project built for them, or the AI development platform by subscription. Two separate journeys on one account. */
export function ModelChooser({ name }: { name: string }) {
  return (
    <div>
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-medium uppercase tracking-[.18em] text-violet-300">Welcome, {name.split(" ")[0]}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">What would you like to build with SILPI AI?</h1>
        <p className="mt-4 text-base leading-7 text-slate-400">Choose your development model. Whether you need a fully customized project with a fixed budget or an AI-powered application development subscription, SILPI AI provides the right solution.</p>
      </div>
      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card
          id="fixed-price"
          tone="violet"
          icon={<FileText size={22} />}
          badge="We build it for you"
          title="Fixed Price Project"
          text="Get your complete project designed and developed with a predefined budget, approved requirements, and agreed project scope."
          features={FIXED}
          cta="Choose Fixed Price"
          href="/clients/new/fixed-price"
        />
        <Card
          id="saas"
          tone="emerald"
          icon={<Sparkles size={22} />}
          badge="You build with AI"
          title="SILPI AI SaaS"
          text="Build applications using our AI-powered development platform through a flexible subscription-based model."
          features={SAAS}
          cta="Start with SILPI AI"
          href="/clients/new/saas"
        />
      </div>
      <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-5 text-slate-500">Both use the same account, and they stay separate: a fixed-price project is quoted, approved and paid for on its own, while the AI workspace is billed by subscription and credits.</p>
    </div>
  );
}
