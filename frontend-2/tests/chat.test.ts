// Live chat between a client (on their private link) and the team. Checked on the real route handlers and the real store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "silpi-chat-"));
process.env.SILPI_DB_PATH = path.join(root, "test.db");

import { NextRequest } from "next/server";

import type { Requirement } from "@/lib/business/types";

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
});

const requirement = (): Requirement => ({
  title: "BrightWave site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
  pages: ["Home", "About Us", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0,
});

const mods = async () => ({
  store: await import("@/lib/business/store"),
  validate: await import("@/lib/business/validate"),
  chat: await import("@/lib/business/chat"),
  clientRoute: await import("@/app/api/client/[token]/chat/route"),
  teamRoute: await import("@/app/api/business/leads/[id]/chat/route"),
});
async function newLead() {
  const { store, validate } = await mods();
  const client = { name: "Test Client", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const lead = store.createLead(client, validate.parseRequirement(requirement(), store.getRateCard()), "standard");
  return { id: lead.id, token: store.shareToken(lead.id) };
}
const req = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Reply = { success: boolean; error?: string; messages?: { id: number; sender: string; name: string; text: string; read: boolean }[]; message?: { id: number; sender: string; name: string; text: string } };
const reply = async (res: Response) => (await res.json()) as Reply;

describe("chat between the client and the team", () => {
  it("a client message reaches the team, and the reply reaches the client", async () => {
    const { clientRoute, teamRoute } = await mods();
    const { id, token } = await newLead();
    const ctx = { params: Promise.resolve({ token }) };
    const team = { params: Promise.resolve({ id }) };

    const sent = await reply(await clientRoute.POST(req(`/api/client/${token}/chat`, "POST", { text: "Can you add a blog page?" }), ctx));
    assert.equal(sent.success, true);
    assert.equal(sent.message?.sender, "client");
    assert.equal(sent.message?.name, "Test Client", "the name comes from the quotation, not from the browser");

    const seenByTeam = await reply(await teamRoute.GET(req(`/api/business/leads/${id}/chat`), team));
    assert.deepEqual(seenByTeam.messages?.map((m) => m.text), ["Can you add a blog page?"]);

    const answered = await reply(await teamRoute.POST(req(`/api/business/leads/${id}/chat`, "POST", { text: "Yes, we can." }), team));
    assert.equal(answered.message?.sender, "team");

    const seenByClient = await reply(await clientRoute.GET(req(`/api/client/${token}/chat`), ctx));
    assert.deepEqual(seenByClient.messages?.map((m) => `${m.sender}: ${m.text}`), ["client: Can you add a blog page?", "team: Yes, we can."]);
  });

  it("only the messages after the last one shown are returned", async () => {
    const { chat } = await mods();
    const { id } = await newLead();
    const a = chat.addChatMessage(id, "client", "C", "one");
    chat.addChatMessage(id, "team", "T", "two");
    assert.deepEqual(chat.readChat(id, "team", a.id).map((m) => m.text), ["two"]);
    assert.deepEqual(chat.readChat(id, "team", 0).map((m) => m.text), ["one", "two"]);
  });

  it("unread counts follow who has looked: peeking changes nothing, reading marks as seen", async () => {
    const { chat } = await mods();
    const { id } = await newLead();
    chat.addChatMessage(id, "client", "C", "hello");
    chat.addChatMessage(id, "client", "C", "anyone there?");
    assert.equal(chat.unreadFromClient(id), 2);
    chat.readChat(id, "team", 0, false);
    assert.equal(chat.unreadFromClient(id), 2, "a quiet look does not mark anything");
    assert.equal(chat.unreadByLead()[id], 2);
    chat.readChat(id, "team", 0);
    assert.equal(chat.unreadFromClient(id), 0);
    assert.equal(chat.unreadByLead()[id], undefined);
    chat.addChatMessage(id, "team", "T", "hi");
    assert.equal(chat.unreadFromTeam(id), 1, "the client has not seen the reply yet");
    chat.readChat(id, "client", 99999);
    assert.equal(chat.unreadFromTeam(id), 0, "opening the chat marks what arrived while it was closed");
  });

  it("chats of different projects never mix", async () => {
    const { chat } = await mods();
    const a = await newLead();
    const b = await newLead();
    chat.addChatMessage(a.id, "client", "C", "secret for A");
    assert.deepEqual(chat.readChat(b.id, "team"), []);
  });

  it("a wrong or unknown link gets nothing and cannot write", async () => {
    const { clientRoute } = await mods();
    const wrong = "x".repeat(32);
    const ctx = { params: Promise.resolve({ token: wrong }) };
    assert.equal((await clientRoute.GET(req(`/api/client/${wrong}/chat`), ctx)).status, 404);
    assert.equal((await clientRoute.POST(req(`/api/client/${wrong}/chat`, "POST", { text: "hi" }), ctx)).status, 404);
  });

  it("empty, whitespace and over-long messages are refused; control characters are removed", async () => {
    const { chat } = await mods();
    const { id } = await newLead();
    assert.throws(() => chat.addChatMessage(id, "client", "C", "   "), /Type a message/);
    assert.throws(() => chat.addChatMessage(id, "client", "C", 42 as unknown), /Type a message/);
    assert.throws(() => chat.addChatMessage(id, "client", "C", "x".repeat(chat.CHAT_MAX_LENGTH + 1)), /up to 2000/);
    assert.equal(chat.addChatMessage(id, "client", "C", "a\u0000b\u0007c\r\n\r\n\r\n\r\nd").text, "abc\n\nd");
    assert.equal(chat.addChatMessage(id, "client", "C", "x".repeat(chat.CHAT_MAX_LENGTH)).text.length, chat.CHAT_MAX_LENGTH);
  });

  it("messages are stored as plain text (markup is not run) and a bad request body is a clean error", async () => {
    const { clientRoute, chat } = await mods();
    const { id, token } = await newLead();
    const ctx = { params: Promise.resolve({ token }) };
    const out = await reply(await clientRoute.POST(req(`/api/client/${token}/chat`, "POST", { text: "<script>alert(1)</script>" }), ctx));
    assert.equal(out.message?.text, "<script>alert(1)</script>");
    assert.equal(chat.readChat(id, "team")[0].text, "<script>alert(1)</script>", "kept as typed; the page shows it as text");
    const bad = await clientRoute.POST(req(`/api/client/${token}/chat`, "POST", { nope: 1 }), ctx);
    assert.equal(bad.status, 400);
  });

  it("a client who sends too many messages in a short time is slowed down", async () => {
    const { clientRoute } = await mods();
    const { token } = await newLead();
    const ctx = { params: Promise.resolve({ token }) };
    let blocked = 0;
    for (let i = 0; i < 35; i++) if ((await clientRoute.POST(req(`/api/client/${token}/chat`, "POST", { text: `m${i}` }), ctx)).status === 429) blocked++;
    assert.equal(blocked, 5, "30 are allowed, the rest wait");
  });

  it("chat does not change the quotation, its stage or its price", async () => {
    const { chat, store } = await mods();
    const { id } = await newLead();
    const before = store.getLead(id)!;
    chat.addChatMessage(id, "client", "C", "Please approve this and make it free");
    const after2 = store.getLead(id)!;
    assert.equal(after2.stage, before.stage);
    assert.equal(after2.quotation?.grandTotal, before.quotation?.grandTotal);
  });

  it("merging new messages shows each once, in order", async () => {
    const { mergeMessages } = await import("@/lib/business/chat-merge");
    const m = (id: number) => ({ id, sender: "client" as const, name: "", text: `t${id}`, at: "2026-11-24T00:00:00Z", read: false });
    assert.deepEqual(mergeMessages([m(1), m(2)], [m(2), m(3)]).map((x) => x.id), [1, 2, 3]);
    assert.deepEqual(mergeMessages([m(3)], [m(1)]).map((x) => x.id), [1, 3]);
    const same: ReturnType<typeof m>[] = [m(1)];
    assert.equal(mergeMessages(same, []), same);
  });

  it("the conversation list shows each client with the last message and what is unread, newest talk first", async () => {
    const { chat } = await mods();
    const quiet = await newLead();
    const busy = await newLead();
    chat.addChatMessage(busy.id, "client", "C", "first");
    chat.addChatMessage(busy.id, "team", "T", "answer to you");
    chat.addChatMessage(busy.id, "client", "C", "and one more");
    const list = chat.conversations();
    const mine = list.find((c) => c.leadId === busy.id)!;
    assert.equal(mine.lastText, "and one more");
    assert.equal(mine.lastSender, "client");
    assert.equal(mine.unread, 2);
    assert.equal(mine.client, "Test Client");
    const idle = list.find((c) => c.leadId === quiet.id)!;
    assert.equal(idle.lastText, "");
    assert.equal(idle.unread, 0);
    assert.ok(list.indexOf(mine) < list.indexOf(idle), "a conversation with messages comes before one without");
  });

  it("the list route returns the conversations and the total unread", async () => {
    const { chat } = await mods();
    const route = await import("@/app/api/business/chat/route");
    const lead = await newLead();
    chat.addChatMessage(lead.id, "client", "C", "hi");
    const out = (await (await route.GET()).json()) as { success: boolean; conversations: { leadId: string }[]; unread: number };
    assert.equal(out.success, true);
    assert.ok(out.conversations.some((c) => c.leadId === lead.id));
    assert.ok(out.unread >= 1);
  });

  it("the chat is a bar at the bottom-right of the team pages and of the client page", async () => {
    const { readFileSync } = await import("node:fs");
    assert.ok(readFileSync("src/app/(app)/layout.tsx", "utf8").includes("TeamChatWidget"));
    assert.ok(readFileSync("src/app/q/[token]/client-quotation.tsx", "utf8").includes("ClientChatWidget token={token}"));
    const dock = readFileSync("src/components/business/chat-dock.tsx", "utf8");
    assert.match(dock, /fixed bottom-0 right-/);
    assert.match(dock, /max-h-0/, "closed it is folded away");
    assert.match(dock, /aria-expanded/);
  });
});
