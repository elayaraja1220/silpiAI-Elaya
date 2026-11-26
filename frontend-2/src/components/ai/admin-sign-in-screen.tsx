"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { cleanAddress, forgetEntry, readEntry } from "@/lib/clean-address";
import { TokenSignIn } from "./admin-dashboard";

function Inner() {
  const params = useSearchParams();
  // Read once, then the address bar shows a plain /admin/sign-in.
  const [entry] = useState(() => readEntry(params, "silpi:admin-next", "/"));
  useEffect(() => cleanAddress(), []);
  const next = entry.next;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <div className="w-full max-w-md space-y-4">
        <p className="text-center text-sm font-semibold tracking-[.14em] text-slate-700">SILPI AI · STUDIO</p>
        <TokenSignIn onDone={() => { forgetEntry("silpi:admin-next"); window.location.assign(next); }} />
        <p className="text-center text-xs text-slate-500">This area is for the studio&apos;s administrators.</p>
      </div>
    </main>
  );
}

export function AdminSignInScreen() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
