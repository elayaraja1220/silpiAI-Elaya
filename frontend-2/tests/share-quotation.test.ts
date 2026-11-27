// Sending a quotation to a client's WhatsApp number or e-mail: the number is made ready for WhatsApp, the links carry the message, and the client's pages offer them.
// Run: npm test
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mailtoLink, quotationMessage, whatsappLink, whatsappNumber } from "@/lib/share-quotation";

describe("WhatsApp and e-mail links", () => {
  it("makes a phone number ready for WhatsApp: digits only, country code kept, a 10-digit number taken as Indian", () => {
    assert.equal(whatsappNumber("+91 98765 43210"), "919876543210");
    assert.equal(whatsappNumber("098765 43210"), "919876543210");
    assert.equal(whatsappNumber("9876543210"), "919876543210");
    assert.equal(whatsappNumber("+1 647 504 3528"), "16475043528");
    assert.equal(whatsappNumber(""), "");
  });
  it("opens the client's chat with the message ready, or lets the person pick a contact when there is no usable number", () => {
    const msg = "Hello Priya,\n\nView it here: https://x.example/q/abc?x=1&y=2";
    const link = whatsappLink("+91 98765 43210", msg);
    assert.ok(link.startsWith("https://wa.me/919876543210?text="));
    assert.equal(decodeURIComponent(link.split("?text=")[1]!), msg, "the message survives intact, including line breaks and &");
    assert.ok(whatsappLink("", msg).startsWith("https://wa.me/?text="), "no number: choose a contact");
    assert.ok(whatsappLink("12", msg).startsWith("https://wa.me/?text="), "a number too short to be real is not used");
  });
  it("opens the client's e-mail with the subject and message ready", () => {
    const link = mailtoLink(" priya@e2e.test ", "Quotation SQ-1 & more", "Line one\n\nLine two");
    assert.ok(link.startsWith("mailto:priya@e2e.test?subject="));
    const [, subject, body] = /subject=([^&]*)&body=(.*)$/.exec(link)!;
    assert.equal(decodeURIComponent(subject!), "Quotation SQ-1 & more");
    assert.equal(decodeURIComponent(body!), "Line one\n\nLine two");
  });
  it("words the message with the number, the title, the business, the link and the date it is valid until", () => {
    const m = quotationMessage({ name: "Priya", number: "SQ-2026-0009", title: "Priya website", business: "SILPI AI Development Studio", link: "https://x.example/q/tok", validUntil: "2026-12-11T00:00:00.000Z" });
    for (const part of ["Hello Priya,", "SQ-2026-0009", "Priya website", "SILPI AI Development Studio", "https://x.example/q/tok", "2026"]) assert.ok(m.includes(part), part);
  });
});

describe("the client's quotation pages", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("the main page leads to the quotation on its own page instead of showing it at the bottom, and offers PDF only", () => {
    const page = read("src/app/q/[token]/client-quotation.tsx");
    assert.ok(!page.includes("<QuotationDocument"), "the document is no longer on this page");
    assert.ok(page.includes("/quotation`") && page.includes("Show quotation"), "a Show quotation button leads to the next page");
    assert.ok(page.includes("format=pdf") && !page.includes("format=docx") && !/>\s*Word\s*</.test(page), "PDF at the top, no Word");
  });
  it("the next page shows the quotation with PDF, print, and WhatsApp and e-mail to the client's own number and address", () => {
    const f = "src/app/q/[token]/quotation/client-quotation-document.tsx";
    assert.ok(existsSync(f) && existsSync("src/app/q/[token]/quotation/page.tsx"));
    const t = read(f);
    assert.ok(t.includes("<QuotationDocument") && t.includes("format=pdf") && !t.includes("format=docx"));
    assert.ok(t.includes("whatsappLink(") && t.includes("mailtoLink(") && t.includes("window.print()"));
  });
  it("the studio's send-to-client buttons use the same helpers", () => {
    const t = read("src/components/business/proposals-panel.tsx");
    assert.ok(t.includes('from "@/lib/share-quotation"') && !t.includes("function whatsappNumber"));
  });
});
