"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { AI_IDEA_KEY } from "@/lib/pending-idea";

/**
 * The sign-in address. The AI section's frame shows the sign-in form for anyone not signed in; this page only ever renders for someone who is,
 * and sends them on: to the builder when they typed a project idea on the front page before signing in, otherwise to the chat.
 */
export default function Page() {
  const router = useRouter();
  useEffect(() => {
    let pending = false;
    try { pending = !!sessionStorage.getItem(AI_IDEA_KEY); } catch { /* ignore */ }
    router.replace(pending ? "/ai/builder" : "/ai");
  }, [router]);
  return null;
}
