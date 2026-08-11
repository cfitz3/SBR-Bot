/**
 * Splitting a player's auctions into the three states they actually care about.
 *
 * The auction house itself makes this distinction — running, sold-and-waiting,
 * and back-in-your-hands — and it is the whole point of asking: an unclaimed
 * sale is coins you are not holding, and an expired listing is an item out of
 * your inventory doing nothing.
 */
import type { AuctionListingDTO, AuctionsDTO } from "@sbr/shared-types";

/**
 * Claimed auctions are dropped: Hypixel keeps them on the endpoint for a while
 * after collection, and reporting them would tell a seller to go and claim
 * something they already have.
 */
export function splitAuctions(
  listings: readonly AuctionListingDTO[],
  now: number,
): Omit<AuctionsDTO, "listings"> {
  const active: AuctionListingDTO[] = [];
  const unclaimed: AuctionListingDTO[] = [];
  const expired: AuctionListingDTO[] = [];

  for (const listing of listings) {
    if (listing.claimed) continue;
    // An unreadable end time is treated as still running: telling someone an
    // auction ended when we can't see that it did is the worse error.
    const ended = listing.endsAt !== null && new Date(listing.endsAt).getTime() <= now;
    if (!ended) active.push(listing);
    else if ((listing.highestBid ?? 0) > 0) unclaimed.push(listing);
    else expired.push(listing);
  }

  const claimValue = unclaimed.reduce((sum, l) => sum + (l.highestBid ?? 0), 0);
  return { active, unclaimed, expired, claimValue: unclaimed.length > 0 ? claimValue : null };
}
