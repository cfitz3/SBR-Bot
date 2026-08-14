/**
 * Captured messages → a transcript, as markdown and as a standalone HTML file.
 *
 * Two things this module refuses to do quietly:
 *
 *   - **Deleted messages are shown as deleted**, not dropped. A transcript that
 *     silently loses a message is worse than no transcript, because it reads as
 *     a complete record of a conversation that did not happen that way.
 *   - **Attachment links are labelled as expiring.** Discord signs CDN URLs, so
 *     the link in a months-old transcript will not resolve. The transcript
 *     records the filename, size and type — facts that survive — and says
 *     plainly that the link may not.
 *
 * The HTML is one self-contained document with its own inline `<style>`. That
 * is fine *here* and nowhere else in this repo: it is a file handed to a member
 * as a download, not a page served by the panel, so the panel's CSP does not
 * apply to it and there is no host to fetch a stylesheet from.
 */
import type { TicketDTO, TicketMessageDTO } from "@sbr/shared-types";

export interface TranscriptHeader {
  readonly guildName: string;
  readonly ticket: TicketDTO;
  readonly categoryName: string | null;
  readonly openerTag: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().replace("T", " ").slice(0, 19);
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** A stable, filesystem-safe name for the downloaded file. */
export function transcriptFilename(ticket: TicketDTO, extension: "md" | "html"): string {
  return `ticket-${ticket.number}.${extension}`;
}

export function toMarkdown(header: TranscriptHeader, messages: readonly TicketMessageDTO[]): string {
  const t = header.ticket;
  const lines: string[] = [
    `# Ticket #${t.number} — ${header.guildName}`,
    "",
    `- **Category:** ${header.categoryName ?? "—"}`,
    `- **Opened by:** ${header.openerTag}`,
    `- **Opened:** ${stamp(t.createdAt)}`,
    `- **Closed:** ${t.closedAt === null ? "—" : stamp(t.closedAt)}`,
    `- **Claimed by:** ${t.claimedByDiscordId ?? "—"}`,
    `- **Close reason:** ${t.closeReason ?? "—"}`,
    `- **Messages:** ${messages.length}`,
    "",
    "---",
    "",
  ];

  if (messages.length === 0) {
    lines.push("_No messages were captured for this ticket._");
    lines.push("");
    return lines.join("\n");
  }

  for (const m of messages) {
    const marks: string[] = [];
    if (m.editedAt !== null) marks.push("edited");
    if (m.deletedAt !== null) marks.push("deleted");
    const suffix = marks.length > 0 ? ` _(${marks.join(", ")})_` : "";
    lines.push(`**${m.authorTag}** · ${stamp(m.createdAt)}${suffix}`);
    lines.push("");
    lines.push(m.content.trim() === "" ? "_(no text)_" : m.content);
    for (const a of m.attachments) {
      lines.push(`- 📎 ${a.name} (${bytes(a.size)}) — [link](${a.url}) _link may have expired_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function toHtml(header: TranscriptHeader, messages: readonly TicketMessageDTO[]): string {
  const t = header.ticket;
  const rows = messages
    .map((m) => {
      const marks: string[] = [];
      if (m.editedAt !== null) marks.push("edited");
      if (m.deletedAt !== null) marks.push("deleted");
      const badge = marks.length > 0 ? `<span class="mark">${escapeHtml(marks.join(" · "))}</span>` : "";
      const files = m.attachments
        .map(
          (a) =>
            `<li><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a> <span class="dim">${escapeHtml(
              bytes(a.size),
            )} — link may have expired</span></li>`,
        )
        .join("");
      return [
        `<article class="${m.deletedAt === null ? "msg" : "msg gone"}">`,
        `<header><b>${escapeHtml(m.authorTag)}</b> <time>${escapeHtml(stamp(m.createdAt))}</time> ${badge}</header>`,
        `<p>${escapeHtml(m.content) || '<span class="dim">(no text)</span>'}</p>`,
        files === "" ? "" : `<ul class="files">${files}</ul>`,
        "</article>",
      ].join("");
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket #${t.number} — ${escapeHtml(header.guildName)}</title>
<style>
:root{color-scheme:light dark;--bg:#14161c;--fg:#e7e9ee;--dim:#9aa3b2;--line:#2a2f3a;--card:#1b1e26}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfd;--fg:#1a1d24;--dim:#606a7b;--line:#e2e5ec;--card:#fff}}
body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .25rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.15rem 1rem;margin:1rem 0 2rem;color:var(--dim);font-size:.9rem}
dt{font-weight:600}dd{margin:0}
.msg{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:.75rem 1rem;margin:.5rem 0}
.msg.gone{opacity:.6;border-style:dashed}
.msg header{display:flex;gap:.6rem;align-items:baseline;font-size:.85rem;color:var(--dim)}
.msg header b{color:var(--fg);font-size:.95rem}
.msg p{margin:.4rem 0 0;white-space:pre-wrap;word-break:break-word}
.mark{border:1px solid var(--line);border-radius:.4rem;padding:0 .35rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
.files{margin:.5rem 0 0;padding-left:1.1rem;font-size:.85rem}
.dim{color:var(--dim)}
footer{margin-top:2rem;color:var(--dim);font-size:.8rem;border-top:1px solid var(--line);padding-top:1rem}
</style></head>
<body><main>
<h1>Ticket #${t.number}</h1>
<dl>
<dt>Guild</dt><dd>${escapeHtml(header.guildName)}</dd>
<dt>Category</dt><dd>${escapeHtml(header.categoryName ?? "—")}</dd>
<dt>Opened by</dt><dd>${escapeHtml(header.openerTag)}</dd>
<dt>Opened</dt><dd>${escapeHtml(stamp(t.createdAt))}</dd>
<dt>Closed</dt><dd>${escapeHtml(t.closedAt === null ? "—" : stamp(t.closedAt))}</dd>
<dt>Close reason</dt><dd>${escapeHtml(t.closeReason ?? "—")}</dd>
<dt>Messages</dt><dd>${messages.length}</dd>
</dl>
${messages.length === 0 ? '<p class="dim">No messages were captured for this ticket.</p>' : rows}
<footer>Deleted and edited messages are kept and marked rather than removed. Attachment links are Discord CDN links and expire; the filename, size and type above are the durable record.</footer>
</main></body></html>
`;
}
