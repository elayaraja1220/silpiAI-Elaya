
import type { ReactNode } from "react";

interface SectionHeadingProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function SectionHeading({
  title,
  description,
  action,
}: SectionHeadingProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      {/* Heading Content */}
      <div>
        <h2 className="text-sm font-semibold text-slate-100">
          {title}
        </h2>

        {description && (
          <p className="mt-1 text-xs text-slate-500">
            {description}
          </p>
        )}
      </div>

      {/* Optional Action */}
      {action}
    </div>
  );
}
