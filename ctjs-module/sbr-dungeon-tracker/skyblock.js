/**
 * "Are we on Hypixel SkyBlock right now?"
 *
 * The socket only opens when this says yes, which is the gate that keeps the
 * module from streaming a members single-player world, another server, or the
 * Hypixel lobby to our backend. It is a privacy boundary as much as a
 * correctness one, so it fails **closed**: anything it cannot read is treated
 * as "not SkyBlock" rather than assumed.
 *
 * Every check here is a guess about strings Hypixel controls and can change in
 * any update. That is precisely why the detection result is itself captured to
 * the log — if it starts answering wrong, the fixtures will show it, and the
 * patterns below become the first thing EVENT_FINDINGS.md has to correct.
 */

/** UNVERIFIED against a live client — confirm during the capture sessions. */
const SKYBLOCK_TITLE = /SKYBLOCK/i;
/** UNVERIFIED — the dungeon scoreboard is believed to name the Catacombs. */
const DUNGEON_HINT = /(The Catacombs|Catacombs|Dungeon)/i;

function serverAddress() {
  try {
    const ip = Server.getIP();
    return ip === null || ip === undefined ? null : String(ip);
  } catch (e) {
    return null;
  }
}

function onHypixel() {
  const ip = serverAddress();
  if (ip === null) return false;
  return /hypixel\.net$/i.test(ip.replace(/:\d+$/, "")) || /hypixel\.net/i.test(ip);
}

function scoreboardTitle() {
  try {
    return String(ChatLib.removeFormatting(String(Scoreboard.getTitle())));
  } catch (e) {
    return null;
  }
}

function scoreboardText() {
  try {
    const lines = Scoreboard.getLines();
    const parts = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        parts.push(String(ChatLib.removeFormatting(String(lines[i].getName()))));
      } catch (e) {
        /* skip an unreadable line rather than abandon the read */
      }
    }
    return parts.join("\n");
  } catch (e) {
    return null;
  }
}

/**
 * True only when we are confident. Both signals must agree: the server has to
 * look like Hypixel *and* the scoreboard has to look like SkyBlock, because
 * either alone is satisfied by a lobby.
 */
function onSkyblock() {
  if (!onHypixel()) return false;
  const title = scoreboardTitle();
  return title !== null && SKYBLOCK_TITLE.test(title);
}

/** A weak hint, recorded rather than relied on. Confirm in Phase 1 captures. */
function looksLikeDungeon() {
  const text = scoreboardText();
  return text !== null && DUNGEON_HINT.test(text);
}

function describe() {
  return {
    server: serverAddress(),
    onHypixel: onHypixel(),
    scoreboardTitle: scoreboardTitle(),
    onSkyblock: onSkyblock(),
    looksLikeDungeon: looksLikeDungeon(),
  };
}

export default { onHypixel, onSkyblock, looksLikeDungeon, describe, serverAddress };
