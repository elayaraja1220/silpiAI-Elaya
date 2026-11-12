export function cn(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
export function formatBytes(bytes: number) { if (bytes === 0) return "0 B"; const units = ["B","KB","MB","GB"]; const index = Math.floor(Math.log(bytes) / Math.log(1024)); return `${(bytes / Math.pow(1024,index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`; }
