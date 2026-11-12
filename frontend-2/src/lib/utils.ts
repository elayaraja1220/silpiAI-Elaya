export function cn(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
export function formatBytes(bytes: number) { if (bytes === 0) return "0 B"; const units = ["B","KB","MB","GB"]; const index = Math.floor(Math.log(bytes) / Math.log(1024)); return `${(bytes / Math.pow(1024,index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`; }
export function formatRelativeTime(iso: string) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
