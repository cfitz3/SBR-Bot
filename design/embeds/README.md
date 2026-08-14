# Specimens

A **specimen** is an embed somebody wants us to look like, saved as Discord's own
JSON. This folder is where they live, and `npm run embeds learn <name>` is what
reads them.

The reason for the folder is that "make it look like this" is not actionable on
its own. A design is a set of decisions — a colour, a line count, how many facts
sit on one row — and until those are numbers nobody can agree to them, review
them, or notice when a renderer quietly stops following them. `learn` turns a
specimen into that list.

## Capturing one

1. Build the card in [Discohook](https://discohook.org), or open any message a
   bot sent and use **Copy JSON** (Discord: message ⋯ menu, developer mode on).
2. Save it here as `design/embeds/<name>.json`. Use a name that says what the
   card is *for* — `ticket-opened`, not `nice-blue-one`.
3. Run `npm run embeds learn <name>`.

All three shapes Discord's tooling hands out are accepted: a whole message
payload (`{"content": …, "embeds": […]}`), a bare array of embeds, or a single
embed object.

## What `learn` tells you

- **What our view model cannot carry.** `EmbedView` is deliberately small. Author
  lines, full-width images, videos and timestamps have no home in it, and neither
  does a footer icon. Each one is named, not dropped quietly — the honest answer
  is either "widen `EmbedView`" or "we don't do that", and both need a person to
  see it first.
- **Colour, against the palette.** An exact match is reported as such. Anything
  else names its nearest neighbour *and* prints the one-line `brand/theme.ts`
  edit that would adopt the specimen's colour instead.
- **Where it differs from the house style** — description lines, field count,
  inline runs, footer length — each stated as our number against theirs. Every one
  of these is a single constant under `theme.embed.style`.
- **What the checker says about it**, treating the specimen as if we had sent it.
  A specimen can be illegal; Discohook will happily build a card Discord rejects.

## What we can express

Title, url, description, fields (name, value, inline), footer text, thumbnail,
and a colour **from the palette by name**. That last one is the constraint people
trip over: cards do not carry literal hex. A card states a *tone* — `GOOD`,
`WARN`, `BAD`, `INFO`, `NEUTRAL` — and the theme decides what that looks like, so
changing one number restyles every card at once. A specimen whose colour is off
the palette is a proposal to change the palette.

## Then what

Reading a specimen changes nothing on its own. The loop, and the reason the
folder is in version control, is in [docs/EMBED_STYLE.md](../../docs/EMBED_STYLE.md):

> specimen → `learn` → a changed constant in `brand/theme.ts` or a changed rule
> in `style.ts` → `check` → the whole gallery moves.

Keep the specimen after adopting it. It is the record of what was agreed, and the
thing to re-run `learn` against when someone asks why a card looks the way it does.
