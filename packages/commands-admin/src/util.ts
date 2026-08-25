import type { ModerationError } from "@sbr/shared-types";

/** Parse durations like "1h", "30m", "45s", "2d" into seconds. */
export function parseDurationSeconds(input: string | null | undefined): number | undefined {
  if (!input) return undefined;
  const m = /^(\d+)\s*([smhd])$/i.exec(input.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return value * mult;
}

export function renderModError(error: ModerationError): string {
  switch (error.kind) {
    case "TARGET_OUTRANKS_ACTOR":
      return "You can't action someone of equal or higher rank.";
    case "SELF_TARGET":
      return "You can't action yourself.";
    case "BOT_MISSING_PERMISSION":
      return "I'm missing the Discord permission to perform that action.";
    case "DURATION_REQUIRED":
      return "A duration is required for a mute (e.g. duration:1h).";
    case "NO_SUCH_CASE":
      return "No case with that id in this server.";
    case "ALREADY_VOID":
      return "That case has already been voided.";
  }
}
