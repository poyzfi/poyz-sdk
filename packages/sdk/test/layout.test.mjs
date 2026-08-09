/**
 * Layout guard.
 *
 * The decoders read account data positionally: field N is whatever sits at the
 * offset every earlier field adds up to. That is fast and dependency-free, and
 * it is also silent when it is wrong -- a field inserted into the middle of the
 * program's struct shifts everything after it and produces numbers that look
 * plausible.
 *
 * So `ACCOUNT_LAYOUTS` in accounts.ts declares, by hand, the field sequence each
 * decoder assumes, and these tests compare that declaration with the IDL that
 * shipped in the package. A program change that renames, reorders, inserts or
 * retypes anything fails here with the field named, instead of downstream with a
 * balance that is off by a factor of nothing obvious.
 *
 * If one of these fails: fix the decoder AND the declaration together, then the
 * views that expose the field. Never fix only the declaration.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_LAYOUTS,
  INSTRUCTION_DISCRIMINATORS,
  POYZ_IDL,
  POYZ_IDL_ERRORS,
  POYZ_PROGRAM_ID,
  VENUE_ALIASES,
  VENUE_FLAGS_DEFAULT,
  VENUE_FLAGS_MASK,
  VENUE_ID_BASE,
  VENUE_ID_MAX_ASSIGNABLE,
  VENUE_ID_UNSET,
  VENUE_RETIRED,
  VENUE_SLOTS,
  venueIdFromName,
} from "../dist/esm/index.js";

/** Render an IDL type node the way ACCOUNT_LAYOUTS spells it. */
function renderType(node) {
  if (typeof node === "string") {
    return node;
  }
  if (node?.array !== undefined) {
    return `[${renderType(node.array[0])};${node.array[1]}]`;
  }
  if (node?.option !== undefined) {
    return `option<${renderType(node.option)}>`;
  }
  if (node?.defined !== undefined) {
    return node.defined.name;
  }
  if (node?.vec !== undefined) {
    return `vec<${renderType(node.vec)}>`;
  }
  return JSON.stringify(node);
}

function idlStruct(name) {
  const entry = POYZ_IDL.types.find((type) => type.name === name);
  assert.ok(entry !== undefined, `the shipped IDL has no type called ${name}`);
  assert.equal(entry.type.kind, "struct", `${name} is not a struct`);
  return entry.type.fields.map((field) => [field.name, renderType(field.type)]);
}

test("the shipped IDL is the one the SDK advertises", () => {
  assert.equal(POYZ_IDL.address, POYZ_PROGRAM_ID);
  assert.ok(POYZ_IDL.instructions.length > 0);
  assert.ok(POYZ_IDL.errors.length > 0);
});

for (const account of Object.keys(ACCOUNT_LAYOUTS)) {
  test(`${account} decoder layout matches the IDL field by field`, () => {
    const declared = ACCOUNT_LAYOUTS[account].map(([name, type]) => `${name}: ${type}`);
    const actual = idlStruct(account).map(([name, type]) => `${name}: ${type}`);
    assert.deepEqual(
      declared,
      actual,
      `${account} layout drifted. The decoder in src/accounts.ts reads the fields on the left; ` +
        "the program now defines the fields on the right.",
    );
  });
}

test("every account type in the IDL has a decoder layout", () => {
  const idlAccounts = POYZ_IDL.accounts.map((account) => account.name).sort();
  const covered = Object.keys(ACCOUNT_LAYOUTS).sort();
  assert.deepEqual(
    covered,
    idlAccounts,
    "the program defines an account type this SDK does not decode, or the other way round",
  );
});

test("every decoded account has a discriminator in the IDL", () => {
  for (const account of Object.keys(ACCOUNT_LAYOUTS)) {
    assert.equal(ACCOUNT_DISCRIMINATORS[account]?.length, 8, `${account} discriminator`);
  }
});

test("wrapped instruction arguments match the IDL", () => {
  const expected = {
    mint_request: ["nonce:u64", "collateral_amount:u64", "min_synthetic_out:u64"],
    mint_confirm: ["nonce:u64", "hedge_proof_hash:[u8;32]", "venue_id:u8", "filled_notional:u64"],
    mint_cancel: ["nonce:u64"],
    redeem_request: ["nonce:u64", "synthetic_amount:u64", "min_collateral_out:u64"],
    redeem_confirm: ["nonce:u64", "unwind_proof_hash:[u8;32]", "venue_id:u8", "unwound_notional:u64"],
    redeem_cancel: ["nonce:u64"],
    stake: ["amount:u64"],
    request_unstake: ["amount:u64"],
    unstake: [],
    claim_funding: [],
    keeper_register: ["bond_amount:u64"],
    keeper_bond: ["amount:u64"],
    keeper_unbond: ["amount:u64"],
    commit_rebalance_proof: [
      "sequence:u64",
      "venues_hash:[u8;32]",
      "venue_id:u8",
      "delta_bps_before:i32",
      "delta_bps_after:i32",
      "hedged_notional:u64",
      "collateral_notional:u64",
    ],
    buffer_deposit: ["amount:u64"],
    report_venue_state: ["venue_id:u8", "net_carry_bps:i32", "capacity_notional:u64"],
  };

  for (const [name, args] of Object.entries(expected)) {
    const entry = POYZ_IDL.instructions.find((instruction) => instruction.name === name);
    assert.ok(entry !== undefined, `the shipped IDL has no instruction called ${name}`);
    assert.deepEqual(
      entry.args.map((arg) => `${arg.name}:${renderType(arg.type)}`),
      args,
      `${name} arguments drifted from what src/instructions.ts encodes`,
    );
    assert.equal(INSTRUCTION_DISCRIMINATORS[name]?.length, 8, `${name} discriminator`);
  }
});

test("wrapped instruction account order matches the IDL", () => {
  const expected = {
    mint_request: [
      "user",
      "config",
      "request",
      "collateral_mint",
      "user_collateral",
      "collateral_vault",
      "oracle",
      "token_program",
      "system_program",
    ],
    mint_cancel: [
      "user",
      "config",
      "request",
      "collateral_mint",
      "collateral_vault",
      "user_collateral",
      "token_program",
    ],
    stake: [
      "owner",
      "config",
      "position",
      "synthetic_mint",
      "owner_synthetic",
      "stake_vault",
      "token_program",
      "system_program",
    ],
    unstake: [
      "owner",
      "config",
      "position",
      "synthetic_mint",
      "stake_vault",
      "owner_synthetic",
      "token_program",
    ],
    claim_funding: [
      "owner",
      "config",
      "position",
      "synthetic_mint",
      "funding_vault",
      "owner_synthetic",
      "token_program",
    ],
    keeper_register: [
      "keeper",
      "config",
      "keeper_account",
      "bond_mint",
      "keeper_bond_source",
      "bond_vault",
      "token_program",
      "system_program",
    ],
    commit_rebalance_proof: ["keeper", "config", "keeper_account", "proof", "oracle", "system_program"],
    buffer_deposit: [
      "depositor",
      "config",
      "synthetic_mint",
      "depositor_synthetic",
      "buffer_vault",
      "token_program",
    ],
    report_venue_state: ["authority", "config"],
  };

  for (const [name, accounts] of Object.entries(expected)) {
    const entry = POYZ_IDL.instructions.find((instruction) => instruction.name === name);
    assert.ok(entry !== undefined, `the shipped IDL has no instruction called ${name}`);
    assert.deepEqual(
      entry.accounts.map((account) => account.name),
      accounts,
      `${name} account order drifted from what src/instructions.ts builds`,
    );
  }
});

test("PDA seeds match the IDL, including the keyed ones", () => {
  const expected = {
    config: ['const:"config"'],
    collateral_vault: ['const:"collateral_vault"', "account:collateral_mint"],
    bond_vault: ['const:"bond_vault"'],
    buffer_bond_vault: ['const:"buffer_bond_vault"'],
    funding_vault: ['const:"funding_vault"'],
    buffer_vault: ['const:"buffer_vault"'],
    stake_vault: ['const:"stake_vault"'],
    redeem_escrow: ['const:"redeem_escrow"'],
    position: ['const:"stake"', "account:owner"],
    proof: ['const:"proof"', "arg:sequence"],
  };

  const seen = new Map();
  for (const instruction of POYZ_IDL.instructions) {
    for (const account of instruction.accounts) {
      if (account.pda === undefined) {
        continue;
      }
      const seeds = account.pda.seeds.map((seed) => {
        if (seed.kind === "const") {
          return `const:"${Buffer.from(seed.value).toString("utf8")}"`;
        }
        return `${seed.kind}:${seed.path}`;
      });
      if (!seen.has(account.name)) {
        seen.set(account.name, seeds);
      }
    }
  }

  for (const [name, seeds] of Object.entries(expected)) {
    assert.deepEqual(seen.get(name), seeds, `${name} PDA seeds drifted from what src/pda.ts derives`);
  }
});

test("error codes the SDK names by hand still resolve to those names", () => {
  // These are the codes referenced in warnings, docs and tests. Anchor renumbers
  // on insertion, so pin the ones that carry meaning in this package.
  const pinned = {
    MintPaused: "MintPaused",
    RedeemPaused: "RedeemPaused",
    VaultsNotReady: "VaultsNotReady",
    InsufficientBond: "InsufficientBond",
    UnbondCooldownActive: "UnbondCooldownActive",
    BondBelowMinimum: "BondBelowMinimum",
    ProofSequenceMismatch: "ProofSequenceMismatch",
    ProofSlotNotMonotonic: "ProofSlotNotMonotonic",
    DeltaThresholdExceeded: "DeltaThresholdExceeded",
    RequestExpired: "RequestExpired",
    RequestNotExpired: "RequestNotExpired",
    UnstakeCooldownActive: "UnstakeCooldownActive",
    NoPendingUnstake: "NoPendingUnstake",
    BufferLocked: "BufferLocked",
  };
  const byName = new Map(POYZ_IDL_ERRORS.map((entry) => [entry.name, entry]));
  for (const name of Object.keys(pinned)) {
    const entry = byName.get(name);
    assert.ok(entry !== undefined, `the program no longer defines the error ${name}`);
    assert.ok(entry.msg.length > 0, `${name} has no message`);
  }
});

test("the venue contract the SDK compiled in matches the one the program published", () => {
  // The SDK reads the venue table from the program's own emitted contract. This
  // pins the properties that must hold whatever the contract says, so a future
  // edit that reintroduces a 0-based slot or drops the rename alias fails here.
  assert.equal(VENUE_ID_UNSET, 0, "the unset slot must stay 0");
  assert.equal(VENUE_ID_BASE, 1, "assignable slots must start at 1, so unset is distinguishable");
  assert.ok(VENUE_ID_MAX_ASSIGNABLE >= VENUE_ID_BASE);

  for (const [name, slot] of Object.entries(VENUE_SLOTS)) {
    if (slot === VENUE_ID_UNSET) {
      assert.equal(name, "none", "only 'none' may occupy the unset slot");
      continue;
    }
    assert.ok(slot > 0, `${name} must not sit on the unset slot`);
  }

  for (const [alias, canonical] of Object.entries(VENUE_ALIASES)) {
    assert.ok(VENUE_SLOTS[canonical] !== undefined, `alias ${alias} points at unknown ${canonical}`);
  }

  for (const retired of Object.keys(VENUE_RETIRED)) {
    assert.equal(VENUE_SLOTS[retired], undefined, `retired venue ${retired} must hold no slot`);
  }

  // bit index == venue id, so bit 0 can never be set in the mask.
  assert.equal(VENUE_FLAGS_MASK & 1, 0, "bit 0 is permanently unused");
  assert.equal(VENUE_FLAGS_DEFAULT & 1, 0);
});

test("the venue table matches the program's own Rust constants", (t) => {
  // venues.json is generated; state.rs is what runs through require!. When the
  // two disagree the Rust wins, so the reference for this comparison is the Rust
  // source, read directly. It only exists in the monorepo -- the public SDK
  // repository ships without packages/anchor-program -- so absence is reported
  // rather than silently passed, and POYZ_REQUIRE_RUST_SOURCE=1 makes it fatal.
  const statePath = new URL("../../anchor-program/programs/poyz/src/state.rs", import.meta.url);
  let rust = null;
  try {
    rust = readFileSync(statePath, "utf8");
  } catch (error) {
    const detail = `state.rs not readable (${error.code ?? error.message})`;
    if (process.env.POYZ_REQUIRE_RUST_SOURCE === "1") {
      assert.fail(`${detail}. POYZ_REQUIRE_RUST_SOURCE=1 demands the comparison.`);
    }
    t.diagnostic(`SKIPPED state.rs comparison: ${detail}. The generated contract was still checked.`);
    return;
  }

  const constant = (name) => {
    const match = rust.match(new RegExp(`pub const ${name}: u8 = (\\d+);`));
    assert.ok(match !== null, `state.rs no longer defines ${name}`);
    return Number(match[1]);
  };

  const expected = {
    none: constant("VENUE_NONE"),
    velocity: constant("VENUE_VELOCITY"),
    "jupiter-perps": constant("VENUE_JUPITER_PERPS"),
    adrena: constant("VENUE_ADRENA"),
    "flash-trade": constant("VENUE_FLASH_TRADE"),
    simulated: constant("VENUE_SIMULATED"),
  };

  for (const [name, slot] of Object.entries(expected)) {
    assert.equal(VENUE_SLOTS[name], slot, `${name} must be slot ${slot}, as state.rs defines it`);
  }
  assert.equal(VENUE_ID_UNSET, expected.none, "the unset sentinel must be the program's VENUE_NONE");
  assert.equal(VENUE_ID_BASE, expected.velocity, "assignable ids must start where the program starts them");
  assert.equal(VENUE_ID_MAX_ASSIGNABLE, constant("VENUE_FLASH_TRADE"));

  // VENUE_FLAGS_MASK is a const fn over the ids, so recompute it the same way
  // rather than parsing an expression: bit n enables id n, bit 0 unused.
  let mask = 0;
  for (const slot of [expected.velocity, expected["jupiter-perps"], expected.adrena, expected["flash-trade"]]) {
    mask |= 1 << slot;
  }
  assert.equal(VENUE_FLAGS_MASK, mask, "the flags mask must be the bits the program assigns");
  assert.equal(mask & 1, 0, "bit 0 is permanently unused because id 0 is not a venue");

  t.diagnostic(`compared against ${statePath.pathname}`);
});

test("an unmapped venue name falls to the unset slot, never to a real venue", () => {
  // Every package in this system resolves an unknown string to 0. A typo or a
  // wound-down venue that picked up a plausible id would be attributed to a real
  // venue in a committed proof, which is the failure the 1-based numbering and
  // this rule exist to prevent.
  for (const name of ["zeta", "mango-v4", "mango", "drfit", "", "velocityy", "VENUE_1"]) {
    assert.equal(venueIdFromName(name), VENUE_ID_UNSET, `"${name}" must resolve to the unset slot`);
  }
  assert.equal(venueIdFromName("velocity"), VENUE_SLOTS.velocity);
  assert.equal(venueIdFromName("drift"), VENUE_SLOTS.velocity, "the rename alias is the same venue");
});
