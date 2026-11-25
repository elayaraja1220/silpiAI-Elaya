import { cn } from "@/lib/utils";

/**
 * The SILPI AI brand for light pages: the hexagon S mark with the name set as live text, so it stays sharp at any size and on
 * any screen. (The full dark-badge logo is for dark backgrounds and large spots; at header size its thin lettering blurs.)
 */
export function BrandLogo({ size = "md", tagline = false, className }: { size?: "sm" | "md" | "lg"; tagline?: boolean; className?: string }) {
  const box = size === "lg" ? "h-11 w-11" : size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const text = size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-xl";
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/silpi-mark-160.png" alt="" width={44} height={44} className={cn("shrink-0", box)} />
      <span className="flex flex-col leading-none">
        <span className={cn("font-extrabold tracking-tight text-slate-900", text)}>
          SILPI <span className="bg-gradient-to-r from-indigo-600 via-fuchsia-500 to-cyan-500 bg-clip-text text-transparent">AI</span>
        </span>
        {tagline && <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Intelligent Development Agent</span>}
      </span>
    </span>
  );
}
