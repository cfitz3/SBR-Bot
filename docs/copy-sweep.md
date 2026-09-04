# Copy sweep — catalogue for review

**Nothing in this document has been applied.** It is a catalogue of copy that reads
long, over-explained, or "written by a machine that wanted to be sure you understood".
Each entry gives the location, the text as it stands, where a reader meets it, who
that reader is, and a suggested shorter version. Approve, edit or reject them
individually; the rewrites land in a separate change.

Almost all user-facing wording lives in `packages/brand-defaults/src/defaults/`
(`panel.ts` for the web panel, `embeds.ts` and `errors.ts` for the bots), so the sweep
is concentrated there. Line numbers point at the key and are current as of commit
`b2ec4ca`.

## How the entries are judged

Three failure modes recur, and they are worth naming because most entries are an
instance of one of them:

1. **The sentence that answers a question nobody asked.** A hint explaining the
   mechanism behind a field when the reader only needed to know what to type.
2. **The defensive clause.** "…, so there is nothing to configure here", "…, not that
   the number is zero" — anticipating a misreading and pre-empting it in the copy
   instead of in the design.
3. **The em-dash addendum.** A correct sentence, then a dash, then a second sentence
   qualifying it. Frequently the second half is the only half that matters.

Where a rewrite drops something genuinely useful, the entry says so under **Cost** —
those are the ones most worth arguing about.

---

## 1. Empty states (`packages/brand-defaults/src/defaults/panel.ts`)

Six empty states share a trailing clause of the form "…isn't switched on for this
deployment, so there is nothing to *X* here." The first half already says it, and the
audience is staff who did not install the platform and cannot switch the feature on
from where they are standing, so the second half is filler either way.

| Line | Key | Current | Suggested |
|---|---|---|---|
| 133 | `state.empty.leaderboardUninstalled` | "Leaderboards aren't switched on for this deployment, so there is nothing to show here." | "Leaderboards aren't switched on for this deployment." |
| 136 | `state.empty.milestonesDisabled` | "Milestone tracking isn't switched on for this deployment, so there is nothing to configure." | "Milestone tracking isn't switched on for this deployment." |
| 163 | `state.empty.rolesHealthUnavailable` | "Role sync isn't switched on for this deployment, so there is nothing to report here." | "Role sync isn't switched on for this deployment." |
| 169 | `state.empty.ticketsDisabled` | "Ticketing isn't switched on for this deployment, so there is nothing to configure." | "Ticketing isn't switched on for this deployment." |
| 173 | `state.empty.wordlistDisabled` | "The chat filter isn't switched on for this deployment, so there are no rules to edit." | "The chat filter isn't switched on for this deployment." |
| 175 | `state.empty.xpDisabled` | "Guild XP isn't switched on for this deployment, so there is nothing to configure here." | "Guild XP isn't switched on for this deployment." |

*Where it appears:* the body of each feature page when the feature is compiled out.
*Audience:* staff.
*Cost:* none identified — the panel renders these inside an empty-state block, so
"there is nothing here" is already carried by the layout.

The remaining empty states, individually:

| Line | Key | Current | Suggested | Note |
|---|---|---|---|---|
| 109 | `analyticsMessages` | "No messages were counted in this window. Counting starts when the bots are in the server." | "No messages counted in this window." | **Cost:** the second sentence is the actual diagnosis on a fresh install. Consider keeping it and cutting the first instead: "Counting starts once the bots are in the server." |
| 112 | `analyticsGexp` | "No guild experience has been recorded yet. It fills in once the guild scan has run." | "No guild experience recorded yet — the guild scan fills this in." | |
| 114 | `analyticsCharts` | "No events were recorded in this window. Analytics fill in as the bots are used — try a wider range." | "Nothing recorded in this window. Try a wider range." | |
| 118 | `eventsUpcoming` | "Nothing scheduled. Anything you create above lands here." | "Nothing scheduled yet." | **Cost:** the second sentence teaches the page layout on first use. Weak keep. |
| 129 | `membersNone` | "No members on record yet. They appear as the roster scans run." | "No members on record yet — the roster scans fill this in." | |
| 131 | `leaderboardBoard` | "Nobody is ranked on this board yet. Members appear once there is something to rank them by." | "Nobody is ranked on this board yet." | |
| 146 | `moderationAutomod` | "No automod rules yet. Start one on 'record it' and watch what it catches before it acts." | "No automod rules yet. Start one on 'record it' to see what it would catch." | Keep the advice — it is the one empty state that prevents a bad first move. |
| 149 | `overviewActivity` | "Nothing has happened in this guild yet — no moderation, joins, milestones or events on record." | "Nothing has happened in this guild yet." | |
| 154 | `permissionsCommandsUnavailable` | "The command list isn't available in this deployment, so command floors can't be edited here." | "The command list isn't available in this deployment." | |
| 160 | `rolesNoRules` | "No automatic roles yet. Add one below, then use 'What would this do?' before you switch them on." | "No automatic roles yet. Add one below and preview it before switching it on." | |
| 162 | `rolesNoRefusals` | "Discord has accepted every role change we asked for." | "Discord has accepted every role change." | "we" is the only first-person voice in the panel. |
| 166 | `selectorGuilds` | "No guilds to show. You need Manage Server on a Discord guild that the platform has been set up for." | "No guilds to show. You need Manage Server on a guild this platform is set up for." | |

---

## 2. Overview page notes (`panel.ts`)

*Where they appear:* small grey notes under the tiles and tables on the guild overview.
*Audience:* staff, most of whom read them once and never again.

| Line | Key | Current | Suggested |
|---|---|---|---|
| 651 | `overview.gameNote` | "Movement here is counted from the guild scans themselves, so somebody who joined and left inside the window shows in both figures rather than cancelling out." | "Counted from the guild scans, so someone who joined and left inside the window appears in both figures." |
| 653 | `overview.linkNote` | "A link is verified or it does not exist — there is no waiting state. Members shows exactly who is on each side." | "A link is either verified or absent; there is no pending state." |
| 674 | `overview.activityNote` | "The newest of each kind, interleaved. Configuration changes are not here — they are in the audit trail, which records who changed what rather than what the platform did on its own." | "The newest of each kind. Configuration changes are in the audit trail instead." |
| 680 | `overview.joinsNote` | "Stats are what the player's profile said at the moment they asked, not what it says now — and a dash means their API was unreadable, not that the number is zero. Nothing here is a membership gate any more: the scam check is the only bar." | "Stats are from the moment they applied, not now. A dash means their API was unreadable. Only the scam check gates entry." |

**Cost on `joinsNote`:** three facts compressed into three clauses. Nothing is dropped,
but it stops reading as prose — worth a second opinion.

The **guild-scan / "runs every 6 hours"** copy you flagged is the same family; see §7
for where that now stands.

---

## 3. Events page hints (`panel.ts`)

*Where they appear:* under individual fields in the event create/edit form, and under
the card preview.
*Audience:* staff creating an event, usually in a hurry.

| Line | Key | Current | Suggested |
|---|---|---|---|
| 829 | `events.previewHint` | "Drawn by the same renderer the bot posts with, from the standings above. It is not the posted message — nothing here is published." | "A preview only — nothing here is published." |
| 910 | `events.activityHint` | "The activity names the event, files it under a type and decides the one thing the board scores. Meetings and giveaways score nothing." | "The activity decides what the board scores. Meetings and giveaways score nothing." |
| 918 | `events.pollHint` | "Hypixel allows one read per player per hour, so an hour is the floor — anything shorter would be a setting that never took effect." | "One hour minimum — Hypixel allows one read per player per hour." |
| 925 | `events.prizeHint` | "Shown on the board and the result card. Awarding it is still a manual job — nothing is paid out automatically." | "Shown on the board and result card. Awarding it is manual." |
| 931 | `events.endsHint` | "Editing this on a live event moves the finish line only. Everyone keeps the starting line they were given when tracking began." | "Moves the finish line only; starting lines are unchanged." |

---

## 4. Moderation page (`panel.ts`)

*Where they appear:* section intros at the top of each moderation panel, plus field
hints.
*Audience:* staff, including staff acting under time pressure during a live incident.
This section has the highest ratio of explanation to instruction in the project.

| Line | Key | Current | Suggested |
|---|---|---|---|
| 1104 | `moderation.caseIntro` | "Editing a case corrects the record. It does not re-run the punishment — use Try again for that, or Void to withdraw it and lift whatever it is still holding." | "Editing corrects the record only. Use Try again to re-run it, or Void to withdraw it." |
| 1150 | `moderation.relayIntro` | "Every punishment that maps to a guild command is typed by the bridge and answered by Hypixel. This is what it was asked to do and what came back." | "What the bridge typed into guild chat, and what Hypixel answered." |
| 1180 | `moderation.automodIntro` | "Automod acts on a message with nobody in the loop, on Discord and in guild chat alike. A rule that fires hands the action to the same pipeline as /warn — so the escalation ladder, the audit trail and the in-game punishment sync all apply to it." | "Automod acts without a human in the loop, on Discord and in guild chat. A rule that fires goes through the same pipeline as /warn." |
| 1186 | `moderation.antiRaidIntro` | "Anti-raid gates arriving members while the posture is on, and does nothing at all while it is off — so a new account joining a quiet server is never asked to prove anything. A removal here becomes a case in the log like any other, with a reason and a way back." | "Anti-raid gates arriving members while it is on, and nothing while it is off. Removals are logged as ordinary cases." |
| 1213 | `moderation.raidTestIntro` | "Describe a burst and this replays it through the rules above — the same check the gate runs. Nothing is stored and nobody is gated." | "Replays a burst through the rules above. Nothing is stored and nobody is gated." |
| 1288 | `moderation.deleteHint` | "Separate from the action above: 'delete it and say nothing' and 'warn them but leave it up' are both things staff ask for." | "Separate from the action above — deleting and warning are independent." |
| 1302 | `moderation.patternHint` | "A regular expression. Refused at save time if it doesn't compile — better than storing one that silently never matches." | "A regular expression. Refused at save time if it doesn't compile." |
| 1336 | `moderation.testIntro` | "Nothing is written and nobody is punished — the answer below is what would have happened. The message itself is never recorded, which is the point: testing a slur rule should not file the slur in the audit log." | "A dry run: nothing is written, nobody is punished, and the message is not recorded." |
| 1352 | `moderation.cooldownsIntro` | "Every command ships with a cooldown its author chose. These override that: a guild-wide default, plus the handful of commands you actually care about." | "Overrides the per-command defaults: one guild-wide value, plus any exceptions." |
| 1360 | `moderation.relayHint` | "Seconds one member waits between messages the bridge relays, 0–{max}. 0 disables it. This sits on top of flood control, which protects the bridge account from Hypixel's own limit and is deliberately not settable here." | "Seconds a member waits between relayed messages, 0–{max}. 0 disables it. Separate from the bridge's own flood control." |

**Cost on `testIntro`:** the "should not file the slur in the audit log" justification is
what persuades a staffer it is safe to test a slur rule at all. A middle option keeps a
short form: "…and the message is not recorded — testing a slur rule shouldn't file it."

---

## 5. Filter, escalation and relay sync (`panel.ts`)

*Audience:* staff configuring the chat filter, typically once per install.

| Line | Key | Current | Suggested |
|---|---|---|---|
| 1385 | `filter.intro` | "Rules run on every message the bridge relays, in severity order — the harshest verdict among the matches is the one applied. Test a phrase against the live set with /filter-test before saving it." | "Rules run in severity order; the harshest match wins. Test with /filter-test." |
| 1393 | `filter.packsIntro` | "Lists this platform maintains. Every one is off until you switch it on, and each rule inside can be muted without losing the rest. Slur lists are deliberately not packaged — bring your own with Import." | "Maintained lists, all off until switched on. Individual rules can be muted. Slur lists are not packaged — import your own." |
| 1396 | `filter.importIntro` | "A JSON array of rules. Each needs a pattern; matchType, action and severity default to SUBSTRING, FLAG and 1. Rules already present are skipped, and a file with a bad rule is rejected whole. Up to 200 at a time." | **Keep.** Every clause is a rule the importer actually enforces and a reader will hit. |
| 1444 | `filter.escalationHint` | "When a warning brings a member to one of these counts, the platform applies the step itself, attributed to the staffer who warned. Warnings older than the window stop counting." | "Reaching one of these counts applies the step automatically, attributed to the warning staffer. Warnings age out of the window." |
| 1474 | `filter.relaySyncHint` | "A punishment issued here can be carried into the Hypixel guild by the bridge account. Only members with a linked account can be matched to an IGN — an unlinked member is punished on Discord and nowhere else, which the audit log records." | "Punishments can be carried into the guild by the bridge. Unlinked members are punished on Discord only." |
| 1479 | `filter.relaySyncReverseNote` | "The other direction is best-effort: Hypixel announces some in-game moderation in guild chat and not all of it, so actions taken in-game appear in the history when the bridge saw them announced." | "The reverse is best-effort — in-game actions appear only when Hypixel announces them in guild chat." |

---

## 6. Tickets, settings, permissions, roles, XP (`panel.ts`)

| Line | Key | Current | Suggested |
|---|---|---|---|
| 1522 | `tickets.intro` | "Members open a ticket from a panel, or with /ticket. Switching every category off closes ticketing without removing the history — the command then says so rather than opening one nobody watches." | "Members open a ticket from a panel or with /ticket. Switching every category off closes ticketing and keeps the history." |
| 1557 | `tickets.categoriesNote` | "A category is what a member picks. The five here on a fresh install are seeded rows, not built-ins — rename or remove any of them." | "What a member picks. The five seeded on install can be renamed or removed." |
| 1572 | `tickets.openingHint` | "Posted in the new channel. {num} {name} {nick} {avgRating} {avgResponseTime} {avgResolutionTime} are expanded." | **Keep.** The placeholder list is the content. |
| 1606 | `tickets.panelsNote` | "A panel is the message members click. Publishing posts it once and edits it in place afterwards — it never leaves a second copy behind." | "The message members click. Publishing posts once, then edits in place." |
| 1644 | `tickets.tagsNote` | "A canned reply staff can drop into a ticket, or an autoresponder for the whole server. Give it a pattern and the bot posts it itself when a message matches; 'Fires in' decides where." | "A canned reply, or an autoresponder if you give it a pattern. 'Fires in' decides where." |
| 1729 | `settings.linkHelpBodyHint` | "Added under the platform's steps, not instead of them — anything specific to this guild. Leave empty for none." | "Added under the standard steps. Leave empty for none." |
| 1766 | `settings.hypixelHint` | "The guild whose roster syncs here. Enter its name or its 24-character id; clear the field to unlink. Nothing syncs until this is set." | "The guild whose roster syncs here. Name or 24-character id; clear to unlink." |
| 1832 | `permissions.intro` | "A member's level is the highest of what their Discord roles and their in-game rank give them. Levels grant capabilities; an exception overrides a level for one subject, and a denial there beats every grant and every level." | "A member's level is the highest their Discord roles or in-game rank grant. Exceptions override a level for one person; a denial beats everything." |
| 1839 | `permissions.levelsHint` | "Holding any of a level's roles puts a member at that level. Someone with roles at two levels gets the higher one. Members with none of these roles are at the base level." | "Any of a level's roles puts a member at that level; the higher one wins. Everyone else is at the base level." |
| 1853 | `permissions.capabilitiesHint` | "Every level at or above the floor holds the capability. ADMIN cannot be lowered below Admin, which is what stops this page from being used to give it away." | "Every level at or above the floor holds it. ADMIN cannot be lowered below Admin." |
| 1867 | `permissions.commandsHint` | "Leave a command on its default unless you have a reason — the defaults are what the handlers were written against, and lowering one is how a destructive command reaches someone it wasn't meant for." | "Leave commands on their defaults unless you have a reason; lowering one widens who can run it." |
| 1873 | `permissions.exceptionsHint` | "An exception overrides the level for one subject. A denial wins over every grant and every level — removing a row is not the same as denying it, and restores whatever the level said." | "Overrides the level for one person. A denial wins over everything; removing a row restores the level." |
| 1924 | `roles.refusalsHint` | "Almost always one of two things: the bot is missing Manage Roles, or the role sits above the bot's own in the list. Fix it in Discord, then clear this." | **Keep.** A two-item checklist, not padding. |
| 1931 | `roles.autoEnabledHint` | "Off means the rules below are kept but nothing is applied. New rules are worth previewing before this goes on." | "Off keeps the rules but applies nothing. Preview new rules first." |
| 1988 | `roles.menuIntro` | "A message with buttons members press to give themselves a role. Only the roles listed on a menu can ever be handed out this way, so a menu can't be talked into offering a staff role." | "Buttons members press to give themselves a role. Only the listed roles can be handed out." |
| 2052 | `xp.intro` | "{on} of {total} sources counting. Changes apply from the next totalling pass onwards; days already scored keep the numbers they were scored under." | "{on} of {total} sources counting. Changes apply from the next pass; scored days are unchanged." |
| 2073 | `xp.advancedHint` | "Anti-abuse settings. Most guilds can leave these alone — the defaults stop farming without penalising ordinary activity." | "Anti-abuse settings. Most guilds can leave these alone." |
| 2076 | `xp.suggestHint` | "A sane starting point for a guild turning XP on: chat capped low enough that a day of talking is worth less than a day of playing. Overwrites every source it covers." | "A starting point for a new guild. Overwrites every source it covers." |

---

## 7. Analytics (`panel.ts`)

| Line | Key | Current | Suggested |
|---|---|---|---|
| 749 | `analytics.playtimeNote` | "Both figures are estimates. Presence is sampled, not measured, and a day with GEXP says somebody played, not for how long." | "Both figures are estimates — presence is sampled, and GEXP shows that somebody played, not for how long." |

**Correctness note, not a tone note.** The guild-scan "runs every 6 hours" wording you
flagged no longer matches the schedule: §6 of this work order moved the scan to
`26 1,4,7,…` (every three hours) and rewrote the cadence comments. Any panel copy that
names a cadence in prose should be checked against `apps/workers/src/schedule.ts` rather
than rewritten from memory. Called out here so it does not get lost inside a copy pass.

---

## 8. Panel shell

| Line | Key | Current | Suggested |
|---|---|---|---|
| 59 | `panel.shell.noscript` | "The control panel needs JavaScript. The underlying data is also available as JSON under /api/guilds." | "The control panel needs JavaScript. The same data is available as JSON at /api/guilds." |

*Audience:* whoever has scripting off — in practice a developer, or a locked-down
browser. Keeping the second sentence is right; "underlying" is the only fat.

---

## 9. Bot-facing copy (`embeds.ts`, `errors.ts`, `packages/commands-admin`)

Bot copy is markedly tighter than panel copy — it has always been written to fit inside
an embed. These are the few that still run long.

| Location | Current | Suggested |
|---|---|---|
| `brand-defaults/src/defaults/embeds.ts:463` | "You've already saved this reading. Your numbers refresh about once an hour — try again after the next one." | "You've already saved this reading. Numbers refresh about once an hour." |
| `brand-defaults/src/defaults/embeds.ts:530` | "Linked to **{ign}**. Hypixel is not answering right now, so your guild roles will arrive shortly." | "Linked to **{ign}**. Hypixel isn't answering, so your roles will follow shortly." |
| `brand-defaults/src/defaults/errors.ts:16` | "This server isn't yours to manage. Panel access needs Manage Server in Discord, or moderator rank here." | **Keep.** Both routes to access are the answer to "why can't I get in". |
| `commands-admin/src/render.ts:486` | "Answer with /join-accept ign:\<name\> or /join-deny ign:\<name\>. Hypixel drops a request five minutes after it is made." | **Keep.** The five-minute window is the reason to act now. |
| `commands-admin/src/handlers.ts:1061` and `:1137` | "Role menus aren't reachable from here — the bridge bot isn't running or isn't wired to this one." / same for sticky messages | "Role menus aren't reachable — the bridge bot isn't connected." (both sites, matching treatment) |
| `panel-core/src/mutations.ts:3539` | "Requested. If the workers are running it will start within a moment — the last-run column is what confirms it." | "Requested — the last-run column confirms when it starts." |

---

## 10. Operator-facing text (listed for completeness; no change recommended)

These read long, but their audience is whoever is holding a broken `.env` at the time,
and the length is doing work. Listed so the sweep is demonstrably complete rather than
selectively quiet.

- `apps/admin-bot/src/main.ts:133,136` — token rejection guidance.
- `apps/workers/src/jobs.ts:681` — Hypixel 403 guidance.
- `packages/config/src/index.ts:430` — TLS pair validation message.
- `packages/db/src/seed.ts:63,80` — first-run instructions.
- `packages/embed-kit/src/style.ts:275,391,439` — lint diagnostics for embed authors.
- `packages/progression/src/skyblock/advice.ts` (many) — player-facing progression
  advice, where the reasoning *is* the product. Deliberately excluded from this sweep.

---

## Summary

| Group | Entries | Change suggested | Keep suggested |
|---|---|---|---|
| Empty states | 18 | 16 | 2 |
| Overview notes | 4 | 4 | 0 |
| Events hints | 5 | 5 | 0 |
| Moderation | 10 | 10 | 0 |
| Filter / escalation | 6 | 5 | 1 |
| Tickets / settings / permissions / roles / XP | 18 | 16 | 2 |
| Analytics | 1 | 1 | 0 |
| Shell | 1 | 1 | 0 |
| Bot copy | 6 | 4 | 2 |
| Operator text | 6+ | 0 | all |

Roughly 62 strings are proposed for change. **None have been applied.** Reply with the
groups (or the individual keys) you want taken, and the rewrites will be made in one
pass over `packages/brand-defaults/src/defaults/`.
