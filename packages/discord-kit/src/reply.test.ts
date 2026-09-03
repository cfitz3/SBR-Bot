/**
 * The payload contract, which is now a Components V2 contract: exactly one
 * container, the flag always set, and never a `content` or `embeds` key —
 * Discord rejects a V2 message carrying either, and the rejection takes the
 * whole reply rather than the offending field.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageFlags } from "discord.js";
import type { ActionRowView } from "@sbr/shared-types";
import { replyOptions, withoutEphemeral } from "./reply.js";

function buttons(count: number): ActionRowView {
  return {
    buttons: Array.from({ length: count }, (_, i) => ({
      label: `Button ${i}`,
      style: "SECONDARY" as const,
      customId: `b-${i}`,
    })),
  };
}

test("every reply is one container carrying the V2 flag", () => {
  const options = replyOptions({ text: "hello", ephemeral: false });
  assert.equal(options.components.length, 1);
  assert.ok((options.flags & MessageFlags.IsComponentsV2) !== 0);
});

test("a reply never carries content or embeds, which V2 forbids", () => {
  const options = replyOptions({ text: "hello", ephemeral: false, embed: { title: "Card" } });
  assert.ok(!("content" in options));
  assert.ok(!("embeds" in options));
});

test("an ephemeral reply keeps both flags", () => {
  const flags = replyOptions({ text: "hi", ephemeral: true }).flags;
  assert.ok((flags & MessageFlags.Ephemeral) !== 0);
  assert.ok((flags & MessageFlags.IsComponentsV2) !== 0);
});

test("an edit drops ephemerality and keeps the V2 flag", () => {
  const flags = withoutEphemeral(replyOptions({ text: "hi", ephemeral: true })).flags;
  assert.equal(flags & MessageFlags.Ephemeral, 0);
  assert.ok((flags & MessageFlags.IsComponentsV2) !== 0);
});

test("a textless reply still says its sentence, inside the container", () => {
  const built = replyOptions({ text: "Nothing to show.", ephemeral: false }).components[0]!.toJSON();
  assert.ok(JSON.stringify(built).includes("Nothing to show."));
});

test("a reply carries at most five rows, inside the card", () => {
  const options = replyOptions({
    text: "hello",
    ephemeral: true,
    embed: { title: "Card" },
    components: Array.from({ length: 7 }, () => buttons(1)),
  });
  const rows = ((options.components[0]!.toJSON() as any).components ?? []).filter(
    (c: any) => c.type === 1,
  );
  assert.equal(rows.length, 5);
});

test("rows still reach a reply that has no card", () => {
  const options = replyOptions({ text: "hello", ephemeral: true, components: [buttons(2)] });
  const rows = ((options.components[0]!.toJSON() as any).components ?? []).filter(
    (c: any) => c.type === 1,
  );
  assert.equal(rows.length, 1);
});

test("every reply suppresses mentions, whatever the text says", () => {
  const options = replyOptions({ text: "@everyone welcome", ephemeral: false });
  assert.deepEqual(options.allowedMentions, { parse: [] });
});

test("an attachment is pointed at from inside the message, not merely uploaded", () => {
  const options = replyOptions({
    text: "Transcript",
    ephemeral: true,
    file: { name: "ticket-12.txt", content: "hello" },
  });
  assert.equal(options.files?.length, 1);
  const files = ((options.components[0]!.toJSON() as any).components ?? []).filter(
    (c: any) => c.type === 13,
  );
  assert.equal(files[0]?.file?.url, "attachment://ticket-12.txt");
});
