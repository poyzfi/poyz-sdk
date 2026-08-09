/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: packages/anchor-program/idl/venues.json
 * Regenerate: npm run sync-idl --workspace @poyz/sdk
 *
 * The venue id contract, emitted by the program alongside its IDL. This SDK does
 * not keep a second copy: two tables that look right independently are how the
 * primary venue ends up registered under two names, and that mismatch is a
 * string, so nothing catches it until every proof commit fails at runtime.
 */

/** Slot numbering starts here. Slot 0 is the unset value and is never a venue. */
export const VENUE_ID_BASE = 1;
export const VENUE_ID_UNSET = 0;
export const VENUE_ID_MAX_ASSIGNABLE = 4;

/** Canonical venue name to slot. */
export const VENUE_SLOTS: Readonly<Record<string, number>> = {
  "none": 0,
  "velocity": 1,
  "jupiter-perps": 2,
  "adrena": 3,
  "flash-trade": 4,
  "simulated": 255
};

/** Accepted aliases, mapping an alternate spelling to a canonical name. */
export const VENUE_ALIASES: Readonly<Record<string, string>> = {
  "drift": "velocity"
};

/** Venues that no longer operate, with the reason they were retired. */
export const VENUE_RETIRED: Readonly<Record<string, string>> = {
  "zeta": "wound down 2025-05; slot 2 reassigned to jupiter-perps",
  "mango-v4": "wound down; no integration"
};

/** Bitmask of every assignable slot. Bit 0 is permanently unused. */
export const VENUE_FLAGS_MASK = 30;

/** Bitmask the program initialises with. */
export const VENUE_FLAGS_DEFAULT = 2;
