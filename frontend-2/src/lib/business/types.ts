/**
 * Business workflow types: requirement -> quotation -> payments -> delivery.
 * Shared by the server (API routes, database) and the browser (forms, live estimate).
 */

/** Every stage a client project passes through, in order. */
export const STAGES = [
  "requirement",
  "quoted",
  "approved",
  "advance_paid",
  "in_development",
  "testing",
  "demo_ready",
  "final_paid",
  "delivered",
  "lost",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  requirement: "Requirement",
  quoted: "Quoted",
  approved: "Approved",
  advance_paid: "Advance paid",
  in_development: "In development",
  testing: "Testing",
  demo_ready: "Demo ready",
  final_paid: "Fully paid",
  delivered: "Delivered",
  lost: "Lost",
};

export const SCOPES = ["full", "partial", "module", "version"] as const;
export type Scope = (typeof SCOPES)[number];

export const PROJECT_TYPES = ["landing-page", "business-website", "cms-website", "ecommerce", "web-app"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const COMPLEXITIES = ["basic", "standard", "advanced"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const MODULES = [
  "contact-form",
  "auth",
  "admin-panel",
  "blog",
  "payments",
  "booking",
  "search",
  "multilingual",
  "chat",
  "notifications",
  "reports",
  "api-integration",
  "seo-setup",
  "gallery-preview",
  "image-slider",
  "whatsapp",
  "google-maps",
] as const;
export type ModuleId = (typeof MODULES)[number];

/** How the look of the site is produced. */
export const DESIGN_SOURCES = ["ai", "template", "custom"] as const;
export type DesignSource = (typeof DESIGN_SOURCES)[number];

/**
 * How the backend is built. Cheaper stacks reuse more ready-made parts, so
 * they are the main lever when a client negotiates the price.
 */
export const STACKS = ["custom", "managed", "starter"] as const;
export type StackChoice = (typeof STACKS)[number];

/** Technical clients can pick the technology; the estimate updates from these choices. */
export const TECH_LAYERS = ["frontend", "backend", "database"] as const;
export type TechLayer = (typeof TECH_LAYERS)[number];
export type TechOption = { label: string; /** Development hours factor against the default (1 = same). */ factor: number; available: boolean; detail: string };

export const HOSTING_PLANS = ["static", "shared", "vps", "cloud"] as const;
export type HostingPlan = (typeof HOSTING_PLANS)[number];

/**
 * Domain and hosting are third-party services, billed separately from
 * development: the client already has it, arranges it, or asks us to.
 */
export const SERVICE_CHOICES = ["owned", "self", "arrange"] as const;
export type ServiceChoice = (typeof SERVICE_CHOICES)[number];

export type Client = {
  name: string;
  email: string;
  phone: string;
  company: string;
  /** Client GSTIN, printed on the quotation when given (B2B). */
  gstin: string;
  /** Place of supply; decides CGST+SGST (same state) or IGST (other state). */
  state: string;
  address: string;
};

/**
 * main = a real page the client asked for (billed);
 * supporting = a small utility page such as 404 or thank-you (included in the set-up, not billed).
 * Shared components (header, footer, navigation) are never pages.
 */
export const PAGE_KINDS = ["main", "supporting"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Size and short description of one page; drives hour-based pricing. */
export type PageDetail = { sections: number; purpose: string; kind?: PageKind };

/** What the AI separated out of the client's documents; kept with the requirement. */
export type RequirementInsights = {
  /** Stated plainly by the client. */
  confirmed: string[];
  /** Filled in where the document was unclear; confirm with the client. */
  assumptions: string[];
  /** Still unanswered; ask before the final price. */
  questions: string[];
};

/**
 * Technology the client asked for in their own words, kept apart from anything we recommend.
 * `stated`: as written by the client. `ids`: the same, matched to the technology catalog.
 * `confirmedIds`: an alternative the client agreed to because a request could not be used.
 */
export type ClientTech = { stated: string[]; ids: string[]; confirmedIds?: string[] };

/** A stack the team picked from the recommendations (catalog ids). Kept apart from what the client asked for. */
export type SelectedStack = { ids: string[] };

export type Requirement = {
  title: string;
  summary: string;
  scope: Scope;
  /** Existing project name, for module / version work. */
  existingProject: string;
  /** Target version label, e.g. "v2.0", for version work. */
  version: string;
  projectType: ProjectType;
  complexity: Complexity;
  pages: string[];
  /** Sections and purpose per page name; missing pages use the default size. */
  pageDetails?: Record<string, PageDetail>;
  modules: ModuleId[];
  /** Features the client cannot launch without; never removed from the Basic proposal. */
  mustHave?: ModuleId[];
  design: DesignSource;
  /** Reference sites, brand notes, anything else. */
  references: string;
  /** `needed` = SILPI arranges it (separate optional service), same as choice "arrange". */
  domain: { needed: boolean; choice?: ServiceChoice; name: string; tld: string; years: number };
  hosting: { needed: boolean; choice?: ServiceChoice; plan: HostingPlan; years: number };
  deadlineWeeks: number;
  /** Client's maximum budget in ₹ including GST; 0 or missing = not stated. */
  budget?: number;
  /** "Stay within budget": the team offers only the scope the budget can build (extra pages wait in Phase 2). */
  budgetStrict?: boolean;
  /** Technology approach; missing on older records means "custom". */
  stack?: StackChoice;
  /** Package only: requested features this package leaves out (never built, not priced). */
  excludedModules?: ModuleId[];
  /** Technology picked by a technical client (ids from the rate card). Empty = SILPI chooses. */
  tech?: Partial<Record<TechLayer, string>>;
  /** Technology the client explicitly requested (never replaced silently; see ClientTech). */
  clientTech?: ClientTech;
  /** The stack chosen from the recommendations. Used for layers the client did not specify. */
  selectedStack?: SelectedStack;
  /** Premium package only: adds the priced "Premium care" line (speed & security check, priority support). */
  premiumCare?: boolean;
  /** Header, footer, navigation and other shared parts: part of the set-up, never billed as pages. */
  sharedComponents?: string[];
  /** Non-functional needs: responsive, accessibility, speed, browser support. Included, not billed separately. */
  qualityRequirements?: string[];
  /** Third-party services besides domain and hosting (business email, SSL, form service...). Price to be confirmed. */
  externalServices?: string[];
  /** Phase 2 pages: requested pages left for later (e.g. to fit the budget); kept on record, not priced. */
  deferredPages?: string[];
  /** Phase 2: optional features moved out of this quotation; kept on record and can be added back. */
  deferredModules?: ModuleId[];
  /** Search phrases the client's customers would use, e.g. "organic rice Chennai". */
  seoKeywords?: string[];
  insights?: RequirementInsights;
};

export type RateCard = {
  business: {
    name: string;
    gstin: string;
    state: string;
    address: string;
    email: string;
    phone: string;
    /** UPI ID shown to the client for the advance, e.g. silpi@okaxis. */
    upiId?: string;
    /** Bank transfer details shown to the client (account name, number, IFSC). */
    bankDetails?: string;
  };
  /** GST percent applied to every line (services, domain, hosting). */
  gstRate: number;
  advancePercent: number;
  quoteValidityDays: number;
  /** Largest discount (percent of subtotal) the budget fitter may offer. */
  maxDiscountPercent: number;
  /** Price of one development hour (₹). Every development line is hours × this rate. */
  hourlyRate: number;
  /** Productive hours per week, for the delivery estimate. */
  hoursPerWeek: number;
  /** Hours for set-up, testing and deployment, per project type. */
  projectTypes: Record<ProjectType, { label: string; setupHours: number }>;
  /** Hours per page: a fixed part plus each section (hero, gallery, form...). */
  page: { baseHours: number; sectionHours: number; defaultSections: number };
  /** Share of the set-up hours charged for each scope (a module alone pays none). */
  scopeBaseFactor: Record<Scope, number>;
  /** Hours to study an existing codebase before module / version work. */
  existingProjectHours: number;
  /** Hours charged as a separate line on the Premium package: speed & security check, priority support. */
  premiumCareHours: number;
  complexity: Record<Complexity, { label: string; multiplier: number }>;
  modules: Record<ModuleId, { label: string; hours: number; backend: boolean; detail: string }>;
  design: Record<DesignSource, { label: string; hours: number; detail: string }>;
  /** Development hours factor of each technology approach; `available: false` hides it from proposals. */
  /** Frontend, backend and database choices for technical clients; each changes the hours. */
  technology: Record<TechLayer, Record<string, TechOption>>;
  stacks: Record<StackChoice, { label: string; frontend: string; backend: string; database: string; devFactor: number; available: boolean; note: string; tradeoff: string }>;
  /** Domain registration (first year) and yearly renewal price per extension. */
  domains: Record<string, { register: number; renew: number }>;
  /** Hosting plans offered as a separate service. `price` = first year, `renew` = each later year. */
  hosting: Record<HostingPlan, HostingPlanInfo>;
  /** After-sales terms promised with each package. */
  packages: Record<"basic" | "standard" | "premium", PackageTerms>;
};

export type HostingPlanInfo = {
  label: string;
  provider: string;
  serverType: string;
  storage: string;
  bandwidth: string;
  /** One-time set-up charge. */
  setup: number;
  price: number;
  renew: number;
};

export type LineCategory = "development" | "design" | "domain" | "hosting";

/** One separately billed service (domain or hosting). Never part of the development total. */
export type ServiceEstimate = {
  kind: "domain" | "hosting";
  title: string;
  details: { label: string; value: string }[];
  items: { description: string; amount: number }[];
  subtotal: number;
  gst: number;
  total: number;
  /** Yearly renewal after the period paid now (excl. GST). */
  renewal: number;
};

/** What happens to domain and hosting, shown beside the development quotation. */
export type SeparateServices = {
  domain: { choice: ServiceChoice; name: string; estimate?: ServiceEstimate };
  hosting: { choice: ServiceChoice; recommended: HostingPlan; estimate?: ServiceEstimate };
  /** Total of the services SILPI arranges, incl. GST. 0 when none. */
  total: number;
  /** Other third-party services the client needs; billed by the provider, price to be confirmed. */
  others?: string[];
};

export type LineItem = {
  category: LineCategory;
  description: string;
  /** One-line explanation of what the line covers. */
  detail?: string;
  qty: number;
  unit: string;
  rate: number;
  amount: number;
};

export type StackSuggestion = {
  /** Label of the chosen approach, e.g. "Custom code". */
  approach?: string;
  frontend: string;
  backend: string;
  database: string;
  styling: string;
  hosting: HostingPlan;
  notes: string[];
};

export type SeoAdvice = {
  /** Done in every website at no extra cost. */
  included: string[];
  /** Worth doing for this project; some need the SEO module. */
  recommended: string[];
  keywords: string[];
};

export type Quote = {
  items: LineItem[];
  totalHours: number;
  subtotal: number;
  discount: number;
  taxable: number;
  /** intra = CGST+SGST, inter = IGST, export = zero-rated export of services (under LUT). */
  gst: { mode: "intra" | "inter" | "export"; rate: number; cgst: number; sgst: number; igst: number; total: number };
  roundOff: number;
  grandTotal: number;
  schedule: { label: string; percent: number; amount: number }[];
  stack: StackSuggestion;
  estimatedWeeks: number;
  seo: SeoAdvice;
  /** Phase-2 modules left out of this price, with their estimated cost before GST. */
  deferred?: { modules: string[]; amount: number };
  /** Pages billed vs supporting pages included in the set-up. */
  pageCount?: { billable: number; supporting: number };
  /** Domain and hosting: separate optional services, never in the totals above. */
  services?: SeparateServices;
};

/** What a package promises: revisions, free support and what it delivers. */
export type PackageTerms = {
  revisions: number;
  supportDays: number;
  /** Inclusions shown as a tick in the comparison (the same wording in every package that has them). */
  extras: string[];
  /** What the handover covers, shown with the package details. */
  handover?: string;
  /** Documentation and training: the wording differs by package. */
  documentation?: string;
  /** Security and testing before launch: the wording differs by package. */
  security?: string;
  /** Priority support. A reply time is promised only when `responseHours` is set. Absent or null = not included. */
  prioritySupport?: { responseHours: number | null } | null;
};

export const TIERS = ["basic", "standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

/** One of the three proposals, as shown to the client. */
export type ProposalSummary = {
  tier: Tier;
  title: string;
  tagline: string;
  grandTotal: number;
  estimatedWeeks: number;
  pages: string[];
  features: string[];
  /** What this proposal leaves out compared with the full request. */
  leftOut: string[];
  /** Revisions, support and extras for this package. */
  terms?: PackageTerms;
  /** Supporting pages (404...) included in the set-up, not counted as pages. */
  supportingPages?: string[];
  /** Whether it fits the client's budget (when one is stated). */
  fitsBudget?: boolean;
  /** Basic only, when it cannot fit: what would make it fit. */
  budgetNote?: string;
};

/** One line of the package comparison: ✓ / ✗ (boolean) or a value per package. */
export type ComparisonRow = { label: string; values: Record<Tier, string | boolean> };

export type Quotation = Quote & {
  id: string;
  number: string;
  leadId: string;
  createdAt: string;
  validUntil: string;
  business: RateCard["business"];
  client: Client;
  /** Scope priced in this quotation (the chosen proposal). */
  requirement?: Requirement;
  tier?: Tier;
  /** All three proposals, so the client can compare and choose. */
  proposals?: ProposalSummary[];
  /** Feature-by-feature comparison of the three proposals. */
  comparison?: ComparisonRow[];
  /** Team only: how the chosen package compares with the client's budget. */
  budgetCheck?: BudgetCheck;
};

export type BudgetStatus = "none" | "within" | "near" | "over" | "scope-adjustment";

/** The client's budget is a limit to compare against, never a price to force. */
export type BudgetCheck = {
  status: BudgetStatus;
  budget: number;
  total: number;
  /** budget - total: positive = remaining, negative = over. */
  difference: number;
  /** What the price is made of, largest first. */
  contributors: { label: string; amount: number; share: number }[];
  /** Optional (not must-have) features that could move to Phase 2, largest saving first; saving incl. GST. */
  suggestions: { module: ModuleId; label: string; saving: number }[];
  /** Total if the suggested features move to Phase 2 (only as many as needed to fit). */
  totalAfterSuggestions?: number;
  /** The most complete package that fits the budget, when this one does not. */
  fittingTier?: { tier: Tier; title: string; total: number };
  /** When the requested pages do not fit: what the budget can build instead. */
  pagePlan?: PagePlan;
  /** Cheaper design choices than the current one, with the saving incl. GST. */
  designOptions?: { design: DesignSource; label: string; saving: number }[];
  /** Cheapest package above the budget and how much more budget it needs (for talking to the client). */
  askMore?: { title: string; total: number; extra: number };
};

/** "With your budget we can build these pages (and the contact form)". */
export type PagePlan = {
  /** Pages the budget covers, from compact pages (most) to the requested page size (fewest). */
  minPages: number;
  maxPages: number;
  /** Suggested: the Basic package with these pages, most important first. */
  pages: string[];
  /** Compact page sizes (sections per page) when Basic-size pages do not fit. */
  sections?: Record<string, number>;
  /** Whether the contact form fits as well. */
  contactForm: boolean;
  /** Total incl. GST of the suggestion; never above the budget. */
  total: number;
  /** Requested pages left for Phase 2. */
  phase2Pages: string[];
  /** Lowest possible price (set-up + Home page) when even that does not fit. */
  minimumTotal: number;
};

/** What the AI read from the client's documents (mirrors silpi-agent/src/analyze.ts). */
export type RequirementDraft = {
  client: { name: string; email: string; phone: string; company: string; state: string };
  title: string;
  summary: string;
  scope: Scope;
  existingProject: string;
  projectType: ProjectType;
  complexity: Complexity;
  pages: { name: string; sections: number; purpose: string }[];
  /** 404, thank-you and similar pages (not billed). Missing on older agent versions. */
  supportingPages?: string[];
  sharedComponents?: string[];
  qualityRequirements?: string[];
  externalServices?: string[];
  modules: ModuleId[];
  mustHave: ModuleId[];
  design: DesignSource;
  references: string;
  domainName: string;
  needsDomain: boolean;
  needsHosting: boolean;
  deadlineWeeks: number;
  clientBudget: number;
  seoKeywords: string[];
  /** Technologies the client explicitly named (e.g. HTML, CSS, JavaScript). Missing on older agent versions. */
  technologyPreference?: string[];
  confirmed: string[];
  missingInfo: string[];
  assumptions: string[];
};

export const PAYMENT_KINDS = ["advance", "balance"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_MODES = ["upi", "bank", "cash", "cheque", "card"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** A payment received outside the site (until the payment gateway is added). */
export type Payment = {
  id: string;
  kind: PaymentKind;
  amount: number;
  mode: PaymentMode;
  reference: string;
  receivedOn: string;
  recordedAt: string;
};

/** The client's answer from the shared quotation link. */
export type ClientResponse = {
  action: "approved" | "changes_requested";
  tier?: Tier;
  name: string;
  message: string;
  at: string;
};

/** Time actually spent on a project, logged by the owner (the basis of their own price history). */
export type WorkEntry = { id: string; item: string; hours: number; note: string; loggedOn: string; recordedAt: string };

export type Lead = {
  id: string;
  stage: Stage;
  client: Client;
  requirement: Requirement;
  createdAt: string;
  updatedAt: string;
  /** Latest quotation, when one exists. */
  quotation?: Quotation;
  /** Secret for the client's approval link; created on first share. */
  shareToken?: string;
  /** Latest answer from the client through the link. */
  clientResponse?: ClientResponse;
  payments: Payment[];
  workLog: WorkEntry[];
  /** Folder name of the generated project once development has started. */
  projectName?: string;
};
