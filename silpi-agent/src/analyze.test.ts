import type Anthropic from "@anthropic-ai/sdk";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { AnalyzeInputSchema, analyzeRequirement, applyDraftGuards, type RequirementDraft } from "./analyze.js";

const draft: RequirementDraft = {
  client: { name: "Ravi", email: "", phone: "", company: "Murugan Tex", state: "Tamil Nadu" },
  title: "Murugan Tex store",
  summary: "Online store for sarees with UPI payments.",
  scope: "full",
  existingProject: "",
  projectType: "ecommerce",
  complexity: "standard",
  pages: [
    { name: "Home", sections: 5, purpose: "Hero, offers, categories" },
    { name: "Products", sections: 3, purpose: "Saree listing with filters" },
  ],
  supportingPages: ["404 Not Found"],
  sharedComponents: ["Header", "Footer"],
  qualityRequirements: ["Responsive on mobile, tablet and desktop"],
  externalServices: [],
  modules: ["payments", "auth"],
  mustHave: ["payments"],
  design: "ai",
  references: "",
  domainName: "murugantex",
  needsDomain: true,
  needsHosting: true,
  deadlineWeeks: 0,
  clientBudget: 0,
  seoKeywords: ["silk sarees Madurai"],
  technologyPreference: [],
  confirmed: ["UPI payments"],
  missingInfo: ["How many products at launch?"],
  assumptions: [],
};

/** Records the request and returns a canned response; no network, no cost. */
function fakeClient(response: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 20_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          parsed_output: draft,
          ...response,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

/** Minimal valid .docx (a zip with stored, uncompressed entries) holding the given text. */
function makeDocx(text: string): string {
  const files: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBuf, end]).toString("base64");
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const pdf = { name: "brief.pdf", mediaType: "application/pdf" as const, data: Buffer.from("%PDF-1.7").toString("base64") };

describe("analyzeRequirement", () => {
  it("returns the draft and the cost of the call", async () => {
    const { client, calls } = fakeClient({});
    const result = await analyzeRequirement(AnalyzeInputSchema.parse({ attachments: [pdf], notes: "Client wants Tamil too" }), client);
    expect(result).toMatchObject({ success: true, draft: { projectType: "ecommerce" }, model: "claude-haiku-5-5" });
    // 20K in * $0.10/M + 1K out * $0.50/M = $0.0025
    expect(result.success && result.costUsd).toBeCloseTo(0.0025, 6);
    const content = (calls[0]!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content;
    expect(content[0]!.type).toBe("document");
    expect(content.at(-1)!.text).toContain("Client wants Tamil too");
  });

  it("reports refusals and truncation instead of a broken draft", async () => {
    const refused = await analyzeRequirement(AnalyzeInputSchema.parse({ attachments: [pdf] }), fakeClient({ stop_reason: "refusal", parsed_output: null }).client);
    expect(refused).toMatchObject({ success: false });
    const cut = await analyzeRequirement(AnalyzeInputSchema.parse({ attachments: [pdf] }), fakeClient({ stop_reason: "max_tokens" }).client);
    expect(cut).toMatchObject({ success: false });
  });

  it("does not call the API with nothing to read", async () => {
    const { client, calls } = fakeClient({});
    expect(await analyzeRequirement(AnalyzeInputSchema.parse({}), client)).toMatchObject({ success: false });
    expect(calls).toHaveLength(0);
  });

  it("sends a Word document as plain text", async () => {
    const { client, calls } = fakeClient({});
    const docx = { name: "brief.docx", mediaType: DOCX_TYPE, data: makeDocx("Online saree shop with UPI payments") };
    const result = await analyzeRequirement(AnalyzeInputSchema.parse({ attachments: [docx] }), client);
    expect(result.success).toBe(true);
    const block = (calls[0]!.messages as Array<{ content: Array<{ type: string; source?: { type: string; data: string } }> }>)[0]!.content[0]!;
    expect(block).toMatchObject({ type: "document", source: { type: "text", data: "Online saree shop with UPI payments" } });
  });

  it("reports a broken Word file without calling the API", async () => {
    const { client, calls } = fakeClient({});
    const broken = { name: "broken.docx", mediaType: DOCX_TYPE, data: Buffer.from("not a zip").toString("base64") };
    expect(await analyzeRequirement(AnalyzeInputSchema.parse({ attachments: [broken] }), client)).toMatchObject({ success: false, error: expect.stringContaining("broken.docx") });
    expect(calls).toHaveLength(0);
  });

  it("rejects file types it cannot read, such as old .doc files", () => {
    const doc = { name: "brief.doc", mediaType: "application/msword", data: "AA==" };
    expect(AnalyzeInputSchema.safeParse({ attachments: [doc] }).success).toBe(false);
  });
});

describe("technology preference and demo forms", () => {
  const staticSite: RequirementDraft = {
    ...draft,
    title: "BrightWave Solutions website",
    summary: "Four page HTML website. The contact page has a demo form that does not send or store messages.",
    projectType: "business-website",
    complexity: "basic",
    pages: [
      { name: "Home", sections: 4, purpose: "Hero and highlights" },
      { name: "Contact Us", sections: 3, purpose: "Contact details and a demo form that does not send or store messages" },
    ],
    modules: ["contact-form"],
    mustHave: ["contact-form"],
    technologyPreference: ["HTML", "CSS", "JavaScript"],
    confirmed: ["Built with HTML, CSS and vanilla JavaScript only", "Contact page includes a demo form that does not send or store messages"],
    missingInfo: [],
    assumptions: [],
  };

  it("keeps the technology the client stated, as stated", async () => {
    const { client } = fakeClient({ parsed_output: staticSite });
    const result = await analyzeRequirement(AnalyzeInputSchema.parse({ notes: "x" }), client);
    expect(result.success && result.draft.technologyPreference).toEqual(["HTML", "CSS", "JavaScript"]);
  });

  it("does not price a demo form as the working contact form", async () => {
    const { client } = fakeClient({ parsed_output: staticSite });
    const result = await analyzeRequirement(AnalyzeInputSchema.parse({ notes: "x" }), client);
    if (!result.success) throw new Error("expected success");
    expect(result.draft.modules).not.toContain("contact-form");
    expect(result.draft.mustHave).not.toContain("contact-form");
    expect(result.draft.assumptions.join(" ")).toContain("non-working demo");
    expect(result.draft.missingInfo.join(" ")).toMatch(/deliver messages/);
  });

  it("leaves a working contact form alone", () => {
    const working: RequirementDraft = { ...staticSite, summary: "Contact page with an enquiry form that emails the owner.", confirmed: ["Enquiry form emails the owner"], pages: [{ name: "Contact Us", sections: 3, purpose: "Form and map" }] };
    expect(applyDraftGuards(working)).toBe(working);
  });

  it("recognises the usual ways a demo form is described", () => {
    for (const line of ["The form is only a demo", "A dummy contact form is enough", "Placeholder form, no real submission needed to work", "The contact form will not send any message", "Form does not store submissions"]) {
      const guarded = applyDraftGuards({ ...staticSite, summary: line, confirmed: [], pages: [{ name: "Contact Us", sections: 2, purpose: "" }] });
      expect(guarded.modules, line).not.toContain("contact-form");
    }
  });

  it("is safe to run twice and never changes the draft it was given", () => {
    const before = JSON.stringify(staticSite);
    const once = applyDraftGuards(staticSite);
    const twice = applyDraftGuards(once);
    expect(JSON.stringify(staticSite)).toBe(before);
    expect(twice.assumptions).toEqual(once.assumptions);
    expect(twice.missingInfo).toEqual(once.missingInfo);
  });
});
