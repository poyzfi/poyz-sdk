/**
 * Signing.
 *
 * The SDK builds transactions and hands them back unsigned by default, so an
 * integrating protocol signs with its own wallet and this package never sees a
 * secret key. Two signer shapes are accepted: the wallet-adapter shape a
 * browser already has, and a local keypair for a server or a CLI.
 *
 * No function here logs, serialises or returns a secret key. `keypairSigner`
 * holds the key in the closure and exposes only the public key and a signature.
 */

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { PoyzConfigError } from "./errors.js";

/** Signs a whole transaction. This is the shape a wallet adapter exposes. */
export interface PoyzTransactionSigner {
  readonly publicKey: string;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

/** Signs the serialized message and returns the 64 byte ed25519 signature. */
export interface PoyzMessageSigner {
  readonly publicKey: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Either signer shape is accepted everywhere the SDK asks for one. */
export type PoyzSigner = PoyzTransactionSigner | PoyzMessageSigner;

function isTransactionSigner(signer: PoyzSigner): signer is PoyzTransactionSigner {
  return typeof (signer as PoyzTransactionSigner).signTransaction === "function";
}

/**
 * Apply a signer to a transaction, whichever shape it is.
 *
 * @throws PoyzConfigError when the signer produced a signature that the
 *   transaction does not accept, which means the key does not match the fee
 *   payer the plan was built for.
 */
export async function signWith(
  signer: PoyzSigner,
  transaction: VersionedTransaction,
): Promise<VersionedTransaction> {
  if (isTransactionSigner(signer)) {
    return signer.signTransaction(transaction);
  }

  const signerKey = new PublicKey(signer.publicKey);
  const index = transaction.message.staticAccountKeys.findIndex((key) => key.equals(signerKey));
  if (index < 0 || index >= transaction.message.header.numRequiredSignatures) {
    throw new PoyzConfigError(
      `signer ${signer.publicKey} is not a required signer of this transaction; ` +
        "build the plan with that address as the fee payer",
    );
  }
  const signature = await signer.signMessage(transaction.message.serialize());
  if (signature.byteLength !== 64) {
    throw new PoyzConfigError(`signer returned a ${signature.byteLength} byte signature; expected 64`);
  }
  transaction.signatures[index] = signature;
  return transaction;
}

/**
 * Signer backed by a local ed25519 keypair.
 *
 * @param secretKey The 64 byte secret key. It is used to construct a keypair
 *   and is never stored, copied or printed by this SDK. Zero the caller's copy
 *   once the signer exists if the process keeps running.
 * @throws PoyzConfigError when the key is not a valid 64 byte secret key.
 */
export function keypairSigner(secretKey: Uint8Array): PoyzSigner & PoyzTransactionSigner {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(secretKey);
  } catch (cause) {
    throw new PoyzConfigError(
      "secretKey is not a valid 64 byte ed25519 secret key (the key itself is not included in this message)",
    );
  }
  const publicKey = keypair.publicKey.toBase58();

  return {
    publicKey,
    async signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
      transaction.sign([keypair]);
      return transaction;
    },
  };
}

/** The subset of a wallet-adapter wallet this SDK needs. */
export interface WalletAdapterLike {
  readonly publicKey: { toBase58(): string } | null;
  signTransaction<T extends VersionedTransaction>(transaction: T): Promise<T>;
}

/**
 * Adapt a connected wallet-adapter wallet to {@link PoyzSigner}.
 *
 * @throws PoyzConfigError when the wallet is not connected.
 */
export function walletAdapterSigner(wallet: WalletAdapterLike): PoyzTransactionSigner {
  const publicKey = wallet.publicKey;
  if (publicKey === null) {
    throw new PoyzConfigError("wallet is not connected: publicKey is null");
  }
  const address = publicKey.toBase58();
  return {
    publicKey: address,
    signTransaction: (transaction: VersionedTransaction) => wallet.signTransaction(transaction),
  };
}
