"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { api, Button, Card, credits, inputClass, Notice } from "./light";

type UserRow = { id: string; email: string; name: string; status: string; orgId: string | null; orgName: string | null; role: string | null };
const ORG_KINDS = [{ v: "individual", l: "Individual" }, { v: "freelancer", l: "Freelancer" }, { v: "agency", l: "Agency" }, { v: "business", l: "Business" }, { v: "enterprise", l: "Enterprise" }];

const Fld = ({ label, children, className }: { label: string; children: ReactNode; className?: string }) => (
  <label className={"block " + (className ?? "")}><span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>{children}</label>
);

/** Create customer accounts and add credits without a terminal. A new customer starts on the Free plan with its credits. */
export function Customers({ onChanged, onError }: { onChanged: (m: string) => void; onError: (e: unknown) => void }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ email: "", name: "", password: "", org: "", type: "business" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(() => { api<{ users: UserRow[] }>("/api/admin/users").then((r) => setUsers(r.users)).catch(onError); }, [onError]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setFormError("");
    try {
      await api("/api/admin/users", { method: "POST", body: { email: f.email, name: f.name, password: f.password, newOrg: { name: f.org, type: f.type } } });
      setF({ email: "", name: "", password: "", org: "", type: "business" });
      setOpen(false);
      onChanged("Customer account created. They start on the Free plan with its credits.");
      load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const orgs = new Map<string, { name: string; members: UserRow[] }>();
  for (const u of users ?? []) {
    if (!u.orgId) continue;
    const o = orgs.get(u.orgId) ?? { name: u.orgName ?? "", members: [] };
    o.members.push(u);
    orgs.set(u.orgId, o);
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Customers</h2>
          <p className="text-xs text-slate-500">People who can sign in to SILPI AI. Each organization has its own credits.</p>
        </div>
        <Button variant={open ? "ghost" : "primary"} onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Add a customer"}</Button>
      </div>

      {open && (
        <div className="grid gap-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 sm:grid-cols-2">
          <Fld label="Organization name"><input value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })} className={inputClass} placeholder="Acme Studio" /></Fld>
          <Fld label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className={inputClass}>{ORG_KINDS.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}</select></Fld>
          <Fld label="Person's name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} placeholder="Priya" /></Fld>
          <Fld label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputClass} placeholder="priya@acme.com" /></Fld>
          <Fld label="Password (at least 10 characters)" className="sm:col-span-2"><input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className={inputClass} placeholder="Choose one and give it to them" autoComplete="off" /></Fld>
          {formError && <div className="sm:col-span-2"><Notice tone="red">{formError}</Notice></div>}
          <div className="sm:col-span-2"><Button onClick={() => void create()} disabled={busy || !f.org.trim() || !f.name.trim() || !f.email.trim() || f.password.length < 10}>{busy && <Loader2 size={15} className="animate-spin" />} Create account</Button></div>
        </div>
      )}

      {users === null ? <p className="text-sm text-slate-400">Loading...</p> : orgs.size === 0 ? <p className="text-sm text-slate-500">No accounts yet. Add your first customer above.</p> : (
        <ul className="divide-y divide-slate-100">
          {[...orgs.entries()].map(([id, o]) => <OrgLine key={id} id={id} name={o.name} members={o.members} onChanged={onChanged} onError={onError} />)}
        </ul>
      )}
    </Card>
  );
}

function OrgLine({ id, name, members, onChanged, onError }: { id: string; name: string; members: UserRow[]; onChanged: (m: string) => void; onError: (e: unknown) => void }) {
  const [wallet, setWallet] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  useEffect(() => { api<{ wallet: { availableUnits: number } }>("/api/admin/credits?orgId=" + encodeURIComponent(id)).then((r) => setWallet(r.wallet.availableUnits)).catch(() => setWallet(null)); }, [id]);
  const add = () =>
    api<{ wallet: { availableUnits: number } }>("/api/admin/credits", { method: "POST", body: { orgId: id, action: "grant", units: Math.round(Number(amount) * 1000), idempotencyKey: crypto.randomUUID(), note: "Added by the administrator" } })
      .then((r) => { setWallet(r.wallet.availableUnits); setAmount(""); onChanged("Credits added."); })
      .catch(onError);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium text-slate-900">{name}</p>
        <p className="text-xs text-slate-500">{members.map((m) => `${m.email} (${m.role})`).join(", ")}</p>
      </div>
      <p className="text-sm tabular-nums text-slate-700">{wallet === null ? "-" : credits(wallet)} <span className="text-xs text-slate-400">credits</span></p>
      <div className="flex gap-2">
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="Add credits" aria-label={`Credits to add to ${name}`} className="w-28 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500" />
        <Button variant="ghost" className="px-3 py-1.5" onClick={() => void add()} disabled={!amount || Number(amount) <= 0}>Add</Button>
      </div>
    </li>
  );
}
