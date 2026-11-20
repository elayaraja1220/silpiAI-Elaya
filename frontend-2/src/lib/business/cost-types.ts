import type { Level, Scale } from "./tech-catalog";

/**
 * Cost estimation types (step 3).
 *
 * Three costs that are never added together:
 * 1. Client development cost: what the quotation charges (existing pricing engine).
 * 2. Internal delivery cost: what it costs the studio to deliver (people, AI/API, infrastructure).
 * 3. Client running costs: domain, hosting, subscriptions, maintenance (separate bills).
 *
 * Amounts are in rupees (INR) unless a name ends in `Usd`. A rate that has not been
 * configured is `null` or absent and is reported as missing; no value is ever invented.
 */

// ---- Roles and the kinds of work a quotation is made of -------------------------

export const ROLES = ["frontend", "backend", "uiux", "qa", "pm", "deployment"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  frontend: "Frontend development",
  backend: "Backend development",
  uiux: "UI/UX design",
  qa: "Testing and QA",
  pm: "Project management",
  deployment: "Deployment and documentation",
};

/** What a quotation line is, found from the line itself so older quotations work too. */
export const LINE_KINDS = ["setup", "page", "feature-frontend", "feature-backend", "design", "premium-care", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];
export const LINE_KIND_LABELS: Record<LineKind, string> = {
  setup: "Set-up, testing and deployment",
  page: "Pages",
  "feature-frontend": "Features without a server",
  "feature-backend": "Features with a server",
  design: "Design",
  "premium-care": "Premium care",
  other: "Other work",
};

export const SECURITY_LEVELS = ["standard", "elevated", "high"] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];

/** actual: reported by the provider or measured. estimated: calculated or assumed. missing: cannot be known yet. */
export type CostStatus = "actual" | "estimated" | "missing";

// ---- Configuration (saved in settings; empty until the studio fills it in) ------

/** Percent of a line's hours given to each role. May total over 100 when extra effort is needed. */
export type Allocation = Partial<Record<Role, number>>;

/** USD per million tokens, as charged by the provider (entered by the studio, never built in). */
export type AiModelPrice = { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };

export const INFRA_BASES = ["per-project", "per-dev-hour", "per-week"] as const;
export type InfraBasis = (typeof INFRA_BASES)[number];
/** A studio-side resource: development server, build and test infrastructure, storage. */
export type InfraRate = { key: string; name: string; basis: InfraBasis; amount: number | null };

/** The studio's reference for a kind of running cost. The amount may stay unknown. Always in rupees. */
export type RunningCostDefault = {
  provider?: string;
  kind: "one-time" | "recurring";
  amount: number | null;
  amountType?: "fixed" | "percent-of-transaction";
  frequency?: Frequency;
  necessity: "mandatory" | "optional";
  payer: "client" | "studio";
  status: "actual" | "estimated";
  note?: string;
};

export type CostConfig = {
  /** Internal cost per hour for each role. Not the client billing rate. */
  roleRates: Record<Role, number | null>;
  /** How each kind of quotation line is shared between roles. null = not configured. */
  allocation: Record<LineKind, Allocation | null>;
  /** Internal effort multiplier per technology id (1 = no change), on top of the hours already quoted. */
  techFactors: Record<string, number>;
  /** Percent added to human cost for larger scale or higher security. Standard / small need none. */
  uplifts: { scale: Partial<Record<Scale, number>>; security: Partial<Record<SecurityLevel, number>> };
  usdToInr: number | null;
  /** Other currencies to INR. */
  fxRates: Record<string, number>;
  aiPricing: Record<string, AiModelPrice>;
  /** null = never configured; [] = configured as "none". */
  infra: InfraRate[] | null;
  minMarginPercent: number | null;
  /** Reference prices for the running costs suggested on a quotation, by kind of cost. Empty = every amount unknown. */
  runningCosts: Partial<Record<RecurringCategory, RunningCostDefault>>;
};

/** A change to the configuration. null removes a value; absent leaves it alone. */
export type CostConfigPatch = {
  roleRates?: Partial<Record<Role, number | null>>;
  allocation?: Partial<Record<LineKind, Allocation | null>>;
  techFactors?: Record<string, number | null>;
  uplifts?: { scale?: Partial<Record<Scale, number | null>>; security?: Partial<Record<SecurityLevel, number | null>> };
  usdToInr?: number | null;
  fxRates?: Record<string, number | null>;
  aiPricing?: Record<string, AiModelPrice | null>;
  infra?: InfraRate[] | null;
  minMarginPercent?: number | null;
  runningCosts?: Partial<Record<RecurringCategory, RunningCostDefault | null>>;
};

// ---- Inputs ------------------------------------------------------------------------

/** One AI call or run. A provider-reported cost wins; otherwise tokens are priced from the configuration. */
export type AiUsageRecord = {
  /** Used to count each record once. */
  id?: string;
  provider: string;
  model: string;
  purpose?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost reported by the provider in US dollars. */
  actualCostUsd?: number;
};

export const RECURRING_CATEGORIES = [
  "domain-renewal", "shared-hosting", "vps", "cloud-hosting", "managed-database", "paid-api", "email-service",
  "storage-cdn", "payment-gateway", "maintenance-support", "other",
] as const;
export type RecurringCategory = (typeof RECURRING_CATEGORIES)[number];

export const FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** A running or third-party cost. Never part of the development quotation. */
export type RecurringCostItem = {
  id: string;
  service: string;
  category: RecurringCategory;
  provider?: string;
  kind: "one-time" | "recurring";
  /** null = unknown (stays unknown, never guessed). For "percent-of-transaction" this is the percentage. */
  amount: number | null;
  amountType?: "fixed" | "percent-of-transaction";
  /** Required when recurring. */
  frequency?: Frequency;
  currency: string;
  necessity: "mandatory" | "optional";
  payer: "client" | "studio";
  status: "actual" | "estimated";
  /** Names where this cost is already counted (for example an infra key), so it is not counted twice. */
  countedIn?: string;
  /** Studio-paid one-time cost that is part of delivering this project (counts as internal cost). */
  includeInDeliveryCost?: boolean;
  note?: string;
};

// ---- Results -------------------------------------------------------------------------

export type ClientDevelopmentCost = {
  hours: number;
  subtotal: number;
  discount: number;
  /** Development revenue excluding GST. */
  taxable: number;
  gstMode: "intra" | "inter" | "export";
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  gstTotal: number;
  roundOff: number;
  /** What the client pays for development, including GST. */
  total: number;
  note: string;
};

export type RoleCost = { role: Role; baseHours: number; factor: number; hours: number; rate: number | null; cost: number | null };

export type HumanCost = {
  quotedHours: number;
  roles: RoleCost[];
  /** Hours of lines that no allocation covers. */
  unallocatedHours: number;
  /** Percent added for scale and security, with what it came to. */
  uplift: { scalePercent: number; securityPercent: number; amount: number };
  /** Estimated: from the quoted hours. "actual-hours": the work log's hours at the estimated role mix. */
  basis: "estimate" | "actual-hours";
  actualHours?: number;
  /** Null while a needed rate or allocation is missing. */
  cost: number | null;
  /** The part of the cost that could be worked out even when some is missing. */
  knownCost: number;
};

export type AiCostRecord = { id?: string; provider: string; model: string; purpose?: string; status: CostStatus; costUsd?: number; costInr?: number; note: string };
export type AiCost = {
  provided: boolean;
  records: AiCostRecord[];
  totalUsd: number;
  /** Null when the exchange rate is not configured. */
  totalInr: number | null;
  actualUsd: number;
  estimatedUsd: number;
};

export type InfraCostItem = { key: string; name: string; basis: InfraBasis; amount?: number; status: CostStatus };
export type InfraCost = { configured: boolean; items: InfraCostItem[]; total: number };

export type InternalCost = {
  human: HumanCost;
  ai: AiCost;
  infrastructure: InfraCost;
  /** Studio-paid one-time costs flagged as part of delivering this project. */
  studioProjectCosts: { items: { id: string; service: string; amount: number }[]; total: number };
  /** Everything that could be worked out. Understated while `complete` is false. */
  total: number;
  complete: boolean;
  /** Split of `total`: actual (provider-reported AI cost, actual hours) and estimated. */
  byStatus: { actual: number; estimated: number };
  missing: string[];
  assumptions: string[];
};

export type RecurringTotals = {
  oneTime: number;
  monthly: number;
  quarterly: number;
  annual: number;
  /** Recurring charges per year (12 monthly + 4 quarterly + 1 annual payments). One-time costs are not in it. */
  yearlyEquivalent: number;
};
export type RecurringItemResult = RecurringCostItem & {
  counted: boolean;
  /** Why it was left out of the totals, when it was. */
  reason?: string;
  amountInr?: number;
  yearlyInr?: number;
};
export type RecurringCost = {
  provided: boolean;
  items: RecurringItemResult[];
  byPayer: Record<"client" | "studio", { mandatory: RecurringTotals; optional: RecurringTotals; all: RecurringTotals }>;
  /** Ids whose amount is unknown. */
  unknown: string[];
  /** Percentage-of-transaction charges: variable, not totalled. */
  variable: string[];
  /** Ids in a currency without a configured exchange rate. */
  unconverted: string[];
  notes: string[];
};

export type ProfitAndMargin = {
  /** Development revenue excluding GST (the taxable value). */
  revenue: number;
  internalCost: number;
  grossProfit: number;
  /** Null when there is no revenue. */
  grossMarginPercent: number | null;
  minMarginPercent: number | null;
  /** False while internal cost is incomplete: the profit is then overstated. */
  provisional: boolean;
};

export type BudgetState = "none" | "within" | "near" | "over";
export type ClientBudgetAnalysis = { budget: number; quote: number; difference: number; shortfall: number; status: BudgetState };
export type InternalBudgetAnalysis = { budget: number; estimatedCost: number; difference: number; shortfall: number; status: BudgetState };
export type Viability = "viable" | "at-risk" | "not-viable" | "unknown";
export type BudgetViability = {
  client: ClientBudgetAnalysis;
  internal: InternalBudgetAnalysis;
  viability: Viability;
  reasons: string[];
};

export type TechnologyContext = {
  stackIds: string[];
  source: "given" | "selected" | "recommendation" | "client" | "none";
  scale: Scale;
  security: SecurityLevel;
  maintenance?: Level;
};

export type CostEstimate = {
  clientDevelopment: ClientDevelopmentCost;
  internal: InternalCost;
  recurring: RecurringCost;
  profit: ProfitAndMargin;
  budget: BudgetViability;
  technology: TechnologyContext;
  warnings: string[];
  /** Always true: the three costs above are never summed. */
  separate: true;
};
