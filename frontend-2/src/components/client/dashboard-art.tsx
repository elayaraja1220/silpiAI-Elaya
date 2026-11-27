import { Briefcase, Building2, GraduationCap, Globe, Music, Palette, Plane, ShoppingCart, Stethoscope, UtensilsCrossed, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The look of a project on the dashboard: a coloured tile with an icon that suits what the project is (read from its title). A project has no picture of its own, so this
 * is a tile, not a photo. The colour is steady per project, so a project keeps its look between visits.
 */
const KINDS: { test: RegExp; icon: LucideIcon }[] = [
  { test: /\b(store|shop|shopping|e-?commerce|cart|boutique|market|sale)\b/i, icon: ShoppingCart },
  { test: /\b(travel|tour|tours|trip|flight|hotel|holiday|cab|bus|booking)\b/i, icon: Plane },
  { test: /\b(music|vocal|song|dance|band|concert|instrument|nadaswaram)\b/i, icon: Music },
  { test: /\b(food|restaurant|cafe|bakery|kitchen|catering|hotel)\b/i, icon: UtensilsCrossed },
  { test: /\b(school|college|course|academy|learn|learning|education|tuition|training)\b/i, icon: GraduationCap },
  { test: /\b(hospital|clinic|health|doctor|medical|dental|pharmacy)\b/i, icon: Stethoscope },
  { test: /\b(real estate|property|apartment|builder|construction|interior)\b/i, icon: Building2 },
  { test: /\b(art|arts|gallery|craft|design|photo|photography|studio)\b/i, icon: Palette },
  { test: /\b(consult|agency|company|business|firm|services)\b/i, icon: Briefcase },
];
export const iconForProject = (title: string): LucideIcon => KINDS.find((k) => k.test.test(title))?.icon ?? Globe;

const TILES = ["from-sky-500/70 to-indigo-700/80", "from-fuchsia-500/70 to-violet-800/80", "from-amber-500/70 to-rose-700/80", "from-emerald-500/70 to-teal-800/80", "from-violet-500/70 to-indigo-800/80", "from-rose-500/70 to-purple-800/80"];
const tileOf = (id: string) => TILES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TILES.length]!;

export function ProjectTile({ id, title, className }: { id: string; title: string; className?: string }) {
  const Icon = iconForProject(title);
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br ring-1 ring-white/10", tileOf(id), className)} aria-hidden>
      <Icon className="absolute -bottom-3 -right-3 h-14 w-14 text-white/15" strokeWidth={1.5} />
      <Icon className="relative h-1/2 w-1/2 text-white/95 drop-shadow" strokeWidth={1.75} />
    </span>
  );
}

/** A laptop with code on it, in the welcome banner. Decorative. */
export function LaptopArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 170" className={className} aria-hidden fill="none">
      <defs>
        <linearGradient id="la-edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c4b5fd" /><stop offset="1" stopColor="#6d28d9" /></linearGradient>
        <radialGradient id="la-glow" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#8b5cf6" stopOpacity=".55" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="170" cy="120" rx="150" ry="46" fill="url(#la-glow)" />
      <path d="M4 150 C 60 96, 120 150, 196 96 S 290 70, 316 40" stroke="url(#la-edge)" strokeWidth="1.5" opacity=".55" />
      <path d="M20 160 C 80 118, 140 158, 210 112" stroke="url(#la-edge)" strokeWidth="1" opacity=".35" />
      <g transform="translate(88 14)">
        <rect x="28" y="0" width="164" height="102" rx="9" fill="#150f33" stroke="url(#la-edge)" strokeWidth="2" />
        <rect x="36" y="8" width="148" height="86" rx="4" fill="#1d1545" />
        <text x="110" y="66" textAnchor="middle" fontSize="36" fontFamily="monospace" fontWeight="700" fill="#8b7cff">&lt;/&gt;</text>
        <path d="M6 108 H214 L202 126 H18 Z" fill="#1a1440" stroke="url(#la-edge)" strokeWidth="1.5" />
        <rect x="92" y="112" width="36" height="4" rx="2" fill="#6d28d9" opacity=".7" />
      </g>
    </svg>
  );
}

/** A soft rising line behind a count: decoration only, it carries no data. */
export function Wave({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 36" className={className} aria-hidden fill="none">
      <path d="M2 30 C 14 28, 20 12, 34 17 S 58 6, 70 14 S 84 4, 88 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Soft glowing curves behind the top of a page's header. Decorative. */
export function Swoosh({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 380 150" className={className} aria-hidden fill="none">
      <defs>
        <linearGradient id="sw-a" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#8b5cf6" stopOpacity="0" /><stop offset=".55" stopColor="#a78bfa" stopOpacity=".7" /><stop offset="1" stopColor="#c4b5fd" stopOpacity=".15" /></linearGradient>
      </defs>
      <path d="M0 130 C 80 120, 130 40, 230 52 S 340 20, 380 4" stroke="url(#sw-a)" strokeWidth="2" />
      <path d="M20 146 C 100 136, 150 66, 240 74 S 340 50, 380 30" stroke="url(#sw-a)" strokeWidth="1.2" opacity=".7" />
      <path d="M50 150 C 130 144, 180 92, 260 96 S 350 80, 380 64" stroke="url(#sw-a)" strokeWidth="1" opacity=".45" />
    </svg>
  );
}
