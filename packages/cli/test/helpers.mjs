/**
 * Test fixtures and a context that touches nothing outside the test.
 *
 * The commands take everything they need through `CliContext`, so a stub here
 * exercises the real dispatcher, the real renderers and the real exit-code
 * mapping without a network, a wallet or a captured process stream.
 */

/** Context with every escape hatch stubbed. Override only what a test needs. */
export function makeContext(overrides = {}) {
  const out = [];
  const err = [];
  const ctx = {
    env: {},
    isTty: false,
    canPrompt: false,
    emit(text) {
      out.push(text);
    },
    emitErr(text) {
      err.push(text);
    },
    async confirm() {
      return false;
    },
    async sleep() {},
    now() {
      return 1770000000000;
    },
    createClient() {
      throw new Error("test did not configure a client");
    },
    loadSigner() {
      throw new Error("test did not configure a signer");
    },
    onInterrupt() {
      return () => {};
    },
    ...overrides,
  };
  return { ctx, out, err };
}

export const DELTA_VIEW = {
  capturedAtMs: 1770000000000,
  deviationRatio: 0.0042,
  deviationBps: 42,
  thresholdBps: 100,
  withinThreshold: true,
  spotNotionalUsd: 12340000,
  shortNotionalUsd: 12288171.2,
  rebalanceCount: 184,
  lastRebalanceAtMs: 1769999000000,
  venues: [
    {
      venue: "velocity",
      venueId: 1,
      displayName: "Velocity",
      status: "live",
      market: "SOL-PERP",
      shortNotionalUsd: 9830536.96,
      weight: 0.8,
      carryAnnualizedRate: -0.1228,
      carryModel: "funding-receiving",
      carryDirection: "paid",
      detail: null,
    },
    { venue: "jupiter-perps", market: "SOL-PERP", shortNotionalUsd: 2457634.24, weight: 0.2 },
  ],
};

/** Delta with every optional field absent, for the "no fake zeros" checks. */
export const DELTA_VIEW_SPARSE = {
  capturedAtMs: 1770000000000,
  deviationRatio: null,
  deviationBps: null,
  thresholdBps: null,
  withinThreshold: null,
  spotNotionalUsd: null,
  shortNotionalUsd: null,
  rebalanceCount: null,
  lastRebalanceAtMs: null,
  venues: [],
};

export const FUNDING_VIEW_NEGATIVE = {
  capturedAtMs: 1770000000000,
  netCarryRate: -0.1842,
  annualizedRate: -0.1842,
  grossFundingRate: -0.1228,
  hedgeCostRate: 0.0614,
  isEstimate: true,
  windowHours: 8,
  negativeCarry: true,
  carryModel: "notional-weighted",
  venues: [
    { venue: "velocity", annualizedRate: -0.1228, market: "SOL-PERP", carryModel: "funding-receiving" },
    { venue: "jupiter-perps", annualizedRate: -0.0614, market: "SOL-PERP", carryModel: "borrow-fee-paying" },
  ],
};

export const FUNDING_VIEW_POSITIVE = {
  capturedAtMs: 1770000000000,
  netCarryRate: 0.1132,
  annualizedRate: 0.1132,
  grossFundingRate: 0.1746,
  hedgeCostRate: 0.0614,
  isEstimate: false,
  windowHours: 8,
  negativeCarry: false,
  carryModel: "notional-weighted",
  venues: [
    { venue: "velocity", annualizedRate: 0.1746, market: "SOL-PERP", carryModel: "funding-receiving" },
    { venue: "jupiter-perps", annualizedRate: -0.0614, market: "SOL-PERP", carryModel: "borrow-fee-paying" },
  ],
};

export function sourced(data, extra = {}) {
  return {
    source: "api",
    available: data !== null,
    observedAtMs: 1770000000000,
    detail: null,
    data,
    ...extra,
  };
}

export const UNAVAILABLE = {
  source: "api",
  available: false,
  observedAtMs: null,
  detail: "the indexer has not published a delta yet",
  data: null,
};

/** Protocol config as `getConfig()` returns it. u64 fields are decimal strings. */
export const CONFIG_VIEW = {
  address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  authority: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  collateralMint: "So11111111111111111111111111111111111111112",
  syntheticMint: "PoyzSynth1111111111111111111111111111111111",
  bondMint: "So11111111111111111111111111111111111111112",
  oracle: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  totalCollateral: "125000000000",
  pendingCollateral: "1500000000",
  totalSynthetic: "12340000000000",
  pendingRedeemSynthetic: "0",
  hedgedNotional: "12288171200000",
  totalStaked: "4100000000000",
  stakerFundingBalance: "18240000000",
  bufferBalance: "20000000000",
  bondedTotal: "45000000000",
  slashedTotal: "0",
  minKeeperBond: "10000000000",
  maxSyntheticSupply: "50000000000000",
  rebalanceCount: 184,
  lastProofSlot: 312845771,
  keeperCount: 3,
  deltaThresholdBps: 100,
  collateralRatioBps: 10000,
  mintFeeBps: 10,
  redeemFeeBps: 15,
  bufferShareBps: 1000,
  maxConfBps: 50,
  maxPriceAgeSec: 60,
  requestTtlSec: 900,
  minSettlementDelaySec: 30,
  unbondCooldownSec: 86400,
  lastFundingRateBps: -18,
  negativeFundingSinceMs: 1769990000000,
  lastSettleAtMs: 1769999500000,
  collateralDecimals: 9,
  syntheticDecimals: 6,
  bondDecimals: 9,
  paused: false,
  vaultsReady: true,
};

export const PLAN = {
  description: "Submit a mint request for 1 collateral token",
  feePayer: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  instructions: [
    {
      name: "mint_request",
      programId: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
      accounts: [
        {
          pubkey: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
          isSigner: true,
          isWritable: true,
          name: "user",
        },
        {
          pubkey: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
          isSigner: false,
          isWritable: true,
          name: "vault",
        },
      ],
      dataHex: "943ec61da5e72b1300ca9a3b0000000000000000000000",
    },
  ],
  warnings: [],
};

export function okSimulation(overrides = {}) {
  return {
    ok: true,
    unitsConsumed: 4213,
    logs: ["Program Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS invoke [1]"],
    errorName: null,
    errorMessage: null,
    ...overrides,
  };
}

export function failedSimulation() {
  return {
    ok: false,
    unitsConsumed: null,
    logs: [],
    errorName: "ProgramAccountNotFound",
    errorMessage: "Attempt to load a program that does not exist",
  };
}

/** Signer stub. The fake secret never leaves this file. */
export function fakeSigner(publicKey = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin") {
  return {
    signer: { publicKey, async signTransaction() { return new Uint8Array(64); } },
    publicKey,
    warnings: [],
  };
}
