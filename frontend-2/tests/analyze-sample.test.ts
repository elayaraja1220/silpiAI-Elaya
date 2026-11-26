// A client may send 5 documents or 1,000 page designs. Nothing limits what can be ADDED; the AI reads a sample and is told the whole count.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

import { analysisTimeoutMs, chooseSample, composeNotes, readingEstimate, manifestNote, MAX_FILE_BYTES, MAX_LISTED, naturalCompare, parseManifest, READ_DOCUMENTS, READ_FILES, READ_TOTAL_BYTES, type FileInfo } from "@/lib/business/analyze-sample";

const MB = 1024 * 1024;
const pages = (n: number, size = 300 * 1024, ext = "jpg"): FileInfo[] => Array.from({ length: n }, (_, i) => ({ name: `page-${i + 1}.${ext}`, size }));
const names = (files: FileInfo[], picks: number[]) => picks.map((i) => files[i]!.name);

describe("1. choosing what the AI reads", () => {
  it("reads everything when there is little: all of it, in page order (page 2 before page 10)", () => {
    const files = [{ name: "page-10.jpg", size: 1000 }, { name: "page-2.jpg", size: 1000 }, { name: "brief.docx", size: 5000 }, { name: "page-1.jpg", size: 1000 }];
    assert.deepEqual(names(files, chooseSample(files)), ["brief.docx", "page-1.jpg", "page-2.jpg", "page-10.jpg"]);
    assert.deepEqual(chooseSample([]), []);
  });
  it("a thousand page designs: exactly the reading budget, the first and the last page included, spread evenly in between", () => {
    const files = pages(1000);
    const picks = chooseSample(files);
    assert.equal(picks.length, READ_FILES);
    const got = names(files, picks);
    assert.equal(got[0], "page-1.jpg");
    assert.equal(got.at(-1), "page-1000.jpg");
    const numbers = got.map((n) => Number(/page-(\d+)/.exec(n)![1]));
    assert.deepEqual([...numbers].sort((a, b) => a - b), numbers, "in page order");
    const gaps = numbers.slice(1).map((n, i) => n - numbers[i]!);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 2, `evenly spaced: ${gaps.join(",")}`);
  });
  it("however many files, the same files give the same sample (so the saved analysis can be reused)", () => {
    const files = pages(333);
    assert.deepEqual(chooseSample(files), chooseSample([...files].reverse().map((f) => ({ ...f }))).map((i) => 332 - i).sort((a, b) => a - b).map((i) => i), "order of adding does not change which pages are read");
  });
  it("written documents come first, at most five, and the images fill what is left", () => {
    const files = [...Array.from({ length: 8 }, (_, i) => ({ name: `doc-${i + 1}.pdf`, size: MB })), ...pages(200)];
    const got = names(files, chooseSample(files));
    assert.equal(got.length, READ_FILES);
    assert.equal(got.filter((n) => n.endsWith(".pdf")).length, READ_DOCUMENTS);
    assert.equal(got.filter((n) => n.endsWith(".jpg")).length, READ_FILES - READ_DOCUMENTS);
  });
  it("a file over 10 MB is never chosen (it is still counted elsewhere), and an empty file is not either", () => {
    const files = [{ name: "huge.png", size: MAX_FILE_BYTES + 1 }, { name: "empty.jpg", size: 0 }, { name: "ok.jpg", size: MB }];
    assert.deepEqual(names(files, chooseSample(files)), ["ok.jpg"]);
    assert.deepEqual(chooseSample([{ name: "huge.png", size: 50 * MB }]), [], "nothing readable: nothing chosen");
  });
  it("what is sent together stays under the size ceiling: the biggest image goes first", () => {
    const files = [...pages(11, 2 * MB), { name: "page-99.png", size: 9 * MB }, { name: "page-100.png", size: 9 * MB }];
    const picks = chooseSample(files);
    const total = picks.reduce((n, i) => n + files[i]!.size, 0);
    assert.ok(total <= READ_TOTAL_BYTES, `${total} bytes`);
    assert.ok(picks.length >= 8, "still a good number of pages");
    assert.ok(!names(files, picks).includes("page-99.png") || !names(files, picks).includes("page-100.png"), "the two biggest were the ones dropped");
  });
  it("ignores files the AI cannot read (a zip, a video) without failing", () => {
    const files = [{ name: "all.zip", size: MB }, { name: "clip.mp4", size: MB }, { name: "brief.docx", size: MB }];
    assert.deepEqual(names(files, chooseSample(files)), ["brief.docx"]);
  });
  it("natural comparison keeps numbered pages in order", () => {
    assert.deepEqual(["p10", "p2", "p1", "P3"].sort(naturalCompare), ["p1", "p2", "P3", "p10"]);
  });
});

describe("2. the list of every file", () => {
  it("is read back exactly, with names made safe", () => {
    assert.deepEqual(parseManifest(JSON.stringify([{ name: "a b (1).jpg", size: 10.7 }, { name: "../../etc/passwd", size: 5 }])), [{ name: "a b (1).jpg", size: 10 }, { name: ".._.._etc_passwd", size: 5 }]);
    assert.equal(parseManifest(""), null);
    assert.equal(parseManifest(null), null);
    assert.deepEqual(parseManifest("[]"), []);
  });
  it("refuses a list that is not one, has bad entries, or is absurdly long", () => {
    for (const bad of ["not json", "{}", "[1]", '[{"name":"a"}]', '[{"name":"a","size":-1}]', '[{"name":5,"size":1}]', '[{"name":"a","size":"x"}]']) assert.throws(() => parseManifest(bad), /could not be read/, bad);
    assert.throws(() => parseManifest(JSON.stringify(Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({ name: `f${i}`, size: 1 })))), /more than 20,000 files/);
    assert.equal(parseManifest(JSON.stringify(Array.from({ length: MAX_LISTED }, (_, i) => ({ name: `f${i}`, size: 1 }))))!.length, MAX_LISTED, "exactly the maximum is fine");
  });
});

describe("3. what the AI is told about the files it did not see", () => {
  it("says nothing when it was shown everything", () => {
    const files = pages(5);
    assert.equal(manifestNote(files, files.map((f) => f.name)), "");
  });
  it("states the total first, counts documents and images, and says to count the files, not the few it saw", () => {
    const files = [{ name: "brief.pdf", size: 1 }, ...pages(999)];
    const sent = ["brief.pdf", "page-1.jpg", "page-500.jpg"];
    const note = manifestNote(files, sent);
    assert.match(note, /^FILES THE CLIENT SUPPLIED: 1000 in total \(1 written documents, 999 images\)/);
    assert.match(note, /shown only 3 of them: brief\.pdf, page-1\.jpg, page-500\.jpg/);
    assert.match(note, /there are 999 page designs/);
    assert.match(note, /and 850 more\.$/, "only 150 names are listed, and the rest are counted");
    assert.ok(note.includes("page-1.jpg, page-2.jpg, page-3.jpg"), "names in page order");
  });
  it("stays within a size the agent accepts even for twenty thousand files with long names", () => {
    const files = Array.from({ length: MAX_LISTED }, (_, i) => ({ name: `${"x".repeat(100)}-${i}.jpg`, size: 1 }));
    const note = manifestNote(files, ["a.jpg"]);
    assert.ok(note.length <= 5000);
    assert.match(note, /20000 in total/);
  });
  it("joins what the team typed and the note within the agent's 10,000 characters, cutting the team's text and never the note", () => {
    const extra = "E".repeat(4000);
    assert.equal(composeNotes("hello", ""), "hello");
    assert.equal(composeNotes("hello", extra), `hello\n\n${extra}`);
    assert.equal(composeNotes("", extra), extra);
    const long = composeNotes("t".repeat(20_000), extra);
    assert.equal(long.length <= 10_000, true);
    assert.ok(long.endsWith(extra), "the note about the files is whole");
    assert.equal(composeNotes("x".repeat(20_000), "").length, 10_000);
  });
});

describe("4. the route", () => {
  const post = async (form: FormData) => {
    const route = await import("@/app/api/business/analyze/route");
    return route.POST(new NextRequest("http://localhost:3000/api/business/analyze", { method: "POST", body: form, headers: { host: "localhost:3000", origin: "http://localhost:3000" } }));
  };
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], "page-1.png", { type: "image/png" });
  it("refuses to be handed more files to read than the budget, with a clear reason (the page chooses the sample itself)", async () => {
    const form = new FormData();
    for (let i = 0; i < READ_FILES + 1; i++) form.append("files", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], `p${i}.png`, { type: "image/png" }));
    const res = await post(form);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /At most 12 files can be read at once/);
  });
  it("refuses a list of files it cannot read, before doing anything", async () => {
    const form = new FormData();
    form.append("files", png());
    form.append("manifest", "this is not a list");
    const res = await post(form);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /list of files could not be read/);
  });
  it("accepts a sample with the list of all the files, getting as far as the agent (which is not installed in tests)", async () => {
    const form = new FormData();
    form.append("files", png());
    form.append("manifest", JSON.stringify(pages(1000, 1000, "png")));
    const res = await post(form);
    assert.notEqual(res.status, 400, "the sample and the list were accepted");
    assert.equal(res.status, 503, "and the request got as far as asking the agent, which is not set up here");
  });
});

describe("5. how long to expect", () => {
  it("a bigger reading is expected to take longer, within bounds, and the high figure is always above the low one", () => {
    const one = readingEstimate([{ name: "brief.docx", size: 1 }]);
    const twelve = readingEstimate(pages(12));
    const none = readingEstimate([]);
    assert.ok(twelve.minSeconds > one.minSeconds && twelve.maxSeconds > one.maxSeconds, JSON.stringify({ one, twelve }));
    for (const e of [one, twelve, none, readingEstimate(pages(500))]) assert.ok(e.maxSeconds > e.minSeconds && e.maxSeconds <= 270, JSON.stringify(e));
    assert.ok(twelve.maxSeconds > 60, "twelve page images can take more than the old fixed 60 seconds");
  });
  it("the server waits at least three minutes and at most four and a half, more for more files, and always longer than the high estimate", () => {
    assert.deepEqual([analysisTimeoutMs(0), analysisTimeoutMs(1), analysisTimeoutMs(5), analysisTimeoutMs(12), analysisTimeoutMs(500)], [180_000, 180_000, 180_000, 264_000, 270_000]);
    for (const n of [1, 5, 12]) assert.ok(analysisTimeoutMs(n) / 1000 >= readingEstimate(pages(n)).maxSeconds, `${n} files`);
  });
});
