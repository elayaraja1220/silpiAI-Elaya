"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Coins, FileCode2, ListChecks, MessageSquare, ShieldCheck, Undo2 } from "lucide-react";

import { currencyFromQuery, formatMoney, pickCurrency, priceIn, type Currency } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./brand-logo";
import { FlowMock, LimitMock, MeterMock, PlanMock, PrivacyMock, TierMock, ChatMock } from "./landing-visuals";

/**
 * The public front page of SILPI AI (shown to anyone who is not signed in). Everything it says is true of the application as built:
 * no customer logos, user counts, certifications or testimonials, because there are none to show. The prices are read live from the
 * administrator's plans, never typed here.
 */

const BRIEF_KEY = "silpi:brief";
const EXAMPLES = ["A one-page website for my bakery", "A portfolio site for a photographer", "A booking page for a yoga studio"];

type Plan = { id: string; name: string; description: string; monthlyPricePaise: number | null; annualPricePaise: number | null; monthlyPriceUsdCents: number | null; annualPriceUsdCents: number | null; monthlyPriceGbpPence: number | null; annualPriceGbpPence: number | null; monthlyCreditUnits: number; maxActiveProjects: number | null; isCustom: boolean };
type Price = { id: string; label: string; tier: string; creditsPer1kInput: number; creditsPer1kOutput: number };

// ---- what credits buy, worked out from the LIVE credit prices (never typed here) -----------------------------------------------------------
const tierOf = (prices: Price[], tier: string) => prices.find((p) => p.tier === tier);
const costOf = (p: Price, inTokens: number, outTokens: number) => (p.creditsPer1kInput * inTokens + p.creditsPer1kOutput * outTokens) / 1000;
/** About how many typical chat answers (200 tokens in, 500 out, about 350 words) a number of credits covers on a tier. */
const answers = (prices: Price[], tier: string, credits: number) => { const p = tierOf(prices, tier); return p ? credits / costOf(p, 200, 500) : null; };
/** About how many small projects (a plan, two simple files and one main file) a number of credits covers. */
const projects = (prices: Price[], credits: number) => {
  const fast = tierOf(prices, "fast"), bal = tierOf(prices, "balanced");
  if (!fast || !bal) return null;
  const one = costOf(bal, 300, 500) + 2 * costOf(fast, 600, 1000) + costOf(bal, 800, 2500);
  return credits / one;
};
const about = (n: number | null) => (n === null || !Number.isFinite(n) ? "-" : n >= 100 ? (Math.round(n / 10) * 10).toLocaleString("en-IN") : n >= 1 ? Math.floor(n).toLocaleString("en-IN") : "<1");

const FAQ = [
  ["What does a credit buy?", "Credits pay for AI work. The cost depends on the model tier you choose and the size of the request. Before you send anything, SILPI AI shows the most it could cost, and afterwards the real cost of each answer."],
  ["What if the AI fails, or I cancel?", "You are not charged. The credits held for a request are released if it fails, and steps of a build that never ran cost nothing. If the plan for a build cannot be used at all, what it cost is refunded."],
  ["Do you keep my prompts?", "Chat prompts and answers are not stored. A build's brief and the files it produces are saved to your account so you can come back to them. Other organizations cannot see them."],
  ["Can I limit what gets spent?", "Yes. Every build runs under a budget you approve, and it stops to ask before passing it. Administrators can also set a daily limit for the whole organization."],
  ["Can it run or deploy my project?", "Not yet. Today SILPI AI plans the project and writes its files, which you read and download. Running and hosting generated code is planned, and needs careful isolation first."],
  ["How do I get an account?", "Accounts are created by the administrator for now. Once you have one, sign in and start with the free Demo mode, which uses no AI and costs nothing."],
];

export function Landing() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [prices, setPrices] = useState<Price[]>([]);
  const [yearly, setYearly] = useState(false);
  // The currency follows the visitor's country: rupees in India, pounds in the UK, dollars everywhere else. There is no switch to fiddle with.
  const [currency, setCurrency] = useState<Currency>("USD");

  useEffect(() => {
    fetch("/api/plans", { cache: "no-store" }).then((r) => r.json()).then((b: { plans?: Plan[]; aiPrices?: Price[]; country?: string | null }) => {
      setPlans(b.plans ?? null);
      setPrices(b.aiPrices ?? []);
      setCurrency(currencyFromQuery(new URLSearchParams(window.location.search).get("currency")) ?? pickCurrency({ country: b.country, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language }));
    }).catch(() => setPlans(null));
  }, []);

  /** Keep what was typed and carry it through sign-in, so the first thing the person wrote is waiting in the builder. */
  const start = (text = brief) => {
    try { if (text.trim()) sessionStorage.setItem(BRIEF_KEY, text.trim()); } catch { /* private mode: they simply retype it */ }
    router.push("/ai/sign-in");
  };

  return (
    <div className="bg-white text-slate-900" style={{ colorScheme: "light" }}>
      <style>{`
        @keyframes silpiFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-10px) } }
        @keyframes silpiGlow { 0%,100% { opacity: .85; transform: translateX(-50%) scale(1) } 50% { opacity: 1; transform: translateX(-50%) scale(1.04) } }
        .silpi-float { animation: silpiFloat 7s ease-in-out infinite }
        .silpi-glow { animation: silpiGlow 9s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) { .silpi-float, .silpi-glow { animation: none !important } }
        html { scroll-behavior: smooth }
      `}</style>

      {/* ---------------------------------------------------------------- header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2.5 sm:px-6">
          <Link href="/ai" className="flex shrink-0 items-center" aria-label="SILPI AI home"><BrandLogo /></Link>
          <nav className="ml-2 hidden gap-1 text-sm text-slate-600 md:flex" aria-label="Page sections">
            {[["#features", "Features"], ["#how", "How it works"], ["#credits", "Credits"], ["#pricing", "Pricing"], ["#faq", "FAQ"]].map(([h, l]) => <a key={h} href={h} className="rounded-lg px-3 py-1.5 hover:bg-slate-100 hover:text-slate-900">{l}</a>)}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/ai/sign-in" className="rounded-lg px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">Sign in</Link>
            <Link href="/ai/sign-in" className="rounded-full bg-slate-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700">Get started</Link>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ hero */}
      <section className="relative isolate overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[460px]">
          <div className="silpi-glow absolute bottom-[-230px] left-1/2 h-[620px] w-[1400px] max-w-[180vw] -translate-x-1/2 rounded-[50%] blur-2xl" style={{ background: "radial-gradient(ellipse at 50% 100%, #fb7185 0%, #e879f9 24%, #818cf8 46%, #38bdf8 64%, rgba(255,255,255,0) 72%)" }} />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-white to-transparent" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(99,102,241,0.10),transparent)]" />

        <div className="mx-auto max-w-4xl px-4 pb-44 pt-16 text-center sm:px-6 sm:pt-24">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3.5 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Intelligent Development Agent
          </p>
          <h1 className="mt-6 text-balance text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
            Turn your idea into code, <span className="bg-gradient-to-r from-indigo-600 via-fuchsia-500 to-cyan-500 bg-clip-text text-transparent">powered by SILPI AI</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-600">Say what you want in plain words. SILPI AI plans every file, shows the cost up front, and builds it while you stay in full control of every credit.</p>

          <form onSubmit={(e) => { e.preventDefault(); start(); }} className="silpi-float mx-auto mt-10 max-w-2xl rounded-3xl border border-slate-200 bg-white p-3 text-left shadow-[0_20px_60px_-15px_rgba(79,70,229,0.35)]" aria-label="Start a project">
            <label htmlFor="landing-brief" className="sr-only">What should SILPI AI build?</label>
            <textarea id="landing-brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} maxLength={4000} placeholder="Describe what you want to build, for example a one-page website for my bakery..." className="w-full resize-none rounded-2xl bg-transparent px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none" />
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
              <span className="text-xs text-slate-400">Free Demo mode included</span>
              <button type="submit" className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">Start building <ArrowRight size={15} /></button>
            </div>
          </form>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((x) => <button key={x} onClick={() => { setBrief(x); document.getElementById("landing-brief")?.focus(); }} className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-xs text-slate-600 backdrop-blur transition hover:border-indigo-300 hover:text-indigo-700">{x}</button>)}
          </div>
          <ul className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-slate-600">
            {[[Coins, "No surprise bills"], [Undo2, "Failed means free"], [ShieldCheck, "Your chats are not stored"]].map(([I, t]) => { const Icon = I as typeof Coins; return <li key={t as string} className="flex items-center gap-1.5"><Icon size={15} className="text-indigo-600" />{t as string}</li>; })}
          </ul>
        </div>
      </section>

      {/* -------------------------------------------------------------- features */}
      <section id="features" className="scroll-mt-20 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">One place. Full cost control.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-slate-600">Chat with AI models, or hand over a whole project. Either way you always know what it costs.</p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              { icon: MessageSquare, title: "Ask anything", text: "Chat with a fast, balanced or best-quality model. Every answer shows its tokens and its cost.", visual: <ChatMock /> },
              { icon: ListChecks, title: "Approve the plan", text: "For a project, the AI writes a plan first. You see every file and the most it could cost before you approve.", visual: <PlanMock /> },
              { icon: Coins, title: "Pay the real cost", text: "A request holds its worst case, then charges what was really used and returns the rest.", visual: <MeterMock /> },
            ].map((c) => (
              <article key={c.title} className="flex flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
                <div className="min-h-[210px] rounded-2xl bg-gradient-to-b from-slate-50 to-white p-4 ring-1 ring-slate-100">{c.visual}</div>
                <h3 className="mt-5 flex items-center gap-2 text-lg font-semibold"><c.icon size={18} className="text-indigo-600" />{c.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">{c.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- dark band */}
      <section className="relative isolate overflow-hidden bg-slate-950 py-24 text-white">
        <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[420px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 -z-10 h-[360px] w-[600px] rounded-full bg-fuchsia-600/20 blur-3xl" />
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">Built for people who watch the bill</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-white/65">Four rules that make AI spending predictable.</p>
          <div className="mt-12 grid gap-5 md:grid-cols-2">
            {[
              { title: "The right model for the job", text: "Pick Fast, Balanced or Best, or let Auto choose. Auto never picks the most expensive tier on its own.", visual: <TierMock /> },
              { title: "Held first, charged real", text: "The worst case is held before the AI runs. When it finishes you pay the real cost. If it fails, you pay nothing.", visual: <FlowMock /> },
              { title: "Limits you control", text: "Every build has a budget you approve and it stops before passing it. Administrators can cap each day's use.", visual: <LimitMock /> },
              { title: "Your work stays yours", text: "Chat prompts and answers are not stored. Each organization sees only its own builds and credits.", visual: <PrivacyMock /> },
            ].map((c) => (
              <article key={c.title} className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur transition hover:bg-white/[0.07]">
                <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">{c.visual}</div>
                <h3 className="mt-5 text-xl font-semibold">{c.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-white/65">{c.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- how it works */}
      <section id="how" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">From idea to files in four steps</h2>
          <ol className="mt-12 grid gap-5 md:grid-cols-4">
            {[
              ["Describe", "Write what you want in your own words. A sentence is enough to start."],
              ["Plan", "SILPI AI lists the files it will write and which model handles each."],
              ["Approve", "You see the most it could cost and set a budget. Nothing more is spent until you say go."],
              ["Build", "Files are written one by one. Read them, copy them or download them."],
            ].map(([t, d], i) => (
              <li key={t} className="relative rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white">{i + 1}</span>
                <h3 className="text-lg font-semibold">{t}</h3>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">{d}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8 flex items-center justify-center gap-2 text-center text-sm text-slate-500"><FileCode2 size={15} /> Today you get the project's files as text. Running and hosting them is planned, not available yet.</p>
        </div>
      </section>

      {/* --------------------------------------------------------------- credits */}
      <section id="credits" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">What is a credit?</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-slate-600">A credit is the one currency SILPI AI uses for AI work. You never deal with tokens, dollar rates or different prices from different AI companies. You spend credits.</p>
          <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_1.25fr]">
            <div className="space-y-4">
              {[
                [Coins, "Your plan gives you credits", "Each billing period (a month, or a year on a yearly plan) your plan's credits are added to your balance. A plan that says 10 credits a month adds 10 credits every month. In this version unused credits are not removed."],
                [ListChecks, "Bigger work costs more", "A longer answer, or a stronger model, uses more credits. A quick answer on the Fast model uses very few."],
                [ShieldCheck, "You see the cost first", "Before a request you see the most it could cost. Afterwards you see exactly what it cost. If it fails, it costs nothing."],
              ].map(([I, t, d]) => { const Icon = I as typeof Coins; return (
                <div key={t as string} className="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Icon size={19} /></span>
                  <div><h3 className="font-semibold">{t as string}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{d as string}</p></div>
                </div>
              ); })}
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
              <h3 className="font-semibold">What each plan's credits can do</h3>
              <p className="mt-1 text-sm text-slate-600">A rough guide at today's credit prices, per month.</p>
              {plans === null || prices.length === 0 ? <p className="mt-6 text-sm text-slate-400">Loading...</p> : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[460px] text-sm">
                    <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-3 font-medium">Plan</th><th className="py-2 pr-3 text-right font-medium">Credits</th><th className="py-2 pr-3 text-right font-medium">Fast answers</th><th className="py-2 pr-3 text-right font-medium">Best answers</th><th className="py-2 text-right font-medium">Small projects</th></tr></thead>
                    <tbody>
                      {plans.filter((p) => !p.isCustom).map((p) => { const c = p.monthlyCreditUnits / 1000; return (
                        <tr key={p.id} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-3 font-medium text-slate-900">{p.name}</td>
                          <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{c.toLocaleString("en-IN")}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">about {about(answers(prices, "fast", c))}</td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">about {about(answers(prices, "best", c))}</td>
                          <td className="py-2.5 text-right tabular-nums text-slate-700">about {about(projects(prices, c))}</td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                </div>
              )}
              <ul className="mt-4 space-y-1.5 text-xs leading-5 text-slate-500">
                <li><b className="text-slate-700">An answer</b> here is a typical chat reply of about 350 words to a question of about 150 words. Balanced answers sit between Fast and Best.</li>
                <li><b className="text-slate-700">A small project</b> is a plan plus three files (two simple, one main), built on the Standard quality.</li>
                <li>These are estimates, not promises. The real cost depends on length, and SILPI AI always shows it before you send and before you approve a build.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- pricing */}
      <section id="pricing" className="scroll-mt-20 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">Start free. Upgrade when you're ready.</h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-slate-600">Credits power every chat and build, and you see the cost first. <a href="#credits" className="text-indigo-700 underline-offset-2 hover:underline">What's a credit?</a></p>
          <div className="mx-auto mt-6 flex w-fit rounded-full border border-slate-200 bg-white p-0.5 text-sm" role="group" aria-label="Billing period">
            {[{ y: false, l: "Monthly" }, { y: true, l: "Yearly" }].map((o) => <button key={o.l} onClick={() => setYearly(o.y)} aria-pressed={yearly === o.y} className={cn("rounded-full px-4 py-1.5 transition", yearly === o.y ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900")}>{o.l}</button>)}
          </div>
          {plans === null ? <p className="mt-10 text-center text-sm text-slate-400">Loading plans...</p> : (
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {plans.map((p) => {
                const annual = yearly && (priceIn(p, currency, true) ?? 0) > 0;
                const price = p.isCustom ? null : priceIn(p, currency, annual);
                const creditCount = (p.monthlyCreditUnits * (annual ? 12 : 1)) / 1000;
                return (
                  <article key={p.id} className="flex flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-base font-semibold">{p.name}</h3>
                    <p className="mt-1 min-h-10 text-xs leading-5 text-slate-500">{p.description}</p>
                    <p className="mt-4 text-3xl font-semibold tabular-nums">{price === null ? "Custom" : price === 0 ? "Free" : formatMoney(price, currency)}{price !== null && price > 0 && <span className="text-xs font-normal text-slate-400"> / {annual ? "year" : "month"}</span>}</p>
                    <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-700">
                      {!p.isCustom && <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-emerald-500" />{creditCount.toLocaleString("en-IN")} credits {annual ? "a year" : "a month"}</li>}
                      {!p.isCustom && prices.length > 0 && <li className="flex gap-2 text-xs text-slate-500"><span className="w-[15px] shrink-0" />about {about(answers(prices, "fast", creditCount))} Fast answers, or {about(projects(prices, creditCount))} small projects</li>}
                      <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-emerald-500" />{p.maxActiveProjects === null ? "No project limit" : `${p.maxActiveProjects} active projects`}</li>
                      {p.isCustom && <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-emerald-500" />Credits and terms arranged with you</li>}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}
          <p className="mt-6 text-center text-xs text-slate-500">Prices exclude taxes and may change. Payments are recorded by the administrator for now; online payment, and billing in your local currency, start with it.</p>
        </div>
      </section>

      {/* ------------------------------------------------------------------- faq */}
      <section id="faq" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-4xl font-semibold tracking-tight sm:text-5xl">Questions, answered</h2>
          <div className="mt-10 divide-y divide-slate-200 rounded-3xl border border-slate-200 bg-white shadow-sm">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-6 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-base font-medium text-slate-900 [&::-webkit-details-marker]:hidden">{q}<ChevronDown size={18} className="shrink-0 text-slate-400 transition group-open:rotate-180" /></summary>
                <p className="pb-1 pt-3 text-sm leading-6 text-slate-600">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- final call */}
      <section className="relative isolate overflow-hidden bg-slate-950 py-24 text-center text-white">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[420px]"><div className="absolute bottom-[-280px] left-1/2 h-[500px] w-[1200px] max-w-[180vw] -translate-x-1/2 rounded-[50%] opacity-90 blur-3xl" style={{ background: "radial-gradient(ellipse at 50% 100%, #fb7185 0%, #c084fc 28%, #6366f1 50%, #38bdf8 68%, rgba(2,6,23,0) 74%)" }} /></div>
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-4xl font-semibold tracking-tight sm:text-5xl">Ready to turn your first idea into code?</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-white/70">Start with the free Demo mode. No AI, no cost, the whole flow.</p>
          <Link href="/ai/sign-in" className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-base font-medium text-slate-900 shadow-lg transition hover:bg-indigo-50">Get started <ArrowRight size={16} /></Link>
        </div>
      </section>

      {/* ---------------------------------------------------------------- footer */}
      <footer className="border-t border-slate-200 bg-white py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 text-sm text-slate-500 sm:px-6">
          <BrandLogo size="sm" tagline />
          <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
            <a href="#features" className="hover:text-slate-900">Features</a><a href="#credits" className="hover:text-slate-900">Credits</a><a href="#pricing" className="hover:text-slate-900">Pricing</a><a href="#faq" className="hover:text-slate-900">FAQ</a>
            <Link href="/ai/sign-in" className="hover:text-slate-900">Sign in</Link><Link href="/ai/admin" className="hover:text-slate-900">Administrator</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
