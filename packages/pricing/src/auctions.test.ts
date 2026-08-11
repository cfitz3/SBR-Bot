import assert from "node:assert/strict";
import test from "node:test";
import type { AuctionListingDTO } from "@sbr/shared-types";
import { splitAuctions } from "./auctions.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

function listing(over: Partial<AuctionListingDTO> = {}): AuctionListingDTO {
  return {
    auctionId: "a1",
    itemName: "Hyperion",
    price: 1_000_000,
    bin: true,
    endsAt: "2026-06-02T00:00:00Z",
    highestBid: null,
    claimed: false,
    ...over,
  };
}

test("a running auction is active", () => {
  const split = splitAuctions([listing()], NOW);
  assert.equal(split.active.length, 1);
  assert.equal(split.claimValue, null);
});

test("an ended auction with a bid is coins waiting to be claimed", () => {
  const split = splitAuctions(
    [listing({ endsAt: "2026-05-30T00:00:00Z", highestBid: 900_000 })],
    NOW,
  );
  assert.equal(split.unclaimed.length, 1);
  assert.equal(split.expired.length, 0);
  assert.equal(split.claimValue, 900_000);
});

test("an ended auction with no bids is an item to take back", () => {
  const split = splitAuctions([listing({ endsAt: "2026-05-30T00:00:00Z" })], NOW);
  assert.equal(split.expired.length, 1);
  assert.equal(split.claimValue, null);
});

test("claim value sums every unclaimed sale", () => {
  const split = splitAuctions(
    [
      listing({ auctionId: "a1", endsAt: "2026-05-30T00:00:00Z", highestBid: 900_000 }),
      listing({ auctionId: "a2", endsAt: "2026-05-31T00:00:00Z", highestBid: 100_000 }),
    ],
    NOW,
  );
  assert.equal(split.claimValue, 1_000_000);
});

test("an already-collected auction is dropped entirely", () => {
  // Hypixel keeps claimed rows on the endpoint; listing them would tell a
  // seller to go and collect something already in their inventory.
  const split = splitAuctions(
    [listing({ endsAt: "2026-05-30T00:00:00Z", highestBid: 900_000, claimed: true })],
    NOW,
  );
  assert.deepEqual([split.active.length, split.unclaimed.length, split.expired.length], [0, 0, 0]);
  assert.equal(split.claimValue, null);
});

test("an unreadable end time counts as still running", () => {
  // Claiming an auction ended when we cannot see that it did is the worse error.
  assert.equal(splitAuctions([listing({ endsAt: null })], NOW).active.length, 1);
});
