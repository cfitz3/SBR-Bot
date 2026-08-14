import assert from "node:assert/strict";
import test from "node:test";
import { toHtml, toMarkdown, transcriptFilename, type TranscriptHeader } from "./transcript.js";
import { message, ticket } from "./fixtures.test.js";

const header: TranscriptHeader = {
  guildName: "Skyblock Royals",
  ticket: ticket({ number: 12, createdAt: "2026-08-01T00:00:00.000Z", closedAt: "2026-08-01T01:00:00.000Z" }),
  categoryName: "Support",
  openerTag: "ada#0",
};

test("the filename is stable and filesystem-safe", () => {
  assert.equal(transcriptFilename(header.ticket, "md"), "ticket-12.md");
  assert.equal(transcriptFilename(header.ticket, "html"), "ticket-12.html");
});

test("markdown carries the header facts", () => {
  const out = toMarkdown(header, [message()]);
  assert.match(out, /# Ticket #12 — Skyblock Royals/);
  assert.match(out, /\*\*Category:\*\* Support/);
  assert.match(out, /\*\*Opened by:\*\* ada#0/);
  assert.match(out, /\*\*Messages:\*\* 1/);
});

test("an unknown header field is an em dash rather than blank or zero", () => {
  const out = toMarkdown({ ...header, categoryName: null, ticket: ticket({ closedAt: null }) }, []);
  assert.match(out, /\*\*Category:\*\* —/);
  assert.match(out, /\*\*Closed:\*\* —/);
  assert.match(out, /\*\*Close reason:\*\* —/);
});

test("an empty ticket says so instead of rendering an empty document", () => {
  assert.match(toMarkdown(header, []), /No messages were captured/);
  assert.match(toHtml(header, []), /No messages were captured/);
});

test("edited and deleted messages are kept and marked, in both formats", () => {
  const messages = [
    message({ id: "a", content: "first" }),
    message({ id: "b", content: "second", editedAt: "2026-08-01T00:02:00.000Z" }),
    message({ id: "c", content: "third", deletedAt: "2026-08-01T00:03:00.000Z" }),
  ];

  const md = toMarkdown(header, messages);
  assert.match(md, /_\(edited\)_/);
  assert.match(md, /_\(deleted\)_/);
  // The deleted message's text survives — dropping it would misrepresent the
  // conversation as one that never contained it.
  assert.match(md, /third/);

  const html = toHtml(header, messages);
  assert.match(html, /class="msg gone"/);
  assert.match(html, /third/);
  assert.equal(html.match(/<article/g)?.length, 3);
});

test("a message with no text says so rather than rendering a gap", () => {
  assert.match(toMarkdown(header, [message({ content: "   " })]), /_\(no text\)_/);
  assert.match(toHtml(header, [message({ content: "" })]), /\(no text\)/);
});

test("attachments record the durable facts and label the link as expiring", () => {
  const withFile = message({
    attachments: [{ name: "proof.png", size: 2048, contentType: "image/png", url: "https://cdn.example/x.png" }],
  });
  const md = toMarkdown(header, [withFile]);
  assert.match(md, /proof\.png/);
  assert.match(md, /2\.0 KB/);
  assert.match(md, /link may have expired/);
  assert.match(toHtml(header, [withFile]), /link may have expired/);
});

test("the HTML escapes user-authored text rather than trusting it", () => {
  const hostile = message({
    authorTag: "<b>ada</b>",
    content: '<script>alert("x")</script>',
    attachments: [{ name: '<img src=x onerror=1>', size: 1, contentType: null, url: 'https://e/"x' }],
  });
  const html = toHtml(header, [hostile]);
  assert.ok(!html.includes("<script>"), "raw script tag survived escaping");
  assert.ok(!html.includes("<img src=x"), "raw attachment name survived escaping");
  assert.match(html, /&lt;script&gt;/);
});

test("the HTML is one self-contained document with no off-origin fetch", () => {
  const html = toHtml(header, [message()]);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<style>/);
  // A transcript is opened from disk, so anything it has to fetch is broken.
  assert.ok(!/<link\b/i.test(html));
  assert.ok(!/<script\b/i.test(html));
});
