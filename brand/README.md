# `brand/` — your words and your looks

This folder is yours. Nothing in it is overwritten by an update, and nothing in
it contains logic — it is two lists of values.

- **`copy.ts`** — every user-visible string: command descriptions, panel labels,
  embed titles, error messages.
- **`theme.ts`** — every visual decision: embed colours, panel colours, spacing,
  radii, fonts.

The defaults live in `packages/brand-defaults`, which is mine. You never edit
that; you override it from here.

## Changing a word

Open `copy.ts` and name the key you want to change:

```ts
export const copyOverride: DeepPartial<Copy> = {
  panel: { nav: { members: "Roster" } },
};
```

Then:

```
npm run build
```

and restart whatever surface you changed. That is the whole loop.

## What "partial" means

You name only what you are changing. Every key you leave out keeps its default,
at every depth — writing `{ panel: { nav: { members: "Roster" } } }` changes that
one label and nothing else about the nav. An empty `{}` is a valid file.

## Why these are TypeScript and not JSON

Because the compiler can check them. Your editor autocompletes every valid key,
and `npm run build` fails on a key that does not exist or a value of the wrong
type. In JSON, a misspelled key is a line that sits there looking configured
while changing nothing — which you would only discover by noticing the word never
changed.

## Finding a key

Three ways, in order of how quickly they answer:

1. Type `panel.` in `copy.ts` and read the autocomplete.
2. `npm run brand diff` — exactly what you currently override, beside the
   default, in one screen.
3. Read `packages/brand-defaults/src/defaults/*.ts` — the defaults *are* the list
   of keys; there is no separate schema that could fall out of step with them.

Keys are structural, never derived from the English: `panel.members.title`, not
`panel.everyoneOnBothSides`. Rewording never renames.

## Colours

`theme.panel.*` becomes CSS custom properties served at `/theme.css`, which the
panel links after `app.css` — so your tokens win by cascade, no rule in
`app.css` is rewritten, and the panel's content-security policy is untouched
because the stylesheet is same-origin and nothing is inlined.

`theme.embed.colors` is what every card in both bots renders with. The five names
are semantic (`NEUTRAL`, `INFO`, `SUCCESS`, `WARNING`, `DANGER`), so recolouring
"danger" recolours every failure card at once.

`theme.embed.style` is the rest of the card: how many description lines before it
is an essay, how many fields before it is a wall, how many inline fields to a row,
and what an unknown value prints as. Those numbers have a checker and a way to
argue with them — see [docs/EMBED_STYLE.md](../docs/EMBED_STYLE.md). `npm run
embeds check` renders every card the platform can send and tells you which ones
your edit just broke, before Discord does.

## What a change costs

Honestly: a rebuild and a restart.

| You changed | You need |
|---|---|
| A word in `copy.ts` | `npm run build`, restart the affected process |
| A panel colour | `npm run build`, restart the panel — no client rebuild |
| An embed colour | `npm run build`, restart the bot |
| A command description | `npm run build`, restart the bot; Discord re-registers on boot |

## How the panel's browser half gets this

Worth knowing, because it explains the "no client rebuild" row above. The panel
has no bundler: `client/*.ts` is compiled straight to `public/app/` and the
browser loads exactly those modules, so it can only `import type` from workspace
packages — a bare specifier like `@sbr/brand` has nothing to resolve at runtime.

So the server hands the browser the resolved values as same-origin files it
generates: `/theme.css` for the tokens and `/copy.js` for the strings. Both come
from the same frozen objects the bots read, so there is still one answer; and
both are served, not bundled, which is why changing a word needs the panel
restarted but not the client recompiled.

## Checking your work

```
npm run brand check      # over-length descriptions, missing tokens, dead keys
npm run brand diff       # your overrides beside the defaults
npm run brand coverage   # how much of each surface is behind a key
```
