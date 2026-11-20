// Client assets: the originals collected after approval. Checked on the real route handlers and the real store:
// the checklist follows the approved scope, only approved clients can upload, bad files are refused, files
// never leave their own lead, and the team's confirmation is respected.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "silpi-assets-"));
process.env.SILPI_DB_PATH = path.join(root, "test.db");
process.env.SILPI_ASSETS_DIR = path.join(root, "files");

import { NextRequest } from "next/server";

import { buildChecklist, safeFileName, assetProgress } from "@/lib/business/assets";
import type { Requirement } from "@/lib/business/types";

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
});

const requirement = (over: Partial<Requirement> = {}): Requirement => ({
  title: "BrightWave site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
  pages: ["Home", "About Us", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...over,
});

const mods = async () => ({
  store: await import("@/lib/business/store"),
  validate: await import("@/lib/business/validate"),
  assets: await import("@/lib/business/asset-store"),
  clientRoute: await import("@/app/api/client/[token]/assets/route"),
  adminRoute: await import("@/app/api/business/leads/[id]/assets/route"),
  fileRoute: await import("@/app/api/business/leads/[id]/assets/files/[fileId]/route"),
});
async function newLead(over: Partial<Requirement> = {}) {
  const { store, validate } = await mods();
  const client = { name: "Test Client", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const lead = store.createLead(client, validate.parseRequirement(requirement(over), store.getRateCard()), "standard");
  return { id: lead.id, token: store.shareToken(lead.id) };
}
const get = (url: string) => new NextRequest(`http://localhost:3000${url}`, { headers: { host: "localhost:3000" } });
const del = (url: string) => new NextRequest(`http://localhost:3000${url}`, { method: "DELETE", headers: { host: "localhost:3000" } });
const json = (url: string, body: unknown, method = "POST") =>
  new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
function upload(url: string, assetId: string, files: { name: string; data: string | Uint8Array }[]) {
  const form = new FormData();
  form.append("assetId", assetId);
  for (const f of files) form.append("files", new File([f.data as BlobPart], f.name));
  return new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { host: "localhost:3000" }, body: form });
}
type Asset = { id: string; key: string; status: string; required: boolean; files: { id: string; name: string }[]; text: string; note: string };
const body = async (res: Response) => (await res.json()) as { success: boolean; error?: string; available?: boolean; assets?: Asset[] };

describe("the checklist follows the approved scope", () => {
  it("always asks for logo, mobile logo, favicon, business details and one content item per billed page", () => {
    const keys = buildChecklist(requirement()).map((i) => i.key);
    for (const k of ["logo", "logo-mobile", "favicon", "business-details", "page:home", "page:about-us", "page:contact-us"]) assert.ok(keys.includes(k), `missing ${k}`);
    assert.ok(!keys.includes("gallery-images") && !keys.includes("product-images"), "no gallery or product items when the site has none");
  });
  it("adds gallery, slider and product images only when the site has them", () => {
    const keys = buildChecklist(requirement({ pages: ["Home", "Gallery", "Products"], modules: ["image-slider"] })).map((i) => i.key);
    for (const k of ["gallery-images", "slider-images", "product-images"]) assert.ok(keys.includes(k), `missing ${k}`);
    assert.ok(buildChecklist(requirement({ projectType: "ecommerce" })).some((i) => i.key === "product-images"));
  });
  it("file names are made safe", () => {
    assert.equal(safeFileName("..\\..\\evil/../logo final.png"), "logo final.png");
    assert.equal(safeFileName("...."), "file");
    assert.equal(safeFileName("a<b>c?.png"), "abc.png");
  });
});

describe("collecting the originals", () => {
  it("nothing opens before the client approves", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    const res = await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), { params: Promise.resolve({ token }) }));
    assert.equal(res.success && res.available, false);
    assert.deepEqual(res.assets, []);
    const post = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, "x", [{ name: "a.png", data: "x" }]), { params: Promise.resolve({ token }) }));
    assert.equal(post.success, false);
    assert.match(post.error ?? "", /after you approve/);
    assert.equal((await body(await m.adminRoute.GET(get(`/api/business/leads/${id}/assets`), { params: Promise.resolve({ id }) }))).available, false);
  });

  it("after approval the client uploads, types content, and the team confirms or asks again", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const adminCtx = { params: Promise.resolve({ id }) };

    const first = await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx));
    assert.equal(first.available, true);
    const logo = first.assets!.find((a) => a.key === "logo")!;
    const home = first.assets!.find((a) => a.key === "page:home")!;
    assert.equal(logo.status, "pending");

    // The client uploads a logo: it becomes "submitted".
    const up = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, logo.id, [{ name: "My Logo.png", data: "PNGDATA" }]), ctx));
    assert.equal(up.success, true, up.error);
    const sent = up.assets!.find((a) => a.key === "logo")!;
    assert.equal(sent.status, "submitted");
    assert.equal(sent.files.length, 1);
    assert.equal(sent.files[0].name, "My Logo.png");

    // Typed page content goes on the page item; a files-only item refuses text.
    const txt = await body(await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: home.id, text: "Welcome to BrightWave" }), ctx));
    assert.equal(txt.assets!.find((a) => a.key === "page:home")!.status, "submitted");
    const bad = await body(await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: logo.id, text: "hi" }), ctx));
    assert.match(bad.error ?? "", /takes files/);

    // The team sees the file, downloads it as an attachment, never inline for a non-image.
    const file = await m.fileRoute.GET(get(`/api/business/leads/${id}/assets/files/${sent.files[0].id}`), { params: Promise.resolve({ id, fileId: sent.files[0].id }) });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "PNGDATA");
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");

    // Asking again needs a reason; then the client sees it. Confirming locks the item for the client.
    const noNote = await body(await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: logo.id, status: "redo" }, "PATCH"), adminCtx));
    assert.match(noNote.error ?? "", /what to send again/i);
    const redo = await body(await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: logo.id, status: "redo", note: "Please send a transparent PNG" }, "PATCH"), adminCtx));
    assert.equal(redo.assets!.find((a) => a.key === "logo")!.status, "redo");
    const again = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, logo.id, [{ name: "logo2.png", data: "NEW" }]), ctx));
    assert.equal(again.assets!.find((a) => a.key === "logo")!.status, "submitted");

    await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: logo.id, status: "received" }, "PATCH"), adminCtx);
    const locked = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, logo.id, [{ name: "x.png", data: "Z" }]), ctx));
    assert.equal(locked.success, false);
    assert.match(locked.error ?? "", /already received/);
    const cantRemove = await body(await m.clientRoute.DELETE(del(`/api/client/${token}/assets?fileId=${sent.files[0].id}`), ctx));
    assert.equal(cantRemove.success, false);

    const progress = assetProgress((await body(await m.adminRoute.GET(get(`/api/business/leads/${id}/assets`), adminCtx))).assets as unknown as { status: "pending" }[]);
    assert.equal(progress.received, 1);
  });

  it("refuses bad files: wrong type, empty, too big, too many; nothing is half-saved", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const items = (await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx))).assets!;
    const gallery = items.find((a) => a.key === "logo")!;
    const attempt = async (files: { name: string; data: string | Uint8Array }[]) => body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, gallery.id, files), ctx));

    assert.match((await attempt([{ name: "virus.exe", data: "MZ" }])).error ?? "", /not an accepted file type/);
    assert.match((await attempt([{ name: "page.html", data: "<script>" }])).error ?? "", /not an accepted file type/);
    assert.match((await attempt([{ name: "empty.png", data: "" }])).error ?? "", /empty/);
    assert.match((await attempt([{ name: "huge.png", data: new Uint8Array(15 * 1024 * 1024 + 1) }])).error ?? "", /larger than 15 MB/);
    assert.match((await attempt([{ name: "ok.png", data: "1" }, { name: "bad.exe", data: "2" }])).error ?? "", /not an accepted file type/);
    const after = (await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx))).assets!.find((a) => a.key === "logo")!;
    assert.equal(after.files.length, 0, "a refused upload saves nothing");
    assert.equal(after.status, "pending");
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `p${i}.png`, data: "x" }));
    assert.match((await attempt(many)).error ?? "", /At most 30/);
  });

  it("files never cross between leads, and a lead's files are removed with it", async () => {
    const m = await mods();
    const a = await newLead();
    const b = await newLead();
    for (const x of [a, b]) m.store.setStage(x.id, "approved", "test");
    const ctxA = { params: Promise.resolve({ token: a.token }) };
    const ctxB = { params: Promise.resolve({ token: b.token }) };
    const logoA = (await body(await m.clientRoute.GET(get(`/api/client/${a.token}/assets`), ctxA))).assets!.find((x) => x.key === "logo")!;
    const logoB = (await body(await m.clientRoute.GET(get(`/api/client/${b.token}/assets`), ctxB))).assets!.find((x) => x.key === "logo")!;
    const sentA = (await body(await m.clientRoute.POST(upload(`/api/client/${a.token}/assets`, logoA.id, [{ name: "a.png", data: "A" }]), ctxA))).assets!.find((x) => x.key === "logo")!;

    // Client B cannot write to A's item, nor delete A's file, nor download it through B's lead.
    const cross = await body(await m.clientRoute.POST(upload(`/api/client/${b.token}/assets`, logoA.id, [{ name: "b.png", data: "B" }]), ctxB));
    assert.equal(cross.success, false);
    const crossDel = await body(await m.clientRoute.DELETE(del(`/api/client/${b.token}/assets?fileId=${sentA.files[0].id}`), ctxB));
    assert.equal(crossDel.success, false);
    const crossGet = await m.fileRoute.GET(get(`/api/business/leads/${b.id}/assets/files/${sentA.files[0].id}`), { params: Promise.resolve({ id: b.id, fileId: sentA.files[0].id }) });
    assert.equal(crossGet.status, 400);
    assert.notEqual(logoA.id, logoB.id);

    // A bad token gets nothing, and a path-like file id is refused.
    assert.equal((await m.clientRoute.GET(get("/api/client/nope/assets"), { params: Promise.resolve({ token: "nope" }) })).status, 404);
    const traversal = await m.fileRoute.GET(get(`/api/business/leads/${a.id}/assets/files/..%2F..%2Fsilpi.db`), { params: Promise.resolve({ id: a.id, fileId: "../../silpi.db" }) });
    assert.equal(traversal.status, 400);

    // Deleting a lead removes its files from disk.
    const dir = path.join(process.env.SILPI_ASSETS_DIR!, a.id);
    assert.ok(existsSync(dir));
    const route = await import("@/app/api/business/leads/[id]/route");
    await route.DELETE(del(`/api/business/leads/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    assert.ok(!existsSync(dir), "files removed with the lead");
    assert.ok(existsSync(path.join(process.env.SILPI_ASSETS_DIR!, b.id)) || !existsSync(dir), "the other lead is untouched");
  });
});

describe("using what the client uploaded", () => {
  it("every admin response keeps the section available (it used to vanish after an upload)", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const adminCtx = { params: Promise.resolve({ id }) };
    const first = await body(await m.adminRoute.GET(get(`/api/business/leads/${id}/assets`), adminCtx));
    const logo = first.assets!.find((a) => a.key === "logo")!;
    assert.equal(first.available, true);

    const up = await body(await m.adminRoute.POST(upload(`/api/business/leads/${id}/assets`, logo.id, [{ name: "logo.png", data: "X" }]), adminCtx));
    assert.equal(up.available, true, "upload keeps the section");
    const fileId = up.assets!.find((a) => a.key === "logo")!.files[0].id;
    const marked = await body(await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: logo.id, status: "received" }, "PATCH"), adminCtx));
    assert.equal(marked.available, true, "confirming keeps the section");
    await body(await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: logo.id, status: "submitted" }, "PATCH"), adminCtx));
    const removed = await body(await m.adminRoute.DELETE(del(`/api/business/leads/${id}/assets?fileId=${fileId}`), adminCtx));
    assert.equal(removed.available, true, "removing a file keeps the section");
    const clientUp = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, logo.id, [{ name: "again.png", data: "Y" }]), ctx));
    assert.equal(clientUp.available, true, "the client's upload keeps the section");
  });

  it("nothing is required: no item is marked required", async () => {
    const { buildChecklist: build } = await import("@/lib/business/assets");
    assert.ok(build(requirement({ pages: ["Home", "Gallery", "Products"], modules: ["image-slider"] })).every((i) => !i.required));
  });

  it("the export copies whatever was uploaded, and lists the rest so placeholders are used", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const items = (await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx))).assets!;
    await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: items.find((a) => a.key === "page:home")!.id, text: "Welcome to BrightWave" }), ctx);
    await m.clientRoute.POST(upload(`/api/client/${token}/assets`, items.find((a) => a.key === "logo")!.id, [{ name: "My Logo.png", data: "LOGO" }]), ctx);

    // Sent but not yet checked by the team: it is still used.
    const out = path.join(root, "project");
    const exported = m.assets.exportContent(id, out);
    assert.equal(exported.items, 2);
    assert.equal(exported.files, 1);
    assert.ok(exported.missing.includes("Favicon (browser tab icon)") && exported.missing.includes("Mobile logo"));
    assert.ok(!exported.missing.includes("Logo") && !exported.missing.includes("Anything else"));
    const { readFileSync } = await import("node:fs");
    const md = readFileSync(path.join(out, ".silpi", "client-content.md"), "utf8");
    assert.match(md, /Welcome to BrightWave/);
    assert.match(md, /\.silpi\/client-assets\/brand\/logo\/My Logo\.png/);
    assert.match(md, /## Not provided yet/);
    assert.match(md, /- Mobile logo/);
    assert.match(md, /Placeholder/);
    assert.equal(readFileSync(path.join(out, ".silpi", "client-assets", "brand", "logo", "My Logo.png"), "utf8"), "LOGO");
  });

  it("with nothing uploaded the export still works and lists everything as missing", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    await m.clientRoute.GET(get(`/api/client/${token}/assets`), { params: Promise.resolve({ token }) });
    const exported = m.assets.exportContent(id, path.join(root, "project-empty"));
    assert.equal(exported.items, 0);
    assert.equal(exported.files, 0);
    assert.ok(exported.missing.length >= 6);
  });
});

describe("brand colours and fonts", () => {
  it("colour codes are normalised and bad ones are refused", async () => {
    const { normalizeHex } = await import("@/lib/business/assets");
    assert.equal(normalizeHex("#0b3d91"), "#0B3D91");
    assert.equal(normalizeHex("0b3d91"), "#0B3D91");
    assert.equal(normalizeHex("#0bf"), "#00BBFF");
    assert.equal(normalizeHex("  "), "");
    for (const bad of ["red", "#12", "#GGGGGG", "#1234567", "rgb(1,2,3)", "#0B3D91; x"]) assert.equal(normalizeHex(bad), null, bad);
  });

  it("the form starts with 9 colour fields and 1 font, and allows more", async () => {
    const a = await import("@/lib/business/assets");
    const empty = a.emptyBrandStyle();
    assert.equal(empty.colors.length, 9);
    assert.equal(a.MIN_BRAND_COLORS, 9);
    assert.equal(a.BRAND_COLOR_ROLES.length, 9);
    assert.equal(empty.fonts.length, 1);
    assert.equal(a.serializeBrandStyle(empty), "", "nothing filled in is stored as nothing");
    const eleven = a.validateBrandStyle({ colors: Array.from({ length: 11 }, (_, i) => (i === 10 ? "#112233" : "")), fonts: [] });
    assert.equal(eleven.colors.length, 11, "extra colours are kept");
    assert.throws(() => a.validateBrandStyle({ colors: Array.from({ length: 25 }, () => "#000000"), fonts: [] }), /At most 24 colours/);
    assert.throws(() => a.validateBrandStyle({ colors: [], fonts: Array.from({ length: 9 }, () => ({ name: "A" })) }), /At most 8 fonts/);
  });

  it("fonts: Google, Adobe and imported @font-face are each checked", async () => {
    const { validateBrandStyle } = await import("@/lib/business/assets");
    const ok = (fonts: unknown[]) => validateBrandStyle({ colors: [], fonts });
    const one = ok([
      { name: "Poppins", source: "google", usage: "heading", link: "https://fonts.googleapis.com/css2?family=Poppins" },
      { name: "Proxima Nova", source: "adobe", usage: "body", link: "abc1def" },
      { name: "Acme Sans", source: "imported", usage: "other", css: "@font-face { font-family: 'Acme Sans'; src: url('acme.woff2') format('woff2'); }" },
      { name: "", source: "google" },
    ]);
    assert.deepEqual(one.fonts.map((f) => [f.name, f.source]), [["Poppins", "google"], ["Proxima Nova", "adobe"], ["Acme Sans", "imported"]], "an empty font row is ignored");
    assert.equal(ok([{ name: "Lato", source: "google" }]).fonts[0].link, "", "a Google font needs only its name");
    assert.equal(ok([{ name: "Roboto", source: "adobe", link: "https://use.typekit.net/abc1def.css" }]).fonts.length, 1);
    assert.throws(() => ok([{ name: "X", source: "google", link: "https://evil.example/font.css" }]), /Google Fonts link/);
    assert.throws(() => ok([{ name: "X", source: "adobe", link: "javascript:alert(1)" }]), /Adobe Fonts link/);
    assert.throws(() => ok([{ name: "X", source: "imported", css: "body { color: red }" }]), /@font-face/);
    assert.throws(() => ok([{ name: "X", source: "imported", css: "@font-face{} <script>alert(1)</script>" }]), /without HTML/);
    assert.throws(() => ok([{ name: "X", source: "imported", css: "@font-face{}" + "a".repeat(4000) }]), /longer than 4000/);
    assert.throws(() => ok([{ name: "Bad<name>", source: "google" }]), /name can only have/);
    assert.throws(() => ok([{ name: "", source: "google", link: "https://fonts.google.com/specimen/Lato" }]), /type the font name/);
    assert.throws(() => validateBrandStyle({ colors: ["#12"], fonts: [] }), /Colour 1 is not a valid colour code/);
  });

  it("the server stores it clean, refuses bad input, and the project gets the palette and the font CSS", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const adminCtx = { params: Promise.resolve({ id }) };
    const items = (await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx))).assets!;
    const brand = items.find((a) => a.key === "brand-style")!;
    assert.match((await import("@/lib/business/assets")).buildChecklist(requirement()).find((i) => i.key === "brand-style")!.hint, /At least 9 colour codes/);

    const bad = await body(await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: brand.id, text: JSON.stringify({ colors: ["blue"], fonts: [] }) }), ctx));
    assert.equal(bad.success, false);
    assert.match(bad.error ?? "", /Colour 1 is not a valid colour code/);
    const notJson = await body(await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: brand.id, text: "{broken" }), ctx));
    assert.match(notJson.error ?? "", /could not be read/);

    const style = {
      colors: ["#0b3d91", "ff6a00", "#fff", "", "", "", "", "", "", "#123456"],
      fonts: [
        { name: "Poppins", source: "google", usage: "heading", link: "", css: "" },
        { name: "Acme Sans", source: "imported", usage: "body", link: "", css: "@font-face { font-family: 'Acme Sans'; src: url('acme.woff2'); }" },
      ],
    };
    const saved = await body(await m.clientRoute.POST(json(`/api/client/${token}/assets`, { assetId: brand.id, text: JSON.stringify(style) }), ctx));
    assert.equal(saved.success, true, saved.error);
    const stored = JSON.parse(saved.assets!.find((a) => a.key === "brand-style")!.text) as { colors: string[] };
    assert.deepEqual(stored.colors.slice(0, 3), ["#0B3D91", "#FF6A00", "#FFFFFF"], "codes are tidied");
    assert.equal(stored.colors.length, 10, "an extra colour is kept");
    assert.equal(saved.assets!.find((a) => a.key === "brand-style")!.status, "submitted");

    // The team can edit it too, with the same checks.
    const adminBad = await body(await m.adminRoute.PATCH(json(`/api/business/leads/${id}/assets`, { assetId: brand.id, text: JSON.stringify({ colors: ["#12"], fonts: [] }) }, "PATCH"), adminCtx));
    assert.match(adminBad.error ?? "", /Colour 1/);

    const out = path.join(root, "project-brand");
    const exported = m.assets.exportContent(id, out);
    assert.equal(exported.items, 1);
    const { readFileSync, existsSync: exists } = await import("node:fs");
    const md = readFileSync(path.join(out, ".silpi", "client-content.md"), "utf8");
    assert.match(md, /- Primary: #0B3D91/);
    assert.match(md, /- Secondary: #FF6A00/);
    assert.match(md, /- Extra colour 1: #123456/);
    assert.match(md, /- Poppins \(headings\): Google Fonts/);
    assert.match(md, /- Acme Sans \(body text\): imported font, @font-face CSS saved in `\.silpi\/brand-fonts\.css`/);
    const css = readFileSync(path.join(out, ".silpi", "brand-fonts.css"), "utf8");
    assert.match(css, /@font-face \{ font-family: 'Acme Sans'/);
    assert.ok(exists(path.join(out, ".silpi", "brand-fonts.css")));
  });

  it("font files can be uploaded with the item, but scripts still cannot", async () => {
    const m = await mods();
    const { id, token } = await newLead();
    m.store.setStage(id, "approved", "test");
    const ctx = { params: Promise.resolve({ token }) };
    const brand = (await body(await m.clientRoute.GET(get(`/api/client/${token}/assets`), ctx))).assets!.find((a) => a.key === "brand-style")!;
    for (const name of ["Acme.woff2", "Acme.woff", "Acme.ttf", "Acme.otf"]) {
      const r = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, brand.id, [{ name, data: "FONT" }]), ctx));
      assert.equal(r.success, true, `${name}: ${r.error}`);
    }
    const js = await body(await m.clientRoute.POST(upload(`/api/client/${token}/assets`, brand.id, [{ name: "x.js", data: "alert(1)" }]), ctx));
    assert.match(js.error ?? "", /not an accepted file type/);
  });

  it("an older free-text answer is kept and shown as a note, never lost", async () => {
    const a = await import("@/lib/business/assets");
    assert.equal(a.isBrandStyleText("Blue and orange, Poppins"), false);
    assert.equal(a.isBrandStyleText(JSON.stringify({ colors: ["#112233"], fonts: [] })), true);
    assert.equal(a.parseBrandStyle("Blue and orange").colors.length, 9, "the form still opens with 9 fields");
  });
});
