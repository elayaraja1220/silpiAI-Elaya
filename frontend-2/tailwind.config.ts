import type { Config } from "tailwindcss";
const config: Config = { content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"], theme: { extend: { colors: { ink: "#10131b", panel: "#171b26", line: "#292f3d", muted: "#9299aa", brand: "#8b7cff", mint: "#5ed6b0" }, boxShadow: { soft: "0 18px 60px rgba(0,0,0,.22)" } } }, plugins: [] };
export default config;
