import {
  createPublicClient,
  custom,
  getAddress,
  isAddress,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";

export function nativeTransferClient(provider: Parameters<typeof custom>[0]) {
  return createPublicClient({
    chain: base,
    transport: custom(provider),
  }).extend(publicActionsL2());
}
export type NativeTransferClient = ReturnType<typeof nativeTransferClient>;
export type NativeTransfer = {
  from: Address;
  to: Address;
  value: string;
  nonce: number;
  feeReserve: string;
  balance: string;
  hash?: Hex;
};

export function nativeTransferInput(
  from: string,
  recipient: string,
  amount: string,
) {
  if (!isAddress(from) || !isAddress(recipient.trim()))
    throw new Error("Enter a valid recipient address on Base.");
  const to = getAddress(recipient.trim());
  if (to === zeroAddress)
    throw new Error("The zero address cannot receive this payment.");
  if (!/^(?:\d+)(?:\.\d{1,18})?$/.test(amount.trim()))
    throw new Error("Enter an ETH amount with at most 18 decimal places.");
  const value = parseEther(amount.trim());
  if (value <= 0n) throw new Error("Enter an ETH amount greater than zero.");
  return { account: getAddress(from), to, value, data: "0x" as const };
}

export async function prepareNativeTransfer(
  client: NativeTransferClient,
  from: string,
  recipient: string,
  amount: string,
): Promise<NativeTransfer> {
  const tx = nativeTransferInput(from, recipient, amount);
  if ((await client.getChainId()) !== base.id)
    throw new Error("Switch your wallet to Base before sending ETH.");
  const [balance, nonce, fee] = await Promise.all([
    client.getBalance({ address: tx.account, blockTag: "pending" }),
    client.getTransactionCount({ address: tx.account, blockTag: "pending" }),
    client.estimateTotalFee(tx),
  ]);
  const feeReserve = fee * 2n;
  if (balance < tx.value + feeReserve)
    throw new Error(
      "Not enough ETH for this amount plus network fees. Send a smaller amount.",
    );
  return {
    from: tx.account,
    to: tx.to,
    value: tx.value.toString(),
    nonce,
    feeReserve: feeReserve.toString(),
    balance: balance.toString(),
  };
}

export async function verifyNativeTransfer(
  client: NativeTransferClient,
  transfer: NativeTransfer,
  hash: Hex,
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("Enter a valid transaction hash.");
  if ((await client.getChainId()) !== base.id)
    throw new Error("Switch your wallet to Base.");
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  if (
    tx.from.toLowerCase() !== transfer.from.toLowerCase() ||
    tx.to?.toLowerCase() !== transfer.to.toLowerCase() ||
    tx.value !== BigInt(transfer.value) ||
    tx.nonce !== transfer.nonce ||
    tx.input !== "0x"
  )
    throw new Error(
      "This transaction does not match the reviewed ETH transfer.",
    );
  return receipt.status === "success";
}

export function isWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: number; cause?: unknown };
  return e.code === 4001 || (e.cause !== error && isWalletRejection(e.cause));
}
