
"use client";

import { useRef, useState } from "react";

import {
  AlertCircle,
  ArrowRight,
  Check,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Link2,
  Paperclip,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

import { TechnologyPicker } from "@/components/ui/technology-picker";
import { formatBytes } from "@/lib/utils";

const ACCEPTED_FILES =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.zip";

type UploadFile = {
  id: string;
  file: File;
};


export function CreateProject() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [designUrl, setDesignUrl] = useState("");

  const [frontend, setFrontend] = useState<string[]>(["Next.js"]);
  const [backend, setBackend] = useState<string[]>([]);
  const [database, setDatabase] = useState<string[]>([]);
  const [styling, setStyling] = useState<string[]>(["Tailwind CSS"]);

  const [files, setFiles] = useState<UploadFile[]>([]);
  const [notice, setNotice] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedPath, setGeneratedPath] = useState("");
  const [drag, setDrag] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Add uploaded files
  const addFiles = (list: FileList | null) => {
    if (!list) return;

    const next = Array.from(list).map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
    }));

    setFiles((old) => [
      ...old,
      ...next.filter(
        (item) => !old.some((existing) => existing.id === item.id)
      ),
    ]);
  };

  // Remove uploaded file
  const removeFile = (id: string) => {
    setFiles((old) => old.filter((item) => item.id !== id));
  };

  // File icon detection
  const fileIcon = (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (["xls", "xlsx", "csv"].includes(ext || "")) {
      return FileSpreadsheet;
    }

    if (["png", "jpg", "jpeg", "webp"].includes(ext || "")) {
      return FileImage;
    }

    if (["pdf", "doc", "docx", "ppt", "pptx"].includes(ext || "")) {
      return FileText;
    }

    return File;
  };

  // Submit the brief to the local SILPI agent through the Next.js API route.
  const submit = async () => {
    if (!name.trim() || !description.trim()) {
      setNotice("Add a project name and description to continue.");
      return;
    }

    if (frontend.length !== 1) {
      setNotice("Select exactly one supported frontend framework.");
      return;
    }

    if (backend.length > 1 || database.length > 1) {
      setNotice("Select at most one backend and one database. Your current SILPI agent accepts one of each.");
      return;
    }

    if (files.length > 0) {
      setNotice("Your files are selected, but document parsing is not connected yet. Remove the files to continue; your description and technology choices will be sent to SILPI.");
      return;
    }

    setIsGenerating(true);
    setNotice("");
    setGeneratedPath("");

    try {
      const response = await fetch("/api/projects/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          designUrl: designUrl.trim(),
          frontend,
          backend,
          database,
          styling,
        }),
      });

      const result = (await response.json()) as {
        success?: boolean;
        message?: string;
        projectPath?: string;
        error?: string;
      };

      if (!response.ok || !result.success) {
        throw new Error(result.error || "SILPI project generation failed.");
      }

      setGeneratedPath(result.projectPath || "");
      setNotice(result.message || "Project generated successfully.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Unable to connect to the SILPI agent."
      );
    } finally {
      setIsGenerating(false);
    }
  };

  // Generation checklist
  const checklist = [
    { t: "Project name", ok: !!name },
    { t: "Project description", ok: !!description },
    {
      t: "Technology preference",
      ok: frontend.length > 0 || backend.length > 0,
    },
    { t: "Reference documents", ok: files.length > 0 },
  ];

  return (
    <div className="mx-auto max-w-[1050px] space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.14em] text-violet-300">
            <Sparkles size={12} />
            New workspace
          </div>

          <h2 className="text-xl font-semibold tracking-tight">
            Let's build something great.
          </h2>

          <p className="mt-1 text-xs text-slate-500">
            Share your idea and choose the technologies. SILPI will use your
            existing local agent to generate the project.
          </p>
        </div>

        <span className="rounded-full border border-white/[.08] px-3 py-1.5 text-[10px] text-slate-500">
          Live agent generation
        </span>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          {/* 01 - Project Details */}
          <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-400/10 text-xs font-semibold text-violet-300">
                01
              </span>

              <div>
                <h3 className="text-xs font-semibold">Project details</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  Start with the outcome you want to create.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Project Name */}
              <div>
                <label className="mb-2 block text-xs font-medium text-slate-300">
                  Project name <span className="text-rose-400">*</span>
                </label>

                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Vismayam Commerce"
                  className="h-10 w-full rounded-lg border border-white/[.09] bg-[#10141d] px-3 text-xs outline-none transition placeholder:text-slate-600 focus:border-violet-400/50"
                />
              </div>

              {/* Project Description */}
              <div>
                <label className="mb-2 block text-xs font-medium text-slate-300">
                  Project description{" "}
                  <span className="text-rose-400">*</span>
                </label>

                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={7}
                  placeholder={`Describe your application, its users, key features and expected behavior...

Example: Build an e-commerce platform with customer login, product catalog, cart, checkout and an admin dashboard.`}
                  className="w-full resize-y rounded-lg border border-white/[.09] bg-[#10141d] p-3 text-xs leading-6 outline-none transition placeholder:text-slate-600 focus:border-violet-400/50"
                />

                <div className="mt-1.5 flex justify-between text-[10px] text-slate-600">
                  <span>
                    Include as much detail as you have. Partial requirements
                    are welcome.
                  </span>

                  <span>{description.length} chars</span>
                </div>
              </div>

              {/* Design Reference URL */}
              <div>
                <label className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
                  <Link2 size={13} className="text-slate-500" />
                  Design reference URL
                  <span className="text-[10px] font-normal text-slate-600">
                    Optional
                  </span>
                </label>

                <input
                  type="url"
                  value={designUrl}
                  onChange={(e) => setDesignUrl(e.target.value)}
                  placeholder="https://figma.com/... or your design reference"
                  className="h-10 w-full rounded-lg border border-white/[.09] bg-[#10141d] px-3 text-xs outline-none placeholder:text-slate-600 focus:border-violet-400/50"
                />
              </div>
            </div>
          </section>

          {/* 02 - Project Documents */}
          <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-400/10 text-xs font-semibold text-sky-300">
                02
              </span>

              <div>
                <h3 className="text-xs font-semibold">Project documents</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  Upload full or partial requirements and reference files.
                </p>
              </div>
            </div>

            {/* Drag and Drop Upload */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              className={`cursor-pointer rounded-xl border border-dashed p-7 text-center transition ${drag
                  ? "border-violet-400 bg-violet-400/10"
                  : "border-white/[.14] bg-[#10141d] hover:border-violet-400/50 hover:bg-white/[.02]"
                }`}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />

              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-violet-400/10 text-violet-300">
                <UploadCloud size={21} />
              </span>

              <p className="mt-3 text-xs font-medium text-slate-200">
                Drop files here or{" "}
                <span className="text-violet-300">browse files</span>
              </p>

              <p className="mt-1.5 text-[10px] text-slate-600">
                PDF, Word, Excel, PowerPoint, images, TXT, CSV, JSON and ZIP
              </p>

              <p className="mt-2 text-[9px] text-slate-700">
                File size and content validation will be handled by the backend.
              </p>
            </div>

            {/* Uploaded File List */}
            {files.length > 0 && (
              <div className="mt-3 space-y-2">
                {files.map(({ id, file }) => {
                  const Icon = fileIcon(file);

                  return (
                    <div
                      key={id}
                      className="flex items-center gap-3 rounded-lg border border-white/[.06] bg-[#10141d] px-3 py-2.5"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[.05] text-slate-400">
                        <Icon size={15} />
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] text-slate-200">
                          {file.name}
                        </p>

                        <p className="mt-0.5 text-[9px] text-slate-600">
                          {formatBytes(file.size)}
                        </p>
                      </div>

                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(id);
                        }}
                        className="text-slate-600 hover:text-rose-300"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 03 - Technology Stack */}
          <section className="rounded-xl border border-white/[.07] bg-[#151923] p-5 sm:p-6">
            <div className="mb-5 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/10 text-xs font-semibold text-emerald-300">
                03
              </span>

              <div>
                <h3 className="text-xs font-semibold">Technology stack</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  Choose your preferred stack or let the AI recommend one.
                </p>
              </div>
            </div>


            <div className="grid gap-4 sm:grid-cols-2">
              {/* Frontend */}
              <TechnologyPicker
                label="Frontend"
                placeholder="Choose frontend framework"
                group="Frontend"
                selected={frontend}
                onChange={setFrontend}
              />

              {/* Backend */}
              <TechnologyPicker
                label="Backend"
                placeholder="Choose backend technology"
                group="Backend"
                selected={backend}
                onChange={setBackend}
                optional
              />

              {/* Database */}
              <TechnologyPicker
                label="Database"
                placeholder="Choose database"
                group="Database"
                selected={database}
                onChange={setDatabase}
                optional
              />

              {/* Styling */}
              <TechnologyPicker
                label="Styling"
                placeholder="Choose styling tools"
                group="Styling"
                selected={styling}
                onChange={setStyling}
                optional
              />
            </div>


            <div className="mt-4 flex items-start gap-2 rounded-lg border border-sky-400/10 bg-sky-400/[.04] p-3">
              <AlertCircle
                size={14}
                className="mt-0.5 shrink-0 text-sky-300"
              />

              <p className="text-[10px] leading-5 text-slate-400">
                Backend and database are optional. SILPI AI can propose a
                compatible architecture based on your requirements.
              </p>
            </div>
          </section>

          {/* Form Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[10px] text-slate-600">
              Your files stay in this browser preview until backend upload is
              connected.
            </p>

            <button
              type="button"
              onClick={submit}
              disabled={isGenerating}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-3 text-xs font-semibold text-white shadow-lg shadow-violet-900/20 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGenerating ? "Generating project..." : "Generate project with SILPI"}
              {!isGenerating && <ArrowRight size={15} />}
            </button>
          </div>

          {notice && (
            <div
              role="status"
              className="space-y-2 rounded-lg border border-violet-400/20 bg-violet-400/[.07] px-4 py-3 text-xs text-violet-200"
            >
              <p>{notice}</p>
              {generatedPath && (
                <p className="break-all font-mono text-[10px] text-emerald-300">
                  Generated folder: {generatedPath}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Right Sidebar */}
        <aside className="space-y-4">
          {/* Generation Checklist */}
          <div className="rounded-xl border border-white/[.07] bg-[#151923] p-4">
            <h3 className="text-xs font-semibold">
              Generation checklist
            </h3>

            <p className="mt-1 text-[10px] text-slate-500">
              A good brief helps the agent create a better plan.
            </p>

            <div className="mt-4 space-y-3">
              {checklist.map((item) => (
                <div
                  key={item.t}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full ${item.ok
                        ? "bg-emerald-400/15 text-emerald-300"
                        : "border border-slate-700 text-slate-700"
                      }`}
                  >
                    {item.ok && <Check size={10} />}
                  </span>

                  <span
                    className={
                      item.ok ? "text-slate-300" : "text-slate-500"
                    }
                  >
                    {item.t}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Next Steps */}
          <div className="rounded-xl border border-violet-400/15 bg-gradient-to-br from-violet-500/[.10] to-[#151923] p-4">
            <Sparkles size={17} className="text-violet-300" />

            <h3 className="mt-3 text-xs font-semibold">
              What happens next?
            </h3>

            <ol className="mt-3 space-y-3 text-[10px] leading-5 text-slate-400">
              <li>
                <b className="mr-2 text-violet-300">01</b>
                Analyze your description and documents.
              </li>

              <li>
                <b className="mr-2 text-violet-300">02</b>
                Prepare architecture and file structure.
              </li>

              <li>
                <b className="mr-2 text-violet-300">03</b>
                Review and approve the generation plan.
              </li>

              <li>
                <b className="mr-2 text-violet-300">04</b>
                Generate, run and validate your project.
              </li>
            </ol>
          </div>

          {/* Accepted File Types */}
          <div className="rounded-xl border border-white/[.07] bg-[#151923] p-4">
            <div className="flex items-center gap-2 text-slate-300">
              <Paperclip size={14} />

              <span className="text-[11px] font-medium">
                Accepted file types
              </span>
            </div>

            <p className="mt-2 text-[10px] leading-5 text-slate-500">
              PDF · DOCX · XLSX · PPTX · TXT · MD · CSV · JSON · PNG · JPG ·
              ZIP
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
