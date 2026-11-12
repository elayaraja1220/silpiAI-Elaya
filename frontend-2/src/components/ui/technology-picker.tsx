
"use client";

import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Search,
  X,
} from "lucide-react";

import { technologies } from "@/mockdata/technologies";
import type { TechnologyGroup } from "@/types";
import { cn } from "@/lib/utils";

interface TechnologyPickerProps {
  label: string;
  placeholder: string;
  group: TechnologyGroup;
  selected: string[];
  onChange: (value: string[]) => void;
  optional?: boolean;
}

export function TechnologyPicker({
  label,
  placeholder,
  group,
  selected,
  onChange,
  optional = false,
}: TechnologyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Display only technologies belonging to this category.
  const filtered = useMemo(() => {
    const searchTerm = query.trim().toLowerCase();

    return technologies.filter(
      (technology) =>
        technology.group === group &&
        (
          !searchTerm ||
          technology.name.toLowerCase().includes(searchTerm) ||
          technology.detail?.toLowerCase().includes(searchTerm)
        )
    );
  }, [group, query]);

  // Toggle technology selection.
  const toggleTechnology = (name: string) => {
    onChange(
      selected.includes(name)
        ? selected.filter((item) => item !== name)
        : [...selected, name]
    );
  };

  const closeDropdown = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      {/* Label */}
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium text-slate-300">
          {label}
        </label>

        {optional && (
          <span className="text-[10px] text-slate-600">
            Optional
          </span>
        )}
      </div>

      {/* Selected Technologies */}
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className={cn(
          "flex min-h-[43px] w-full items-center justify-between gap-2 rounded-lg border border-white/[.09] bg-[#10141d] px-3 py-2 text-left text-xs transition hover:border-violet-400/40",
          open && "border-violet-400/50"
        )}
      >
        <span className="flex flex-wrap gap-1.5">
          {selected.length > 0 ? (
            selected.map((technology) => (
              <span
                key={technology}
                className="inline-flex items-center gap-1 rounded-md bg-violet-400/10 px-2 py-1 text-[10px] text-violet-200"
              >
                {technology}

                <span
                  role="button"
                  aria-label={`Remove ${technology}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTechnology(technology);
                  }}
                  className="cursor-pointer"
                >
                  <X size={11} />
                </span>
              </span>
            ))
          ) : (
            <span className="py-1 text-slate-600">
              {placeholder}
            </span>
          )}
        </span>

        <ChevronDown
          size={15}
          className="shrink-0 text-slate-500"
        />
      </button>

      {/* Dropdown */}
      {open && (
        <>
          <button
            type="button"
            aria-label="Close technology selector"
            className="fixed inset-0 z-20 cursor-default"
            onClick={closeDropdown}
          />

          <div className="absolute left-0 top-full z-30 mt-2 max-h-[330px] w-full overflow-hidden rounded-xl border border-white/10 bg-[#1a1f2b] shadow-2xl">
            {/* Search */}
            <div className="border-b border-white/[.07] p-2">
              <div className="flex items-center gap-2 rounded-lg bg-black/20 px-3">
                <Search size={14} className="text-slate-500" />

                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search ${label.toLowerCase()}...`}
                  className="h-9 w-full bg-transparent text-xs outline-none placeholder:text-slate-600"
                />
              </div>
            </div>

            {/* Category-specific options */}
            <div className="custom-scrollbar max-h-[260px] overflow-y-auto p-2">
              {filtered.length > 0 ? (
                filtered.map((technology) => {
                  const isSelected = selected.includes(
                    technology.name
                  );

                  return (
                    <button
                      key={technology.name}
                      type="button"
                      onClick={() =>
                        toggleTechnology(technology.name)
                      }
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-white/[.05]"
                    >
                      <span>
                        <span className="block text-xs text-slate-200">
                          {technology.name}
                        </span>

                        {technology.detail && (
                          <span className="text-[10px] text-slate-600">
                            {technology.detail}
                          </span>
                        )}
                      </span>

                      <span
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded border",
                          isSelected
                            ? "border-violet-400 bg-violet-500 text-white"
                            : "border-slate-600"
                        )}
                      >
                        {isSelected && <Check size={11} />}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-6 text-center text-xs text-slate-500">
                  No matching {label.toLowerCase()} found.
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-white/[.07] px-3 py-2">
              <span className="text-[10px] text-slate-500">
                {selected.length} selected
              </span>

              <button
                type="button"
                onClick={closeDropdown}
                className="rounded-md bg-violet-500 px-3 py-1.5 text-[10px] font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
