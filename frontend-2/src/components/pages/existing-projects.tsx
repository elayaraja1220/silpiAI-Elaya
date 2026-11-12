
"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";

import {
  Archive,
  ArrowRight,
  FolderOpen,
  GitBranch,
  HardDrive,
  Info,
  UploadCloud,
} from "lucide-react";

import { formatBytes } from "@/lib/utils";

export function ExistingProjects() {
  const zipInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [folderName, setFolderName] = useState("");
  const [message, setMessage] = useState("");

  // Handle ZIP File Selection
  const handleZipChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];

    if (selectedFile) {
      if (!selectedFile.name.toLowerCase().endsWith(".zip")) {
        setMessage("Please select a valid ZIP file.");
        return;
      }

      setFile(selectedFile);
      setFolderName("");
      setMessage("");
    }
  };

  // Handle Local Folder Selection
  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];

    if (selectedFile) {
      const selectedFolder =
        selectedFile.webkitRelativePath.split("/")[0] ||
        selectedFile.name;

      setFolderName(selectedFolder);
      setFile(null);
      setMessage("");
    }
  };

  // Continue to Project Analysis
  const handleContinue = () => {
    if (file) {
      setMessage(
        "ZIP selected. Connect the import API to upload and analyze this project."
      );
      return;
    }

    if (folderName) {
      setMessage(
        "Folder selected. Connect the local workspace agent to inspect it."
      );
      return;
    }

    setMessage("Choose a ZIP file or local folder first.");
  };

  // Import Process Steps
  const importSteps = [
    {
      n: "01",
      t: "Inspect",
      d: "Detect framework, versions and structure.",
    },
    {
      n: "02",
      t: "Understand",
      d: "Map routes, components and services.",
    },
    {
      n: "03",
      t: "Plan changes",
      d: "Review files to add or modify.",
    },
    {
      n: "04",
      t: "Implement",
      d: "Apply changes, test and build.",
    },
  ];

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">

      {/* Page Header */}
      <div>
        <div className="mb-2 inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.14em] text-violet-300">
          <GitBranch size={12} />
          Bring your own codebase
        </div>

        <h2 className="text-xl font-semibold">
          Continue with an existing project.
        </h2>

        <p className="mt-1 text-xs text-slate-500">
          Import a codebase, let SILPI AI understand its architecture,
          then request new components or features.
        </p>
      </div>

      {/* Import Options */}
      <div className="grid gap-4 md:grid-cols-2">

        {/* ZIP Upload */}
        <section className="rounded-xl border border-white/[.08] bg-[#151923] p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-400/10 text-violet-300">
            <Archive size={19} />
          </span>

          <h3 className="mt-4 text-sm font-semibold">
            Upload project ZIP
          </h3>

          <p className="mt-1 text-xs leading-5 text-slate-500">
            Best for sharing a snapshot of your project. Include source
            files and configuration; omit node_modules and build output.
          </p>

          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={handleZipChange}
          />

          <button
            type="button"
            onClick={() => zipInputRef.current?.click()}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-[#10141d] px-3 py-5 text-xs text-slate-300 transition hover:border-violet-400/40"
          >
            <UploadCloud size={16} className="text-violet-300" />
            Choose ZIP file
          </button>

          {file && (
            <div className="mt-3 rounded-lg bg-black/20 p-3 text-[10px] text-slate-300">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{file.name}</span>
                <span className="shrink-0">
                  {formatBytes(file.size)}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* Local Folder Selection */}
        <section className="rounded-xl border border-white/[.08] bg-[#151923] p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
            <FolderOpen size={19} />
          </span>

          <h3 className="mt-4 text-sm font-semibold">
            Select local project folder
          </h3>

          <p className="mt-1 text-xs leading-5 text-slate-500">
            Choose a folder from your computer. For full file access
            and command execution, install the secure SILPI local
            workspace agent.
          </p>

          <label className="mt-5 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-[#10141d] px-3 py-5 text-xs text-slate-300 transition hover:border-sky-400/40">
            <HardDrive size={16} className="text-sky-300" />

            Select folder

            <input
              type="file"
              className="hidden"
              {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
              multiple
              onChange={handleFolderChange}
            />
          </label>

          {folderName && (
            <div className="mt-3 rounded-lg bg-black/20 p-3 text-[10px] text-slate-300">
              Selected folder: {folderName}
            </div>
          )}
        </section>
      </div>

      {/* Important Information */}
      <div className="flex items-start gap-2 rounded-lg border border-sky-400/15 bg-sky-400/[.04] p-4">
        <Info
          size={15}
          className="mt-0.5 shrink-0 text-sky-300"
        />

        <p className="text-[10px] leading-5 text-slate-400">
          Browser folder selection is permission-based and has limitations.
          This UI does not yet upload or execute local files. Connect the
          local agent or import API to enable secure scanning, file changes
          and run/build actions.
        </p>
      </div>

      {/* Import Workflow */}
      <section className="rounded-xl border border-white/[.08] bg-[#151923] p-5">
        <h3 className="text-xs font-semibold">
          After import
        </h3>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          {importSteps.map((step) => (
            <div key={step.n}>
              <span className="text-[10px] font-semibold text-violet-300">
                {step.n}
              </span>

              <p className="mt-1 text-xs font-medium">
                {step.t}
              </p>

              <p className="mt-1 text-[10px] leading-5 text-slate-500">
                {step.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Continue Action */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleContinue}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400"
        >
          Continue to analysis
          <ArrowRight size={14} />
        </button>
      </div>

      {/* Status Message */}
      {message && (
        <p
          role="status"
          className="rounded-lg border border-violet-400/20 bg-violet-400/[.06] p-3 text-xs text-violet-200"
        >
          {message}
        </p>
      )}
    </div>
  );
}
