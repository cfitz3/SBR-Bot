# Branding — changing the words and the looks

Every sentence this platform says and every colour it paints is data, not code. This document is for whoever owns those decisions: how to change them, what a change costs, and what the tooling can and cannot promise you.

**The one-line version:** edit `brand/copy.ts` or `brand/theme.ts`, run `npm run build`, restart. Nothing else in the repo needs touching.

---

## 1. The two-file model

There are two layers, and the split is the whole design:

| | Who owns it | Where | What it holds |
|---|---|---|---|
| **Defaults** | The developer | `packages/brand-defaults/src/defaults/*.ts` | Every key, with the English and the colours the platform ships with. |
| **Overrides** | You | `brand/copy.ts`, `brand/theme.ts` | Only what you want to be different. |

At startup `@sbr/brand` merges your override over the defaults, deep-freezes the result, and hands it to everything that renders. Your file is never touched by an upgrade, and a default you never named keeps following the platform as it changes.

**An empty override file is valid and is the normal state.** Both files ship empty, with a commented example. You are not expected to fill them in.

```ts
// brand/copy.ts — change two words, inherit the other nine hundred
import type { Copy, DeepPartial } from "@sbr/brand-defaults";

export const copyOverride: DeepPartial<Copy> = {
  panel: {
    shell: { name: "Aurora Guild Console" },
  },
  error: {
    generic: { notLinked: "You'll need to run /link first — takes ten seconds." },
  },
};
```

### Why TypeScript and not JSON

Because the compiler is the safety net. `DeepPartial<Copy>` means:

- **A misspelled key is a build error**, not a change that silently does nothing. This is the failure mode that makes JSON config miserable — you edit `pannel.title`, restart, see no change, and have no way to tell whether you got the key wrong or the feature is broken.
- **Your editor autocompletes every valid key**, so you can discover what is changeable by typing `.` rather than by reading this document.
- **A wrong-typed value is caught too** — a number where a string belongs, an object where a leaf belongs.

The cost is that editing needs a rebuild. A restart was needed anyway, so in practice this costs you the length of `npm run build`.

---

## 2. What the keys are called

Keys are **structural, never sentence-derived**: `panel.members.title`, not `panel.yourGuildMembers`. Rewording never renames, so your override survives us rewriting the English underneath it.

| Namespace | Covers | Read by |
|---|---|---|
| `command.<name>.description` | Every slash and in-game command | Slash registration, `/help`, in-game `!help`, the panel's command docs — all four from this one key |
| `command.<name>.option.<opt>` | Every command option | The same four |
| `panel.nav.*` | Sidebar labels and group headings | `client/main.ts` |
| `panel.<page>.*` | Titles, subtitles, table headers, buttons, validation text | One page module each |
| `panel.state.*` | Loading, empty, error and denied states | `client/components.ts`, so ~40 call sites at once |
| `panel.format.*` | Number locale, span words, duration and compact-number suffixes | `client/format.ts` |
| `panel.shell.*` | Product name, wordmark, tagline, tab title, the `noscript` line | The server-rendered HTML shell |
| `error.deny.*` | Panel access denials, by reason code | `client/api.ts` |
| `error.generic.*` | Shared failures, by reason code | Both bots' dispatchers |
| `error.command.*` | What a dispatcher says before a handler runs | Both bots' dispatchers |
| `error.hypixel.*` | Hypixel's four refusals, by `HypixelFailureState` | `renderFailure`, so every card that can fail |
| `error.link.*` | Why a `/link` didn't take, by `LinkError["kind"]` | `renderLinkError` |
| `embed.tone.*`, `embed.footer.*`, `embed.unknown` | Tone words, shared footers, the "no value" dash | Bot renderers |
| `embed.field.*` | Field names that appear on more than one card | The lookup cards and the profile card |
| `embed.metricPhrase.*` | The same metrics sentence-cased, for mid-sentence use | The event board |
| `embed.xpSource.*` | How each XP source is named to a member | `/me` |
| `embed.card.*` | Card titles, the title template and its nouns, and every "nothing to show" line | `render.ts` |

### Card titles are a template, not fifteen sentences

Every lookup card's title has the same shape — *whose* card, then *what* card — so there is one key for the shape and a vocabulary of nouns to fill it:

```ts
title: "{subject} — {noun}",
noun: { profile: "profile", skills: "skills", standing: "standing", … },
```

Change `card.title` once and all fifteen move together. Fifteen separate title literals would be fifteen chances for one of them to use a hyphen where the rest use an em dash, which is exactly what a house style is supposed to prevent. Two cards sit outside the template on purpose and have their own keys: `card.auctions` puts the item first, because an auction card is about an item far more often than about a player, and `card.roster` names the guild.

`embed.field` and `embed.metricPhrase` hold the same metrics in two casings, and that is deliberate rather than drift: field names are title-cased because they head a column, and the event board's are sentence-cased because they land inside a sentence. "SkyBlock" keeps its capital in both — no `toLowerCase()` would have got that right, which is why both are written out.

Keyed by *reason code* rather than by call site is deliberate: the same denial reaches a member through a slash command, a panel page and an in-game reply, and it should say the same thing in all three. When a surface genuinely needs different phrasing — the panel's denial can offer a sign-in button, guild chat cannot — that surface gets its own key rather than rewording the shared one.

### Placeholders

Some values carry a `{token}` the code substitutes:

```ts
cooldown: "Slow down — try that again in {n}s.",
ago: "{span} ago",
```

**Keep every token that a default has.** Dropping one does not fail the build — it produces a sentence missing its number. Adding one that the code doesn't supply leaves the literal `{token}` on screen. The doc comment above each key names what its tokens mean.

---

## 3. Looks

`brand/theme.ts` holds two independent palettes.

**Embed colours** (`theme.embed.colors`) are what every card in both bots renders with, as `0x`-prefixed integers. There is one palette; `discord-kit`'s renderer and its house-style checker read the same object, so a card cannot use a colour the checker doesn't know about.

**Panel tokens** (`theme.panel`) are the colours, spacing scale, radii, shadows and font stack the stylesheet is written against. The panel renders them into a `:root` block and serves it as `/theme.css`, linked *after* `app.css` so your values win by cascade — no rule in `app.css` is rewritten and nothing is inlined.

```ts
export const themeOverride: DeepPartial<Theme> = {
  embed: { colors: { INFO: 0x9184d9 } },
  panel: { colors: { accent: "#9184d9" }, chrome: { themeColor: "#161826" } },
};
```

Two things worth knowing:

- **`app.css`'s own `:root` block is the fallback, and it stays.** A panel served without the brand layer still renders. `npm run brand check` fails if the theme emits a token `app.css` doesn't declare, so the fallback can't quietly develop a hole.
- **A value that isn't a CSS value is dropped, not emitted.** A stray `;` or `}` in a token would take the rest of the stylesheet with it, so those tokens are omitted and named in a comment at the top of the generated sheet. The `app.css` fallback then supplies them.

The panel's **name** is a word, not a colour, so it lives in `copy.panel.shell.name`. Only `chrome.themeColor` — the tint mobile browsers paint their address bar with — is in the theme. One name, one place.

---

## 4. `npm run brand`

Three modes.

### `check` (also suitable for CI — exits non-zero on a problem)

- **Command descriptions** — every one within Discord's 100-character limit. Discord rejects a longer description at registration; `builders.ts` used to truncate it with an ellipsis and say nothing, so you found out by reading the command list. Now you find out before deploy.
- **Theme tokens** — every emitted token has an `app.css` fallback, and no token was dropped for holding a non-CSS value.
- **Embed gallery** — every card the platform can send, rendered from fixtures and run through the house-style checker. Error-severity issues fail; warnings are listed.
- **Copy keys** — keys defined but read nowhere, and reads that resolve to no key.

### `diff`

Exactly what your two files currently override, each shown next to the default it replaces. This is the answer to "what have I actually changed?" without a `git diff` against a file you may have inherited.

### `coverage`

Two numbers, deliberately kept apart:

- **Keys read** — how much of what the brand layer *defines* is actually wired up. A low number here means keys exist that nothing renders.
- **Literals left** — multi-word strings still hardcoded in the panel client and the two command packages. This is how much of the product still says something you *cannot* change, and it is the only number that can tell you a surface is finished.

---

## 5. What the checker does not promise

The dead-key and unresolved-read parts of `check` are **a text scan, not a type-checker.** They are a broom, not a proof.

- A key assembled at runtime — a table indexed by an enum, a key passed as a function argument — is invisible to a text scan. The scanner has been taught the patterns this repo actually uses (scoped readers, the accessor imports including their aliases, direct reads off the resolved object, and aliases of those), and where it cannot resolve a key it marks the whole namespace read rather than guessing. **Over-reporting a key as read costs a stale string nobody notices; under-reporting sends someone deleting a key that is on screen right now.**
- `command.*` is exempt entirely. Command copy is not read key by key — `withCommandCopy()` lays the whole table over both registries at build time, so a text scan sees zero reads and would report every description in the platform as dead. The real question, *does this key name a command that exists and does every command have a key*, is answered exactly, against the real built registries, by `packages/embed-gallery/src/commands.test.ts`. A worse version of a check that already exists is worth less than nothing, so this one defers.

`coverage` prints a number rather than a verdict for exactly this reason.

### Keys currently reported as read nowhere

Not all of them are bugs, and the report is left honest rather than tuned to zero:

- `panel.leaderboard.*`, `panel.xp.*` and two page subtitles — pages that are planned and not built. They are reported so the number stays true.
- `embed.tone.*`, `embed.footer.*`, `embed.unknown` and five `error.generic.*` codes — defined for surfaces whose prose has not been converted yet. See the *Literals left* figure in `coverage` for the size of that gap.

---

## 6. What a change costs

| You changed | Rebuild | Restart | Client rebuild |
|---|---|---|---|
| `brand/copy.ts` | yes | yes | no — the panel fetches copy over HTTP at boot |
| `brand/theme.ts`, panel tokens | yes | yes (server) | no — `/theme.css` is rendered server-side |
| `brand/theme.ts`, embed colours | yes | yes (both bots) | n/a |

Nothing hot-reloads. Both bots and the panel resolve the brand layer once at import and freeze it, which is why no request pays for the merge and no runtime code can mutate copy. Changing a word means a deploy — small, but a deploy.

**Command descriptions have one extra step.** Discord holds its own copy of your command list, so a changed description reaches users when the bot re-registers its commands at startup. Discord's global command propagation is not instant; guild-scoped registration is.

---

## 7. Verifying a change end to end

The single loop that proves the whole feature works:

1. Change one word in `brand/copy.ts` and one colour in `brand/theme.ts`.
2. `npm run build && npm run brand check`.
3. Restart the bots and the panel.
4. Confirm the word appears in the slash command Discord shows, in `/help`, in in-game `!help`, and in the panel.
5. Confirm the colour appears on the next embed and in the panel chrome.

If the word reaches all four surfaces, the overlay seam is intact — that is the point of applying it at registry-build time rather than at each call site.

---

## See also

- `brand/README.md` — the short version, next to the files you edit.
- [`EMBED_STYLE.md`](EMBED_STYLE.md) — the house style the checker enforces, and the specimen → `learn` → constant loop.
- [`WEB_PANEL.md`](WEB_PANEL.md) — how the panel gets its copy at boot, and why client modules may not import the brand layer.
- [`COMMANDS.md`](COMMANDS.md) — the registry the command copy is laid over.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — where the two packages sit in the dependency graph.
