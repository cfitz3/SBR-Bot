/**
 * Perm errors, as sentences.
 *
 * Its own module because two surfaces now raise them — the `/perm` command and
 * the console's components — and an error that reads one way on a button and
 * another way on a command is the drift this platform's copy rules exist to
 * stop.
 *
 * The wording changed with the surface. The old text told people which command
 * to type next (`/perm action:create`), which was the only help available when
 * the way to do anything was to type it correctly. There is a button for each of
 * those now, on the card the reader is already looking at, so the sentences say
 * what is wrong and stop there.
 */
import type { PermError } from "@sbr/shared-types";

export function permProblem(error: PermError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "That party no longer exists.";
    case "DISBANDED":
      return "That party has been disbanded, so it can't be changed.";
    case "NAME_TAKEN":
      return `"${error.name}" is already the name of an active party.`;
    case "NOT_OWNER":
      return "Only the person who created that party, or staff, can change it.";
    case "FULL":
      return `That party is full — ${error.capacity} seats.`;
    case "ALREADY_ON_ROSTER":
      return `${error.ign} already has that seat.`;
    case "NOT_ON_ROSTER":
      return `${error.ign} isn't on that roster in that role.`;
    case "INVALID_ROLE":
      return `That isn't a role for this activity. It takes: ${error.allowed.join(", ")}.`;
    case "INVALID_NAME":
      return `That name won't work — ${error.detail}`;
    case "INVALID_IGN":
      return "That isn't a Minecraft name.";
  }
}
