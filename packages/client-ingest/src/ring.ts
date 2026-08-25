/**
 * The last N events per member, in memory.
 *
 * Explicitly not storage. Phase 1 persists nothing — the durable record of a
 * capture is the JSONL file on the player's own machine, and the schema this
 * would need has not been designed yet, because designing it before seeing real
 * data is how you get the wrong one. What this exists for is the debug route:
 * somewhere to look while confirming that events are arriving at all.
 *
 * Two consequences worth stating plainly. It is bounded, so a long session
 * cannot grow the panel process without limit. And it is lost on restart, which
 * is a feature here rather than a defect: data this sensitive should not
 * outlive the reason it was collected.
 */

export interface BufferedEvent {
  readonly receivedAt: number;
  readonly eventName: string;
  readonly timestamp: number;
  readonly payload: unknown;
  readonly seq?: number | undefined;
  readonly session?: string | undefined;
}

export interface MemberEvents {
  readonly memberId: string;
  readonly ign: string;
  readonly events: readonly BufferedEvent[];
  readonly received: number;
  readonly dropped: number;
  readonly lastSeenAt: number;
}

export interface EventRingOptions {
  /** Events retained per member. Older ones fall off the front. */
  readonly perMember?: number;
  /** Members retained. The least recently seen is evicted past this. */
  readonly maxMembers?: number;
}

export interface EventRing {
  record(member: { memberId: string; ign: string }, events: readonly BufferedEvent[]): void;
  recent(memberId: string, limit?: number): MemberEvents | null;
  members(): readonly { memberId: string; ign: string; received: number; lastSeenAt: number }[];
  clear(): void;
}

const DEFAULT_PER_MEMBER = 200;
const DEFAULT_MAX_MEMBERS = 200;

interface Slot {
  memberId: string;
  ign: string;
  events: BufferedEvent[];
  received: number;
  dropped: number;
  lastSeenAt: number;
}

export function createEventRing(options: EventRingOptions = {}): EventRing {
  const perMember = options.perMember ?? DEFAULT_PER_MEMBER;
  const maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS;
  const slots = new Map<string, Slot>();

  function evictIfNeeded(): void {
    while (slots.size > maxMembers) {
      let oldestKey: string | null = null;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [key, slot] of slots) {
        if (slot.lastSeenAt < oldestSeen) {
          oldestSeen = slot.lastSeenAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      slots.delete(oldestKey);
    }
  }

  return {
    record(member, events): void {
      if (events.length === 0) return;
      let slot = slots.get(member.memberId);
      if (slot === undefined) {
        slot = { memberId: member.memberId, ign: member.ign, events: [], received: 0, dropped: 0, lastSeenAt: 0 };
        slots.set(member.memberId, slot);
      }

      slot.ign = member.ign;
      slot.received += events.length;
      slot.lastSeenAt = events[events.length - 1]?.receivedAt ?? Date.now();
      slot.events.push(...events);

      if (slot.events.length > perMember) {
        slot.dropped += slot.events.length - perMember;
        slot.events = slot.events.slice(slot.events.length - perMember);
      }

      evictIfNeeded();
    },

    recent(memberId, limit): MemberEvents | null {
      const slot = slots.get(memberId);
      if (slot === undefined) return null;
      const take = limit === undefined || limit <= 0 ? slot.events.length : Math.min(limit, slot.events.length);
      return {
        memberId: slot.memberId,
        ign: slot.ign,
        // Newest first: whoever is reading this is checking whether the thing
        // they just did in game showed up.
        events: slot.events.slice(slot.events.length - take).reverse(),
        received: slot.received,
        dropped: slot.dropped,
        lastSeenAt: slot.lastSeenAt,
      };
    },

    members(): readonly { memberId: string; ign: string; received: number; lastSeenAt: number }[] {
      return [...slots.values()]
        .map((slot) => ({
          memberId: slot.memberId,
          ign: slot.ign,
          received: slot.received,
          lastSeenAt: slot.lastSeenAt,
        }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },

    clear(): void {
      slots.clear();
    },
  };
}
