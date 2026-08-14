# Embed style

Every card this platform sends is an `EmbedView` — a small, transport-agnostic
shape (`packages/shared-types/src/views.ts`) that a renderer returns and
`@sbr/discord-kit` turns into a Discord embed. Until recently the only thing
deciding what one should *look* like was whoever wrote the renderer last, which
is why the cards drifted: `/skills` grew a ragged inline row, `/audit` grew a
paragraph nobody reads, and neither was visible in a diff.

This document is the style, and the loop that changes it.

## The two halves

**Limits** (`EMBED_LIMITS`, `packages/discord-kit/src/style.ts`) are Discord's own
caps. Exceeding one is a rejected message, not an untidy card, so they are not
overridable and violating one is an **error**.

**Style** (`theme.embed.style`, defaulted in `packages/brand-defaults`, overridable
in `brand/theme.ts`) is what *we* decided a good card looks like. Every value is a
taste judgement, which is exactly why it is a named constant an operator can
change rather than a number buried in a renderer. Violating one is a **warning**.

| Constant | Default | What it means |
|---|---|---|
| `descriptionLines` | 12 | Past this the description is an essay; move it into fields or a page. |
| `fields` | 12 | Past this the card is a wall; `paginate()` instead. |
| `inlineRow` | 3 | Discord packs inline fields three to a row. |
| `footer` | 120 | A footer is a caption, not a second description. |
| `separator` | `" · "` | Between facts on one line: `cata 42 · sa 51.3`. |
| `unknown` | `"—"` | What an unknown value prints as. Never "N/A", never a silent zero. |

The palette (`theme.embed.colors`) is the other half of appearance. Cards never
carry a hex; they state a **tone** — `NEUTRAL`, `INFO`, `SUCCESS`, `WARNING`,
`DANGER` — and the theme decides what each looks like. That indirection is what
lets one edit restyle sixty cards, and it is why a specimen with an off-palette
colour is a proposal to change the palette rather than a card to copy verbatim.

## The rules

`checkEmbed(view)` returns every issue rather than the first — a card is reviewed
whole, and fixing one issue per build is how a five-minute tidy becomes an hour.
Each rule has a stable id so docs, ignore-lists and this table can name it.

### Errors — Discord rejects the message, or nothing renders

| Rule | Fires when |
|---|---|
| `limit.title` | Title over 256 characters. |
| `limit.description` | Description over 4096. |
| `limit.footer` | Footer over 2048. |
| `limit.fields` | More than 25 fields. |
| `limit.field-name` | A field name over 256. |
| `limit.field-value` | A field value over 1024. |
| `limit.total` | All text in one embed over 6000 characters. |
| `field.empty` | A field name or value is blank. Discord rejects the **whole** message for one empty field — see the note below. |
| `empty` | No title, no description, no fields: this posts as a bare coloured bar. |
| `url.scheme` | A `url` or `thumbnailUrl` that is not `https://`. |

> `field.empty` is not hypothetical. `/online` built one field per guild rank, and
> a rank with nobody online produced an empty value — so a single quiet rank would
> have taken the roster command down for the entire guild. The gallery caught it
> before Discord did; `renderRosterEmbed` now drops empty ranks.

### Warnings — legal, but not house style

| Rule | Fires when |
|---|---|
| `raw-id` | A bare snowflake. A member always reads as a person: wrap it (`<@id>`, `<#id>`) or resolve it to a name. |
| `placeholder` | Text is `n/a`, `null`, `tbd`, `-`… Unknown prints as `theme.embed.style.unknown`. |
| `separator` | Facts joined with `" \| "`, `" -- "` or `" – "` instead of the theme's separator. |
| `color.missing` | No colour stated. Every card states a tone; `NEUTRAL` is a choice, absence is an oversight. |
| `title.punctuation` | A title ending in `.` or `!`. A title is a label, not a sentence. |
| `title.shouting` | An all-caps title. Titles are sentence case; the colour carries the urgency. |
| `description.lines` | Over `descriptionLines` lines. |
| `markdown.heading` | A `#` heading inside the description, competing with the card's own title. |
| `field.count` | Over `fields` fields. |
| `inline.ragged` | An inline run that leaves one field alone on its own row. |
| `footer.length` | Footer over `footer` characters. |

`checkEmbed(view, { ignore: ["rule.id"] })` skips a rule for the handful of cards
that break it on purpose. Ignoring by id, in the call, is deliberate: it puts the
exception next to the card it applies to instead of weakening the rule for
everything.

**Ragged inline runs have a fix, not just a rule.** `padInlineRow(fields)`
(`@sbr/shared-types`) completes the last inline row with zero-width spacers, so a
card whose field count depends on data — networth categories, whether a stats card
had guild standing, whether an application was reviewed — keeps its last field in
its column instead of stretching it across the width. It lives in `shared-types`
rather than in the theme for the same reason `FLATTEN_SEPARATOR` does: the
renderers that need it are in packages that cannot import `@sbr/brand` without a
cycle. A test in `packages/discord-kit/src/style.test.ts` pins its default width
to `theme.embed.style.inlineRow`, so the fix and the rule cannot drift apart.

## The gallery

`packages/embed-gallery` builds **every card the platform can send** by calling the
real renderers against fixed DTO fixtures — no database, no Hypixel key, no
gateway. That is what makes "check every card" a command rather than an audit
somebody schedules and then doesn't do.

Coverage is measured, not claimed. Each card records the renderer's own
`function.name`, and `coverage.test.ts` compares that derived set against every
`render…Embed` / `render…Pages` function the two command packages export, in both
directions. A renderer added next month with no fixture **fails a test**; a card
pointing at a renamed renderer fails too.

## The loop

> **specimen → `learn` → a changed constant in `brand/theme.ts` or a changed rule
> in `style.ts` → `check` → the whole gallery moves.**

1. **Specimen.** Somebody shows you a card they want. Save its Discord JSON as
   `design/embeds/<name>.json` — see [that folder's README](../design/embeds/README.md)
   for how to capture one.
2. **`npm run embeds learn <name>`.** Reports, in order: what our view model
   cannot carry (author lines, images, timestamps, footer icons — named, never
   dropped quietly), how its colour sits against the palette and the one-line edit
   that would adopt it, which house-style constants it disagrees with and by how
   much, and what the checker says about the specimen itself. A design is worth
   adopting only once you know which of it survives.
3. **Change one thing.** A number in `brand/theme.ts` if the disagreement is about
   taste; a rule in `packages/discord-kit/src/style.ts` if the disagreement is
   about what the rules should be. Not a renderer — a renderer edit fixes one card
   and leaves fifty-nine behind.
4. **`npm run embeds check`.** Runs the checker over the whole gallery. Exits
   non-zero on any error, so it belongs in CI; lists warnings without failing,
   because a judgement that blocks CI is one people learn to switch off.
5. **`npm run embeds preview <name>`** to look at a single card — as it renders in
   the terminal, plus its `toDiscordJson` round-trip to paste back into Discohook
   and show the person who asked. With no name it lists all sixty cards.

Keep the specimen after adopting it. It is the record of what was agreed, and the
thing to re-run `learn` against when somebody asks why a card looks the way it does.

## Honest limits

- `EmbedView` carries title, url, description, fields, footer text, thumbnail and
  a palette colour. Author lines, full-width images, videos, embed timestamps and
  footer icons have no home in it. `learn` names each one it drops; widening the
  view model is a decision, not an accident.
- The gallery renders **fixtures**. It proves a card is legal and in style for the
  data it was given; it does not prove the data is right.
- `check` covers embeds. Buttons, modals and select menus have no style checker
  yet.

## See also

- [`brand/README.md`](../brand/README.md) — the two-file model, and what a change costs.
- [`design/embeds/README.md`](../design/embeds/README.md) — capturing a specimen.
- `packages/discord-kit/src/style.ts` — the rules, as code.
- `packages/embed-gallery/src/fixtures.ts` — the data every card is drawn from.
