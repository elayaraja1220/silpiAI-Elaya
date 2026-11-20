"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Building2, Check, Globe, Layers, Loader2, Package, Percent, Plus, Save, Server, Trash2, Undo2, Wrench } from "lucide-react";

import { Card, Field, Input, Select, jsonFetch } from "@/components/business/ui";
import { formatINR } from "@/lib/business/pricing";
import { INDIAN_STATES } from "@/lib/business/rate-card";
import type { RateCard } from "@/lib/business/types";
import { cn } from "@/lib/utils";

/** Number box that lets the field be cleared while typing; commits only valid numbers. */
function NumInput({ value, onChange, step = 1, suffix, className }: { value: number; onChange: (n: number) => void; step?: number; suffix?: string; className?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText((t) => (Number(t) === value && t !== "" ? t : String(value))), [value]);
  return (
    <div className={cn("relative", className)}>
      <Input
        type="number"
        min={0}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= 0) onChange(n);
        }}
        onBlur={() => setText(String(value))}
        className={cn("tabular-nums", suffix && "pr-10")}
      />
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">{suffix}</span>}
    </div>
  );
}

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-slate-100">
          {icon}
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/** One label + number row inside a price list. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.04] py-2 last:border-0">
      <span className="text-sm text-slate-300">{label}</span>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

/**
 * Business details and the rate card every quotation is priced from.
 * Saved quotations keep their prices; new and re-priced ones use these.
 */
export function PricingSettingsPage() {
  const [saved, setSaved] = useState<RateCard | null>(null);
  const [card, setCard] = useState<RateCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [newTld, setNewTld] = useState("");

  useEffect(() => {
    jsonFetch<{ rateCard: RateCard }>("/api/business/rate-card")
      .then((r) => { setSaved(r.rateCard); setCard(r.rateCard); })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!card || !saved) {
    return (
      <Card className="flex items-center gap-2 text-sm text-slate-400">
        {error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={15} className="animate-spin" /> Loading...</>}
      </Card>
    );
  }

  const dirty = JSON.stringify(card) !== JSON.stringify(saved);
  const update = (fn: (c: RateCard) => RateCard) => { setCard((c) => (c ? fn(c) : c)); setDone(false); };
  const setBiz = (key: keyof RateCard["business"], value: string) => update((c) => ({ ...c, business: { ...c.business, [key]: value } }));
  const pct = (n: number) => Math.round(n * 1000) / 10;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await jsonFetch<{ rateCard: RateCard }>("/api/business/rate-card", { method: "PUT", body: JSON.stringify(card) });
      setSaved(r.rateCard);
      setCard(r.rateCard);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addTld = () => {
    const tld = (newTld.trim().startsWith(".") ? newTld.trim() : `.${newTld.trim()}`).toLowerCase();
    if (!/^\.[a-z.]{2,20}$/.test(tld) || card.domains[tld] !== undefined) return;
    update((c) => ({ ...c, domains: { ...c.domains, [tld]: { register: 0, renew: 0 } } }));
    setNewTld("");
  };

  return (
    <div className="space-y-5 pb-24">
      <div>
        <h2 className="text-sm font-semibold text-slate-100">Business details & pricing</h2>
        <p className="mt-1 text-xs text-slate-500">
          Every quotation is priced from these numbers. Quotations already issued keep their prices; new and re-priced ones use the saved values.
        </p>
      </div>

      {!card.business.gstin && (
        <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Add your GSTIN before sending quotations with GST to clients. Without it the quotation shows no GSTIN.
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Section icon={<Building2 size={16} className="text-violet-300" />} title="Your business" hint="Printed at the top of every quotation.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business name" className="sm:col-span-2"><Input value={card.business.name} onChange={(e) => setBiz("name", e.target.value)} /></Field>
            <Field label="GSTIN" hint="15 characters, e.g. 33ABCDE1234F1Z5"><Input value={card.business.gstin} onChange={(e) => setBiz("gstin", e.target.value.toUpperCase())} maxLength={15} /></Field>
            <Field label="State" hint="Same state as client: CGST + SGST. Other state: IGST.">
              <Select value={card.business.state} onChange={(e) => setBiz("state", e.target.value)}>
                {INDIAN_STATES.filter((s) => s !== "Outside India").map((s) => <option key={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Email"><Input type="email" value={card.business.email} onChange={(e) => setBiz("email", e.target.value)} /></Field>
            <Field label="Phone"><Input value={card.business.phone} onChange={(e) => setBiz("phone", e.target.value)} /></Field>
            <Field label="UPI ID for advance payments" hint="Shown to the client after approval, e.g. silpi@okaxis"><Input value={card.business.upiId ?? ""} onChange={(e) => setBiz("upiId", e.target.value.trim())} placeholder="yourname@okaxis" /></Field>
            <Field label="Bank details" hint="Account name, number, IFSC; shown after approval">
              <textarea
                value={card.business.bankDetails ?? ""}
                onChange={(e) => setBiz("bankDetails", e.target.value)}
                className="min-h-16 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-400/60"
              />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <textarea
                value={card.business.address}
                onChange={(e) => setBiz("address", e.target.value)}
                className="min-h-20 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-400/60"
              />
            </Field>
          </div>
        </Section>

        <Section icon={<Percent size={16} className="text-emerald-300" />} title="Tax & payment terms">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="GST rate" hint="18% for IT / web development services"><NumInput value={card.gstRate} onChange={(n) => update((c) => ({ ...c, gstRate: n }))} suffix="%" /></Field>
            <Field label="Advance before work starts"><NumInput value={card.advancePercent} onChange={(n) => update((c) => ({ ...c, advancePercent: n }))} suffix="%" /></Field>
            <Field label="Quotation valid for"><NumInput value={card.quoteValidityDays} onChange={(n) => update((c) => ({ ...c, quoteValidityDays: n }))} suffix="days" /></Field>
            <Field label="Maximum approved discount" hint="Most the team can give as an approved discount; prices are never discounted automatically"><NumInput value={card.maxDiscountPercent} onChange={(n) => update((c) => ({ ...c, maxDiscountPercent: n }))} suffix="%" /></Field>
          </div>
        </Section>
      </div>

      <Section icon={<Layers size={16} className="text-sky-300" />} title="Hours & hourly rate" hint="Every development line on a quotation is hours × hourly rate, adjusted for complexity and technology.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Hourly rate (₹)"><NumInput value={card.hourlyRate} onChange={(n) => update((c) => ({ ...c, hourlyRate: n }))} step={50} /></Field>
          <Field label="Productive hours per week" hint="For the delivery estimate"><NumInput value={card.hoursPerWeek} onChange={(n) => update((c) => ({ ...c, hoursPerWeek: n }))} /></Field>
          <Field label="Existing project review" hint="Module / version work"><NumInput value={card.existingProjectHours} onChange={(n) => update((c) => ({ ...c, existingProjectHours: n }))} suffix="h" /></Field>
          <Field label="Premium care" hint="Extra line on the Premium package"><NumInput value={card.premiumCareHours ?? 0} onChange={(n) => update((c) => ({ ...c, premiumCareHours: n }))} suffix="h" /></Field>
          <Field label="Each page: fixed part"><NumInput value={card.page.baseHours} step={0.5} onChange={(n) => update((c) => ({ ...c, page: { ...c.page, baseHours: n } }))} suffix="h" /></Field>
          <Field label="Each section on a page" hint="Hero, gallery, form, FAQ..."><NumInput value={card.page.sectionHours} step={0.5} onChange={(n) => update((c) => ({ ...c, page: { ...c.page, sectionHours: n } }))} suffix="h" /></Field>
          <Field label="Sections when not stated"><NumInput value={card.page.defaultSections} onChange={(n) => update((c) => ({ ...c, page: { ...c.page, defaultSections: n } }))} /></Field>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-300">Set-up, testing & deployment per project type</p>
          {Object.entries(card.projectTypes).map(([id, t]) => (
            <Row key={id} label={t.label}>
              <span className="self-center text-xs tabular-nums text-slate-500">{formatINR(t.setupHours * card.hourlyRate)}</span>
              <NumInput className="w-28" value={t.setupHours} suffix="h" onChange={(n) => update((c) => ({ ...c, projectTypes: { ...c.projectTypes, [id]: { ...t, setupHours: n } } }))} />
            </Row>
          ))}
        </div>
        <p className="text-[11px] text-slate-500">
          Example: a 3-section page = {card.page.baseHours + 3 * card.page.sectionHours} h = {formatINR((card.page.baseHours + 3 * card.page.sectionHours) * card.hourlyRate)} before complexity and GST.
        </p>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section icon={<Wrench size={16} className="text-amber-300" />} title="Features (hours each)">
          <div>
            {Object.entries(card.modules).map(([id, m]) => (
              <Row key={id} label={m.label}>
                <span className="self-center text-xs tabular-nums text-slate-500">{formatINR(m.hours * card.hourlyRate)}</span>
                <NumInput className="w-28" value={m.hours} suffix="h" onChange={(n) => update((c) => ({ ...c, modules: { ...c.modules, [id]: { ...m, hours: n } } }))} />
              </Row>
            ))}
          </div>
        </Section>

        <div className="space-y-5">
          <Section
            icon={<Server size={16} className="text-violet-300" />}
            title="Technology approaches"
            hint="Development hours of each approach as a percent of fully custom code. Only offered approaches are used in the Basic proposal."
          >
            {Object.entries(card.stacks).map(([id, s]) => (
              <div key={id} className="border-b border-white/[.04] py-2 last:border-0">
                <Row label={s.label}>
                  {id !== "custom" && (
                    <label className="flex items-center gap-1.5 self-center text-xs text-slate-400">
                      <input type="checkbox" checked={s.available} onChange={(e) => update((c) => ({ ...c, stacks: { ...c.stacks, [id]: { ...s, available: e.target.checked } } }))} className="accent-violet-500" />
                      Offer
                    </label>
                  )}
                  <NumInput className="w-28" value={pct(s.devFactor)} step={5} suffix="%" onChange={(n) => update((c) => ({ ...c, stacks: { ...c.stacks, [id]: { ...s, devFactor: n / 100 } } }))} />
                </Row>
                <p className="text-[11px] text-slate-500">{s.backend} · {s.database}</p>
              </div>
            ))}
            {!card.stacks.starter.available && <p className="text-[11px] text-amber-200/80">The SILPI starter kit is not built yet, so it is not offered.</p>}
          </Section>

          <Section
            icon={<Server size={16} className="text-sky-300" />}
            title="Technology choices"
            hint="For technical clients. Hours of each choice as a percent of our standard (100% = same). Untick Offer for technologies you do not build."
          >
            {(Object.keys(card.technology) as (keyof typeof card.technology)[]).map((layer) => (
              <div key={layer} className="border-b border-white/[.04] py-2 last:border-0">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{layer}</p>
                {Object.entries(card.technology[layer]).map(([id, o]) => (
                  <Row key={id} label={o.label}>
                    <label className="flex items-center gap-1.5 self-center text-xs text-slate-400">
                      <input type="checkbox" checked={o.available} onChange={(e) => update((c) => ({ ...c, technology: { ...c.technology, [layer]: { ...c.technology[layer], [id]: { ...o, available: e.target.checked } } } }))} className="accent-violet-500" />
                      Offer
                    </label>
                    <NumInput className="w-28" value={pct(o.factor)} step={5} suffix="%" onChange={(n) => update((c) => ({ ...c, technology: { ...c.technology, [layer]: { ...c.technology[layer], [id]: { ...o, factor: n / 100 } } } }))} />
                  </Row>
                ))}
              </div>
            ))}
          </Section>

          <Section icon={<Layers size={16} className="text-pink-300" />} title="Design & complexity">
            {Object.entries(card.design).map(([id, d]) => (
              <Row key={id} label={d.label}>
                <NumInput className="w-28" value={d.hours} suffix="h" onChange={(n) => update((c) => ({ ...c, design: { ...c.design, [id]: { ...d, hours: n } } }))} />
              </Row>
            ))}
            {Object.entries(card.complexity).map(([id, x]) => (
              <Row key={id} label={`${x.label} complexity`}>
                <NumInput className="w-28" value={pct(x.multiplier)} step={5} suffix="%" onChange={(n) => update((c) => ({ ...c, complexity: { ...c.complexity, [id]: { ...x, multiplier: n / 100 } } }))} />
              </Row>
            ))}
          </Section>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section icon={<Globe size={16} className="text-sky-300" />} title="Domains (₹): separate service" hint="Registration (first year) and yearly renewal. Never added to the development total.">
          <div>
            {Object.entries(card.domains).map(([tld, price]) => (
              <Row key={tld} label={tld}>
                <NumInput className="w-28" value={price.register} step={50} suffix="reg" onChange={(n) => update((c) => ({ ...c, domains: { ...c.domains, [tld]: { ...price, register: n } } }))} />
                <NumInput className="w-28" value={price.renew} step={50} suffix="renew" onChange={(n) => update((c) => ({ ...c, domains: { ...c.domains, [tld]: { ...price, renew: n } } }))} />
                <button
                  type="button"
                  aria-label={`Remove ${tld}`}
                  disabled={Object.keys(card.domains).length <= 1}
                  onClick={() => update((c) => ({ ...c, domains: Object.fromEntries(Object.entries(c.domains).filter(([k]) => k !== tld)) }))}
                  className="rounded-lg px-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </Row>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={newTld} onChange={(e) => setNewTld(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTld()} placeholder=".shop" className="w-36" />
            <button type="button" onClick={addTld} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 text-sm text-slate-300 hover:bg-white/5"><Plus size={14} /> Add</button>
          </div>
        </Section>

        <Section icon={<Server size={16} className="text-emerald-300" />} title="Hosting plans: separate service" hint="Shown to the client when you arrange hosting. Never added to the development total.">
          {Object.entries(card.hosting).map(([id, h]) => {
            const set = (patch: Partial<typeof h>) => update((c) => ({ ...c, hosting: { ...c.hosting, [id]: { ...h, ...patch } } }));
            return (
              <div key={id} className="space-y-2 border-b border-white/[.04] py-3 last:border-0">
                <p className="text-sm font-medium text-slate-200">{h.label}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input value={h.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="Provider" aria-label="Provider" />
                  <Input value={h.serverType} onChange={(e) => set({ serverType: e.target.value })} placeholder="Server type" aria-label="Server type" />
                  <Input value={h.storage} onChange={(e) => set({ storage: e.target.value })} placeholder="Storage" aria-label="Storage" />
                  <Input value={h.bandwidth} onChange={(e) => set({ bandwidth: e.target.value })} placeholder="Bandwidth" aria-label="Bandwidth" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Set-up (₹)"><NumInput value={h.setup} step={500} onChange={(n) => set({ setup: n })} /></Field>
                  <Field label="First year (₹)"><NumInput value={h.price} step={500} onChange={(n) => set({ price: n })} /></Field>
                  <Field label="Renewal / yr (₹)"><NumInput value={h.renew} step={500} onChange={(n) => set({ renew: n })} /></Field>
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-slate-500">Free static hosting suits sites with no server (no login, payments or admin).</p>
        </Section>
      </div>

      {card.packages && (
        <Section icon={<Package size={16} className="text-violet-300" />} title="Package terms" hint="Revisions, free support and extras promised with each package. Shown on the package details page and the quotation.">
          <div className="grid gap-4 lg:grid-cols-3">
            {(["basic", "standard", "premium"] as const).map((tier) => {
              const p = card.packages[tier];
              const set = (patch: Partial<typeof p>) => update((c) => ({ ...c, packages: { ...c.packages, [tier]: { ...p, ...patch } } }));
              return (
                <div key={tier} className="space-y-2 rounded-lg border border-white/[.06] p-3">
                  <p className="text-sm font-medium capitalize text-slate-200">{tier}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Revision rounds"><NumInput value={p.revisions} onChange={(n) => set({ revisions: Math.round(n) })} /></Field>
                    <Field label="Free support"><NumInput value={p.supportDays} onChange={(n) => set({ supportDays: Math.round(n) })} suffix="days" /></Field>
                  </div>
                  <Field label="Extras" hint="One per line.">
                    <textarea
                      value={p.extras.join("\n")}
                      onChange={(e) => set({ extras: e.target.value.split("\n") })}
                      onBlur={() => set({ extras: p.extras.map((x) => x.trim()).filter(Boolean) })}
                      className="min-h-28 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60"
                    />
                  </Field>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {(dirty || error || done) && (
        <div className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#171b26]/95 px-4 py-3 shadow-2xl backdrop-blur">
          <p className={cn("text-xs", error ? "text-rose-300" : done && !dirty ? "text-emerald-300" : "text-slate-300")}>
            {error || (done && !dirty ? <span className="flex items-center gap-1.5"><Check size={14} /> Saved. New quotations use these prices.</span> : "You have unsaved changes.")}
          </p>
          {dirty && (
            <div className="flex gap-2">
              <button onClick={() => { setCard(saved); setError(""); }} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5"><Undo2 size={14} /> Discard</button>
              <button onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save prices
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
