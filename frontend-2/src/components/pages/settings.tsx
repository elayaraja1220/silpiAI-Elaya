
"use client";

import { useState } from "react";
import {
  Bot,
  Check,
  KeyRound,
  Server,
  ShieldCheck,
} from "lucide-react";

export function SettingsPage() {
  const [provider, setProvider] = useState("Gemini");
  const [endpoint, setEndpoint] = useState("http://localhost:4000/api");
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
  };

  return (
    <div className="max-w-[850px] space-y-6">
      {/* Page Header */}
      <div>
        <h2 className="text-lg font-semibold">Workspace settings</h2>
        <p className="mt-1 text-xs text-slate-500">
          Configure the services that power your development workspace.
        </p>
      </div>

      {/* AI Provider */}
      <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-violet-300" />
          <h3 className="text-xs font-semibold">AI provider</h3>
        </div>

        <p className="mt-1 text-[10px] text-slate-500">
          Provider credentials must be stored securely on the backend.
        </p>

        <label className="mt-4 block text-[11px] text-slate-400">
          Default provider
        </label>

        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className="mt-2 h-10 w-full max-w-sm rounded-lg border border-white/[.09] bg-[#10141d] px-3 text-xs outline-none"
        >
          <option value="Gemini">Gemini</option>
          <option value="OpenAI">OpenAI</option>
          <option value="Anthropic">Anthropic</option>
          <option value="Custom provider">Custom provider</option>
        </select>

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-400/[.05] p-3">
          <KeyRound
            size={14}
            className="mt-0.5 shrink-0 text-amber-300"
          />

          <p className="text-[10px] leading-5 text-slate-400">
            Do not enter API keys in this frontend preview. Add and manage
            secrets through your backend environment or a secured
            server-side settings endpoint.
          </p>
        </div>
      </section>

      {/* Backend Connection */}
      <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-sky-300" />
          <h3 className="text-xs font-semibold">Backend connection</h3>
        </div>

        <label className="mt-4 block text-[11px] text-slate-400">
          API base URL
        </label>

        <input
          type="url"
          value={endpoint}
          onChange={(event) => {
            setEndpoint(event.target.value);
            setSaved(false);
          }}
          placeholder="http://localhost:4000/api"
          className="mt-2 h-10 w-full rounded-lg border border-white/[.09] bg-[#10141d] px-3 text-xs outline-none focus:border-violet-400/50"
        />

        <p className="mt-2 text-[10px] text-slate-600">
          Set NEXT_PUBLIC_API_URL in your frontend .env.local file for
          local development.
        </p>
      </section>

      {/* Security and Workspace */}
      <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-emerald-300" />
          <h3 className="text-xs font-semibold">
            Security and workspace
          </h3>
        </div>

        <div className="mt-4 space-y-3 text-[11px] text-slate-400">
          <p className="flex items-center gap-2">
            <Check size={13} className="shrink-0 text-emerald-300" />
            API keys are not exposed in frontend code.
          </p>

          <p className="flex items-center gap-2">
            <Check size={13} className="shrink-0 text-emerald-300" />
            Project execution should run in an isolated environment.
          </p>

          <p className="flex items-center gap-2">
            <Check size={13} className="shrink-0 text-emerald-300" />
            Local folder access requires explicit permission.
          </p>
        </div>
      </section>

      {/* Save Preferences */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-lg bg-violet-500 px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-violet-400"
        >
          Save preferences
        </button>

        {saved && (
          <span
            role="status"
            className="text-[10px] text-emerald-300"
          >
            Preferences saved for this preview session.
          </span>
        )}
      </div>
    </div>
  );
}
