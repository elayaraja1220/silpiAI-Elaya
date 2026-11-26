"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, Facebook, Loader2, Mail } from "lucide-react";

import { PROVIDER_LABELS, type OAuthProvider } from "@/lib/oauth-providers";

type Identity = { provider: OAuthProvider; email: string; vouchedFor: boolean; linkedAt: string };
type Profile = { name: string; email: string; createdAt: string; termsVersion: string | null; termsAcceptedAt: string | null; hasPassword: boolean; identities: Identity[] };
type Account = { profile: Profile; providers: Record<OAuthProvider, boolean> };

const field = "mt-1 block w-full rounded-lg border border-white/10 bg-white/[.04] px-3 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30";
const primary = "inline-flex items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50";
const ghost = "inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-white/[.05] disabled:opacity-50";

async function call(url: string, method: string, body?: object): Promise<{ message?: string; name?: string }> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const b = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; message?: string; name?: string };
  if (!r.ok || !b.success) throw new Error(b.error || "Something went wrong. Please try again.");
  return b;
}

function Panel({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Message({ error, ok }: { error: string; ok: string }) {
  return (
    <>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
      {ok && <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"><CheckCircle2 size={14} />{ok}</p>}
    </>
  );
}

/** The signed-in person's own account: name, password, connected sign-in methods and sessions. */
export function ProfileForm() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = () => fetch("/api/account", { cache: "no-store" }).then((r) => r.json()).then((b: { success?: boolean; error?: string } & Partial<Account>) => { if (!b.success || !b.profile) throw new Error(b.error || "Could not load your account."); setAccount({ profile: b.profile, providers: b.providers! }); }).catch((e: Error) => setLoadError(e.message));
  useEffect(() => { void load(); }, []);

  const [name, setName] = useState("");
  useEffect(() => { if (account) setName(account.profile.name); }, [account]);
  const [nameMsg, setNameMsg] = useState({ error: "", ok: "" });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [pwMsg, setPwMsg] = useState({ error: "", ok: "" });
  const [idMsg, setIdMsg] = useState({ error: "", ok: "" });
  const [busy, setBusy] = useState("");

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("name"); setNameMsg({ error: "", ok: "" });
    try { await call("/api/account", "PUT", { name }); setNameMsg({ error: "", ok: "Your name has been saved." }); await load(); } catch (err) { setNameMsg({ error: (err as Error).message, ok: "" }); } finally { setBusy(""); }
  };
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setPwMsg({ error: "The two new passwords are not the same.", ok: "" }); return; }
    setBusy("password"); setPwMsg({ error: "", ok: "" });
    try { const r = await call("/api/account/password", "POST", { current, password: next }); setPwMsg({ error: "", ok: r.message ?? "Password changed." }); setCurrent(""); setNext(""); setAgain(""); } catch (err) { setPwMsg({ error: (err as Error).message, ok: "" }); } finally { setBusy(""); }
  };
  const unlink = async (p: OAuthProvider) => {
    setBusy(`unlink-${p}`); setIdMsg({ error: "", ok: "" });
    try { await call(`/api/account/identities/${p}`, "DELETE"); setIdMsg({ error: "", ok: `${PROVIDER_LABELS[p]} has been disconnected.` }); await load(); } catch (err) { setIdMsg({ error: (err as Error).message, ok: "" }); } finally { setBusy(""); }
  };
  const signOutEverywhere = async () => {
    setBusy("everywhere");
    try { await call("/api/account/sign-out-everywhere", "POST", {}); window.location.assign("/sign-in"); } catch (err) { setIdMsg({ error: (err as Error).message, ok: "" }); setBusy(""); }
  };

  if (loadError) return <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{loadError}</p>;
  if (!account) return <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading...</div>;
  const { profile, providers } = account;
  const icon = (p: OAuthProvider) => (p === "google" ? <Mail size={15} /> : <Facebook size={15} />);

  return (
    <div className="space-y-6">
      <Panel title="Your details">
        <form onSubmit={(e) => void saveName(e)} className="space-y-4" noValidate>
          <label className="block text-xs font-medium text-slate-300">Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className={field} /></label>
          <label className="block text-xs font-medium text-slate-300">Email<input value={profile.email} readOnly aria-readonly="true" className={field + " cursor-not-allowed opacity-70"} /></label>
          <p className="text-[11px] text-slate-500">{profile.termsVersion ? `You accepted the Terms of Service and Privacy Policy (version ${profile.termsVersion}) on ${new Date(profile.termsAcceptedAt ?? profile.createdAt).toLocaleDateString("en-IN")}.` : "No terms acceptance is recorded for this account."}</p>
          <button type="submit" disabled={busy === "name" || name.trim() === profile.name} className={primary}>{busy === "name" && <Loader2 size={15} className="animate-spin" />}Save name</button>
          <Message {...nameMsg} />
        </form>
      </Panel>

      <Panel title="Password" hint={profile.hasPassword ? "Changing it signs you out everywhere else." : undefined}>
        {profile.hasPassword ? (
          <form onSubmit={(e) => void changePassword(e)} className="space-y-4" noValidate>
            <label className="block text-xs font-medium text-slate-300">Current password<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className={field} /></label>
            <label className="block text-xs font-medium text-slate-300">New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className={field} placeholder="At least 10 characters" /></label>
            <label className="block text-xs font-medium text-slate-300">Repeat the new password<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field} /></label>
            <button type="submit" disabled={busy === "password" || !current || !next || !again} className={primary}>{busy === "password" && <Loader2 size={15} className="animate-spin" />}Change password</button>
            <Message {...pwMsg} />
          </form>
        ) : (
          <p className="text-sm text-slate-400">You sign in with Google or Facebook, so this account has no password. To set one, sign out and use <b className="text-slate-200">Forgot password</b> on the sign-in page.</p>
        )}
      </Panel>

      <Panel title="Connected sign-in methods" hint="Sign in with Google or Facebook as well as your email. You always keep at least one way to sign in.">
        <ul className="space-y-3">
          {(["google", "facebook"] as const).map((p) => {
            const linked = profile.identities.find((i) => i.provider === p);
            return (
              <li key={p} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[.08] px-4 py-3">
                <span className="flex items-center gap-2 text-sm text-slate-200">{icon(p)} {PROVIDER_LABELS[p]}{linked && <span className="text-xs text-slate-500">· {linked.email}</span>}</span>
                {linked ? <button type="button" onClick={() => void unlink(p)} disabled={busy === `unlink-${p}`} className={ghost}>Disconnect</button>
                  : providers[p] ? <a href={`/api/auth/oauth/${p}/start?link=1&next=${encodeURIComponent("/profile")}`} className={ghost}>Connect</a>
                  : <span className="text-xs text-slate-500">Not set up yet</span>}
              </li>
            );
          })}
        </ul>
        <Message {...idMsg} />
      </Panel>

      <Panel title="Sessions" hint="Sign out of every browser and device where you are signed in, this one included.">
        <button type="button" onClick={() => void signOutEverywhere()} disabled={busy === "everywhere"} className={ghost}>{busy === "everywhere" && <Loader2 size={15} className="animate-spin" />}Sign out everywhere</button>
      </Panel>
    </div>
  );
}
