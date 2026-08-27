# Panel security

What the web panel checks before it answers, and what was verified when the
multi-user access model landed. This is a description of the code, not a wish
list: every claim below has a line behind it in `apps/web-panel/src/server.ts`,
`apps/web-panel/src/composition.ts` or `packages/panel-core/src/access.ts`.

## The two gates

Authorisation is two questions asked in order, and they are not redundant.

**Gate one — is this guild addressable by this session at all?** A session
carries `manageableGuildIds`, resolved once at login. If the guild in the URL
is not in that list the answer is `NOT_MANAGEABLE` and nothing else runs. This
gate is about *scope*: it keeps one operator's guild out of another operator's
panel regardless of how the pages are tiered.

**Gate two — does this person's role in that guild reach the tier?**
`authorizeRole(session, guildId, minRole, roles)` compares the caller's derived
role for that guild against `PAGE_TIERS` (reads) or `MUTATION_TIERS` (writes),
answering `INSUFFICIENT_ROLE` on a shortfall. This gate is about *depth*: a
moderator who can legitimately see a guild's overview still cannot edit its
settings.

Collapsing the two would lose something real. Gate one alone would let any
admitted staff member reach every surface; gate two alone would let a role
resolved in one guild be tested against another guild's page.

## Getting into gate one

Two routes fill `manageableGuildIds`, and their union is what the session gets:

1. **Discord authority.** Guilds returned by `/users/@me/guilds` where the user
   holds `MANAGE_GUILD`, mapped from Discord snowflake to internal `Guild.id`.
   Snowflakes with no platform guild behind them are dropped and logged.
2. **Platform authority.** `staffGuildFinder.staffGuildIds(discordId, floor)`
   walks the caller's active memberships and resolves each one's role through
   the normal resolver, keeping the guilds where it reaches
   `PANEL_ACCESS_FLOOR`.

The floor is `MODERATOR`. Members are deliberately not admitted: widening the
session-minting rule to everyone would be a product change, not a security fix.
`PAGE_TIERS.leaderboard` is still declared at `MEMBER` — it states intent for
the day that floor moves, and is unreachable until then.

Role resolution is per-guild rather than a single SQL filter on the stored role,
because roles here are *derived* — `resolveMemberRole` folds the stored role,
the caller's Discord roles and their in-game rank against the guild's policy,
and `roleOverride` can demote. A flat query on the stored column would both miss
moderators who hold that rank via a Discord role and admit ones who have been
demoted.

The two lists are kept apart in the session. `discordManagedGuildIds` records
only route 1, and `managesInDiscord(session, guildId)` is what any decision that
genuinely turns on *Discord's* authority must ask — so widening gate one never
silently hands Discord-owned powers to a platform moderator. Sessions minted
before the split have no such field; they are read as fully Discord-managed,
which is what they were.

The field kept its old name (`manageableGuildIds`) on purpose: `loadSession`
validates that key's presence, so renaming it would have signed every live
operator out on deploy.

## Sessions

- Stored in Redis under `keys.session(id)`, never in the cookie. The cookie is
  an opaque `randomUUID` (122 bits), minted fresh on each login.
- 6h TTL on both the Redis entry and the cookie `Max-Age`, fixed rather than
  sliding — an abandoned tab expires on schedule.
- Logout deletes the Redis entry and clears both cookies with `Max-Age=0`;
  possession of an old cookie value is not enough to come back.
- OAuth `state` is a single-use `randomUUID` held server-side with a 10-minute
  TTL. The callback consumes it with `DEL` and treats a reply other than `1` as
  `invalid_state`, so the check cannot be won twice by racing it.
- The post-login redirect is a constant `/`, not anything taken from the
  request — there is no open-redirect surface in the callback.

## CSRF

Writes are a double-submit pair. `sbr_sess` is `HttpOnly` and unreadable by
script; `sbr_csrf` holds a second `randomUUID` that script *can* read and echo
in `x-csrf-token`. A cross-origin page can make the browser send the session
cookie but cannot read the CSRF cookie to construct the header.

`checkCsrf` rejects in three ways: an `Origin` header that is present and not
`selfOrigin` (`bad_origin`), a session minted before CSRF existed
(`csrf_stale_session`), and a missing or mismatched header (`bad_csrf`).
Comparison is `timingSafeEqual` after a length check, since that function throws
on unequal lengths and the length itself is not a secret.

The stale-session case is deliberately read-only rather than a forced logout: a
legacy session keeps working for pages and is refused only at the write, which
is the boundary that actually needs the token.

Mutations also live under their own prefix — `/api/guilds/:id/actions/:name` —
so "which URLs can change state" is answerable from a log or a proxy without
knowing the application.

## Cookies and headers

Both cookies are `Path=/`, `SameSite=Lax`, `Max-Age` matching the session TTL.
`Secure` is set from `WEB_PANEL_SCHEME` rather than unconditionally: a browser
silently *drops* a `Secure` cookie delivered over http, which would present as
"login does nothing" on a plaintext deployment. Running with
`WEB_PANEL_SCHEME="http"` logs a startup warning saying the cookies travel in
plaintext.

Every JSON, asset and page response carries `content-security-policy`,
`x-content-type-options: nosniff` and `referrer-policy: same-origin`. The CSP is
`default-src 'self'` with `base-uri 'none'`, `form-action 'self'`,
`frame-ancestors 'none'`, `object-src 'none'` and no `'unsafe-inline'` — which
is why `index.html` carries no inline script or style. Redirects send only
`location` and `set-cookie`; they have no body to protect.

## Request limits

- Request bodies are read streaming and abandoned past 16 KB
  (`body_too_large`), so a large POST is not buffered before being rejected.
- `headersTimeout` 15s and `requestTimeout` 30s, because node:http leaves both
  unbounded and that is a slowloris invitation.
- Outbound Discord calls are wrapped in a 10s `AbortController`; a hung Discord
  cannot hang a login.
- `upgrade` requests that are not the ctjs ingest path are destroyed rather than
  left holding a socket.

## Finding: the ingest debug endpoint was shut to everyone

`canReadIngestDebug` decides who may read `/debug/ingest`. It looped over the
session's guild ids and ran each through `guildRepository.resolveInternalId` —
but the ids in a session are already internal `Guild.id` values, and that
function looks up a *Discord snowflake*. Every id resolved to `null`, the loop
fell through, and the endpoint answered 403 to everybody, including the admins
it was written for.

Failing closed meant this was never going to show up as a breach, only as a
feature nobody could use — which is exactly why it survived. Fixed by checking
the internal ids directly against `identity.hasCapability(guildId, discordId,
"ADMIN")`, and the port now takes the whole `PanelSession` so a caller cannot
supply a mismatched id list and discord id again.

## Not covered here

Rate limiting on login is not implemented; Discord's own OAuth throttling is the
only brake today. If the panel is ever exposed beyond a single guild's staff,
that is the first thing to add.
