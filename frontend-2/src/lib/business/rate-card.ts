import type { RateCard } from "./types";

/** The handover is the same in every package: source code, deployment details and access information. */
export const HANDOVER_LABEL = "Website handover & source code";
const HANDOVER_DETAIL = "Includes the source code, the deployment details and the access information needed to run and update the site.";

/**
 * Sample rates in INR. Placeholders to get started: edit them in
 * Business & pricing to match your business. Development is priced in hours
 * (hours × hourly rate), so every line on the quotation can be explained.
 * Domain and hosting prices must be checked against your provider.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  business: {
    name: "SILPI AI Development Studio",
    gstin: "",
    state: "Tamil Nadu",
    address: "",
    email: "",
    phone: "",
  },
  gstRate: 18,
  advancePercent: 50,
  quoteValidityDays: 15,
  maxDiscountPercent: 10,
  hourlyRate: 500,
  hoursPerWeek: 30,
  projectTypes: {
    "landing-page": { label: "Landing page", setupHours: 6 },
    "business-website": { label: "Business website", setupHours: 10 },
    "cms-website": { label: "CMS website (React + Node)", setupHours: 30 },
    ecommerce: { label: "E-commerce store", setupHours: 40 },
    "web-app": { label: "Custom web application", setupHours: 50 },
  },
  page: { baseHours: 2, sectionHours: 1.5, defaultSections: 3 },
  scopeBaseFactor: { full: 1, partial: 0.6, module: 0, version: 0.4 },
  existingProjectHours: 10,
  premiumCareHours: 6,
  complexity: {
    basic: { label: "Basic", multiplier: 0.85 },
    standard: { label: "Standard", multiplier: 1 },
    advanced: { label: "Advanced", multiplier: 1.35 },
  },
  modules: {
    // No server needed: a static site sends enquiries by email through a form service.
    "contact-form": { label: "Contact / enquiry form", hours: 4, backend: false, detail: "Form with validation and spam protection; enquiries arrive by email." },
    auth: { label: "User login & registration", hours: 16, backend: true, detail: "Sign up, login, forgot password and profile, with secure sessions." },
    "admin-panel": { label: "Admin panel", hours: 30, backend: true, detail: "Private dashboard to add, edit and remove the site's content and records." },
    blog: { label: "Blog / news", hours: 12, backend: true, detail: "Posts with categories, images and SEO fields, edited from the admin." },
    payments: { label: "Online payments (Razorpay)", hours: 20, backend: true, detail: "UPI, cards and net banking with server-side payment verification." },
    booking: { label: "Booking / appointments", hours: 24, backend: true, detail: "Available slots, booking form, confirmations and admin calendar." },
    search: { label: "Search & filters", hours: 10, backend: true, detail: "Search box with filters and sorting on listings." },
    multilingual: { label: "Multi-language (e.g. Tamil + English)", hours: 14, backend: false, detail: "Language switch with translated pages and menus." },
    chat: { label: "Live chat", hours: 18, backend: true, detail: "Real-time chat between visitors and staff." },
    notifications: { label: "Email / SMS / WhatsApp notifications", hours: 12, backend: true, detail: "Automatic messages for orders, bookings or enquiries." },
    reports: { label: "Reports & dashboard", hours: 20, backend: true, detail: "Sales and activity charts with export to Excel." },
    "api-integration": { label: "Third-party API integration", hours: 16, backend: true, detail: "Connection to one outside service (courier, CRM, ERP...)." },
    "seo-setup": { label: "SEO setup (Search Console, analytics, schema)", hours: 8, backend: false, detail: "Search Console, Google Analytics, structured data and keyword-tuned page titles." },
    "gallery-preview": { label: "Gallery image preview (lightbox)", hours: 3, backend: false, detail: "Click an image to see it large, with next / previous and swipe on mobile." },
    "image-slider": { label: "Image slider / carousel", hours: 3, backend: false, detail: "Auto-playing banner or showcase slider with arrows and swipe." },
    whatsapp: { label: "WhatsApp chat button", hours: 1, backend: false, detail: "Floating button that opens a WhatsApp chat with the business number." },
    "google-maps": { label: "Google Maps location", hours: 1, backend: false, detail: "Embedded map of the business location (free Google Maps embed)." },
  },
  design: {
    ai: { label: "AI-generated design", hours: 0, detail: "Clean modern design generated and refined in one review round." },
    template: { label: "Ready-made template, customised", hours: 6, detail: "Licensed template styled with the client's logo, colours and fonts." },
    custom: { label: "Custom design by designer", hours: 30, detail: "Figma mock-ups of key pages with two revision rounds before coding." },
  },
  technology: {
    frontend: {
      next: { label: "Next.js (React)", factor: 1, available: true, detail: "Fast, search-friendly; our standard." },
      vue: { label: "Vue (Nuxt)", factor: 1.1, available: true, detail: "Light and easy to maintain." },
      angular: { label: "Angular", factor: 1.2, available: true, detail: "Structured, for large business apps." },
      react: { label: "React (Vite)", factor: 1, available: true, detail: "Single-page app; good behind a login." },
      svelte: { label: "Svelte (SvelteKit)", factor: 1.05, available: true, detail: "Small, fast pages with little code." },
      plain: { label: "HTML, CSS and JavaScript", factor: 0.9, available: true, detail: "No framework; simple sites only." },
    },
    backend: {
      node: { label: "Node.js + Express", factor: 1, available: true, detail: "Our standard backend." },
      supabase: { label: "Supabase (ready-made login, API and file storage)", factor: 0.8, available: true, detail: "Less backend code; a monthly fee may apply as the site grows." },
      laravel: { label: "Laravel (PHP)", factor: 1.1, available: true, detail: "Common, runs on many hosts." },
      django: { label: "Django (Python)", factor: 1.15, available: true, detail: "Good for data-heavy apps." },
    },
    database: {
      postgres: { label: "PostgreSQL", factor: 1, available: true, detail: "Our standard database." },
      mysql: { label: "MySQL", factor: 1, available: true, detail: "Widely supported." },
      mongodb: { label: "MongoDB", factor: 1.05, available: true, detail: "Flexible, document based." },
    },
    // Styling and UI library. Only the ones that work with the chosen frontend are offered.
    styling: {
      tailwind: { label: "Tailwind CSS", factor: 1, available: true, detail: "Our standard: utility classes, fully custom look.", frameworks: [] },
      css: { label: "Plain CSS / CSS Modules", factor: 1.05, available: true, detail: "Hand-written styles; no extra library.", frameworks: [] },
      scss: { label: "SCSS / Sass", factor: 1.05, available: true, detail: "CSS with variables and nesting.", frameworks: [] },
      less: { label: "Less", factor: 1.05, available: true, detail: "CSS with variables and mixins.", frameworks: [] },
      bootstrap: { label: "Bootstrap", factor: 0.95, available: true, detail: "Most popular ready-made responsive components.", frameworks: ["next", "react", "vue", "angular", "svelte", "plain"] },
      daisyui: { label: "daisyUI (on Tailwind)", factor: 0.95, available: true, detail: "Ready components on top of Tailwind CSS.", frameworks: ["next", "react", "vue", "angular", "svelte"] },
      mui: { label: "Material UI", factor: 0.95, available: true, detail: "Google Material Design components for React.", frameworks: ["next", "react"] },
      antd: { label: "Ant Design", factor: 0.95, available: true, detail: "Rich enterprise components: tables, forms, dashboards.", frameworks: ["next", "react"] },
      primereact: { label: "PrimeReact", factor: 0.95, available: true, detail: "Large component set with data tables and charts.", frameworks: ["next", "react"] },
      chakra: { label: "Chakra UI", factor: 1, available: true, detail: "Simple, accessible React components.", frameworks: ["next", "react"] },
      shadcn: { label: "shadcn/ui", factor: 1, available: true, detail: "Copy-in components on Tailwind; easy to customise.", frameworks: ["next", "react"] },
      primeng: { label: "PrimeNG", factor: 0.95, available: true, detail: "Large component set for Angular.", frameworks: ["angular"] },
      "angular-material": { label: "Angular Material", factor: 0.95, available: true, detail: "Material Design components for Angular.", frameworks: ["angular"] },
      zorro: { label: "NG-ZORRO (Ant Design)", factor: 0.95, available: true, detail: "Ant Design components for Angular.", frameworks: ["angular"] },
      vuetify: { label: "Vuetify", factor: 0.95, available: true, detail: "Material Design components for Vue.", frameworks: ["vue"] },
      primevue: { label: "PrimeVue", factor: 0.95, available: true, detail: "Large component set for Vue.", frameworks: ["vue"] },
      "element-plus": { label: "Element Plus", factor: 0.95, available: true, detail: "Business-app components for Vue.", frameworks: ["vue"] },
      skeleton: { label: "Skeleton UI", factor: 1, available: true, detail: "Tailwind-based components for Svelte.", frameworks: ["svelte"] },
    },
  },
  stacks: {
    custom: {
      label: "Custom code",
      frontend: "Next.js (React)",
      backend: "Node.js + Express",
      database: "PostgreSQL",
      devFactor: 1,
      available: true,
      note: "Everything written for this project: full control and no platform fees.",
      tradeoff: "",
    },
    managed: {
      label: "Managed backend (Supabase)",
      frontend: "Next.js (React)",
      backend: "Supabase (ready-made login, API and file storage)",
      database: "PostgreSQL (Supabase)",
      devFactor: 0.8,
      available: true,
      note: "Login, database API and file storage come ready from Supabase, so less backend code is written. Its free tier is enough to start; the Pro plan (about US$25/month) is paid by the client when traffic grows.",
      tradeoff: "Depends on Supabase; a monthly fee may apply as the site grows.",
    },
    starter: {
      label: "SILPI starter kit",
      frontend: "Next.js (React) + SILPI starter",
      backend: "Node.js (SILPI starter)",
      database: "PostgreSQL",
      devFactor: 0.65,
      // Turn on once the starter kit is built.
      available: false,
      note: "Built from the SILPI starter kit: proven pages, admin and checkout are reused and styled to the brand.",
      tradeoff: "Standard layouts and flows; unusual custom workflows cost extra later.",
    },
  },
  // Sample prices: check your registrar. Renewals are often higher than the first year.
  domains: {
    ".com": { register: 1099, renew: 1299 },
    ".in": { register: 799, renew: 999 },
    ".co.in": { register: 599, renew: 799 },
    ".org": { register: 1199, renew: 1399 },
    ".net": { register: 1299, renew: 1499 },
  },
  // Sample plans: replace provider and prices with what you resell.
  hosting: {
    static: { label: "Free static hosting", provider: "Static site hosting", serverType: "Static CDN", storage: "Up to 500 builds/month", bandwidth: "Generous free tier", setup: 0, price: 0, renew: 0 },
    shared: { label: "Shared hosting", provider: "Shared hosting provider", serverType: "Shared Linux (cPanel)", storage: "50 GB SSD", bandwidth: "Unmetered", setup: 0, price: 3999, renew: 4999 },
    vps: { label: "VPS hosting", provider: "Cloud server provider", serverType: "Virtual private server, 2 vCPU", storage: "80 GB SSD", bandwidth: "4 TB/month", setup: 1500, price: 14999, renew: 14999 },
    cloud: { label: "Managed cloud hosting", provider: "AWS Lightsail / similar", serverType: "Managed cloud, auto backups", storage: "160 GB SSD", bandwidth: "5 TB/month", setup: 2500, price: 24999, renew: 24999 },
  },
  // What one developer can reliably deliver. Each package includes everything in the one below it.
  packages: {
    basic: {
      revisions: 1,
      supportDays: 7,
      extras: ["Mobile-friendly pages", HANDOVER_LABEL],
      handover: HANDOVER_DETAIL,
      documentation: "Basic handover documentation or usage guide",
      security: "Essential security checks and basic testing before launch",
    },
    standard: {
      revisions: 2,
      supportDays: 15,
      extras: ["Mobile-friendly pages", HANDOVER_LABEL],
      handover: HANDOVER_DETAIL,
      documentation: "Documentation plus one client training session",
      security: "Essential security checks, responsive testing and basic performance checks",
    },
    premium: {
      revisions: 3,
      supportDays: 30,
      extras: ["Mobile-friendly pages", HANDOVER_LABEL],
      handover: HANDOVER_DETAIL,
      documentation: "Documentation plus extended client training",
      security: "More comprehensive security and performance review",
      // No reply time is promised until one is set in Business & pricing.
      prioritySupport: { responseHours: null },
    },
  },
};

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
  "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
  /** Clients abroad: export of services, zero-rated GST (needs a filed LUT). */
  "Outside India",
];
