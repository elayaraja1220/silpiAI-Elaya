"use client";
import { useState } from "react";
import { Activity, ArrowUpRight, Bell, Blocks, BookOpen, Bot, Boxes, ChevronDown, CircleHelp, Code2, Command, FileText, FolderKanban, Gauge, GitBranch, LayoutDashboard, Menu, Plus, Search, Settings, Sparkles, TerminalSquare, X } from "lucide-react";
import { Dashboard } from "@/components/pages/dashboard";
import { CreateProject } from "@/components/pages/create-project";
import { ProjectsPage } from "@/components/pages/projects";
import { ExistingProjects } from "@/components/pages/existing-projects";
import { ActivityPage } from "@/components/pages/activity";
import { SettingsPage } from "@/components/pages/settings";
import { cn } from "@/lib/utils";

type View = "dashboard" | "create" | "projects" | "existing" | "activity" | "settings";
const nav = [
 {label:"Workspace",items:[{id:"dashboard" as View,label:"Overview",icon:LayoutDashboard},{id:"create" as View,label:"Create project",icon:Plus},{id:"projects" as View,label:"My projects",icon:FolderKanban},{id:"existing" as View,label:"Existing projects",icon:GitBranch}]},
 {label:"Monitor",items:[{id:"activity" as View,label:"Agent activity",icon:Activity}]},
 {label:"Preferences",items:[{id:"settings" as View,label:"Settings",icon:Settings}]}
];
const titles: Record<View,string> = {dashboard:"Overview",create:"Create a project",projects:"My projects",existing:"Existing projects",activity:"Agent activity",settings:"Settings"};
export function AppShell() {
 const [view,setView] = useState<View>("dashboard"); const [mobileOpen,setMobileOpen] = useState(false);
 const changeView=(next:View)=>{setView(next);setMobileOpen(false)};
 return <div className="min-h-screen bg-[#0e1118] text-[#f5f6fb]">
  <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-[258px] flex-col border-r border-white/[.07] bg-[#121620] transition-transform duration-200 lg:translate-x-0",mobileOpen?"translate-x-0":"-translate-x-full")}>
   <div className="flex h-[76px] items-center justify-between border-b border-white/[.07] px-6"><button onClick={()=>changeView("dashboard")} className="flex items-center gap-3 text-left"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b] shadow-lg shadow-violet-500/20"><Command size={19}/></span><span><span className="block text-[16px] font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span><span className="block text-[10px] tracking-[.16em] text-slate-500">DEVELOPMENT STUDIO</span></span></button><button className="lg:hidden text-slate-400" onClick={()=>setMobileOpen(false)}><X size={18}/></button></div>
   <div className="px-4 pt-5"><button onClick={()=>changeView("create")} className="flex w-full items-center justify-between rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 transition hover:bg-violet-400"><span className="flex items-center gap-2"><Plus size={17}/> New project</span><span className="rounded-md bg-white/15 px-1.5 py-0.5 text-[10px]">⌘ K</span></button></div>
   <nav className="custom-scrollbar flex-1 overflow-y-auto px-3 py-6">{nav.map(group=><div key={group.label} className="mb-7"><p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-600">{group.label}</p>{group.items.map(item=>{const Icon=item.icon;return <button key={item.id} onClick={()=>changeView(item.id)} className={cn("mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition",view===item.id?"bg-white/[.08] text-white":"text-slate-400 hover:bg-white/[.04] hover:text-slate-200")}><Icon size={17} className={view===item.id?"text-violet-300":"text-slate-500"}/>{item.label}{item.id==="activity"&&<span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400"/>}</button>})}</div>)}</nav>
   <div className="mx-4 mb-4 rounded-xl border border-violet-400/15 bg-gradient-to-br from-violet-500/10 to-transparent p-3"><div className="mb-2 flex items-center gap-2 text-violet-200"><Sparkles size={15}/><span className="text-xs font-semibold">SILPI AI Agent</span></div><p className="text-[11px] leading-5 text-slate-400">Your development workspace is ready. Connect an AI provider to start generating projects.</p><button onClick={()=>changeView("settings")} className="mt-3 text-[11px] font-semibold text-violet-300 hover:text-violet-200">Configure agent <ArrowUpRight size={12} className="ml-1 inline"/></button></div>
   <div className="border-t border-white/[.07] p-4"><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold">ER</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-slate-200">Workspace owner</p><p className="text-[10px] text-slate-500">Personal workspace</p></div><button onClick={()=>changeView("settings")} className="text-slate-500 hover:text-white"><Settings size={15}/></button></div></div>
  </aside>
  {mobileOpen&&<button aria-label="Close menu" className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={()=>setMobileOpen(false)}/>}
  <main className="min-h-screen lg:pl-[258px]"><header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-white/[.07] bg-[#0e1118]/90 px-5 backdrop-blur-xl sm:px-8"><div className="flex items-center gap-3"><button className="text-slate-400 lg:hidden" onClick={()=>setMobileOpen(true)}><Menu size={20}/></button><div><div className="flex items-center gap-2 text-[11px] text-slate-500"><span>Workspace</span><span>/</span><span className="text-slate-300">{titles[view]}</span></div><h1 className="mt-0.5 text-[15px] font-semibold tracking-tight">{titles[view]}</h1></div></div><div className="flex items-center gap-2 sm:gap-3"><div className="hidden h-9 w-52 items-center gap-2 rounded-lg border border-white/[.08] bg-white/[.025] px-3 md:flex"><Search size={14} className="text-slate-500"/><span className="text-xs text-slate-600">Search anything...</span><span className="ml-auto rounded border border-white/10 px-1 text-[9px] text-slate-500">⌘ K</span></div><button className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-white/[.08] text-slate-400 hover:bg-white/[.05]"><Bell size={16}/><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-violet-400"/></button><div className="hidden h-8 items-center gap-1 rounded-lg border border-white/[.08] px-2 text-[11px] text-slate-400 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/> Local workspace <ChevronDown size={12}/></div></div></header>
   <div className="mx-auto max-w-[1440px] p-5 sm:p-8">{view==="dashboard"&&<Dashboard onNavigate={changeView}/>}{view==="create"&&<CreateProject/>}{view==="projects"&&<ProjectsPage onNavigate={changeView}/>}{view==="existing"&&<ExistingProjects/>}{view==="activity"&&<ActivityPage/>}{view==="settings"&&<SettingsPage/>}</div>
  </main>
 </div>;
}
