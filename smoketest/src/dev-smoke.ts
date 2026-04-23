/**
 * Dev smoke script for the vela-facilitator.
 *
 * End-to-end flow against an already-running facilitator + vela dev stack:
 *   1. Generate fresh Ethereum wallets + P-521 keypairs for buyer and seller.
 *   2. Funder transfers AMOUNT tokens to the buyer via a standard ERC-20 transfer
 *      (the funder account must already hold at least AMOUNT tokens).
 *   3. Buyer ASSOCIATEKEY + Seller ASSOCIATEKEY via POST /submit.
 *   4. Buyer deposits AMOUNT tokens via POST /submit (PROCESS + EIP-2612 permit).
 *   5. Buyer builds PaymentPayload; Seller calls /verify + /settle via the
 *      standard HTTPFacilitatorClient. The facilitator's /settle now blocks
 *      until the TEE emits the AppEvent whose eventSubType hash binds
 *      invoiceId + sender + token + amount + recipient — so a 200 response
 *      proves the transfer landed in the TEE exactly as specified.
 *   6. Seller withdraws AMOUNT via POST /submit (PROCESS with encrypted withdraw payload).
 *   7. Seller CLAIM: POST /claim to release the pending withdrawal into the seller's wallet.
 *   8. Verify the seller's on-chain ERC-20 balance grew by AMOUNT, and read the
 *      seller's encrypted events from the subgraph + decrypt them to confirm the
 *      final private balance is 0.
 *
 * Prerequisites (not performed here):
 *   - ProcessorEndpoint, TeeAuthenticator, and an EIP-2612-capable ERC-20 token
 *     deployed on the chain, and the token must be allowlisted on the
 *     ProcessorEndpoint for the app.
 *     (all this are already managed if using the vela dev environment deployer)
 *   - nova app must be deployed into vela (APPLICATION_ID  must correspond to the application id deployed).
 *     Be sure to enalbe the TOKEN in nova by setting  the --allowed-tokens parameter in the nova deploy command
 *   - Funder account funded with ETH (pays gas for the transfer tx) AND holding
 *     at least AMOUNT of the target ERC-20 token.
 *   - Facilitator account funded with ETH for gas.
 *   - Subgraph is running and indexing the processor.
 *
 * Env vars (all required — see .env.template for the Base Sepolia values):
 *   FACILITATOR_URL              vela-facilitator HTTP endpoint
 *   CHAIN_RPC_PROTOCOL           JSON-RPC protocol (http/https)
 *   CHAIN_RPC_ADDRESS            JSON-RPC host
 *   CHAIN_RPC_PORT               JSON-RPC port
 *   CHAIN_PROCESSOR_ADDRESS      ProcessorEndpoint contract address
 *   TEE_AUTHENTICATOR_ADDRESS    TeeAuthenticator contract address (TEE P-521 pubkey is read from it)
 *   TOKEN_ADDRESS                ERC-20 (EIP-2612) token address
 *   FUNDER_PRIVATE_KEY           must hold AMOUNT of the token and ETH for gas
 *   APPLICATION_ID               vela-nova application id
 *   SUBGRAPH_URL                 subgraph GraphQL endpoint
 *   AMOUNT                       deposit/transfer/withdraw amount (smallest token unit)
 *
 * Run:
 *   pnpm dev:smoke
 */

import { ethers } from "ethers";
import {
  generateKeyPair,
  exportPublicKeyToHex,
  hexToBytes,
  bytesToString,
  importPublicKeyFromHex,
  VelaClient,
  createSubgraphClient,
  fetchAndDecryptUserEvents,
} from "@horizen/vela-common-ts";
import {
  FacilitatorHelper,
  REQUEST_TYPE_ASSOCIATEKEY,
  REQUEST_TYPE_PROCESS,
  registerPrivateVelaFixedClient,
} from "@horizen/x402-private-vela-fixed";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name} (see .env.template)`);
  }
  return v;
}

const POLLING_INTERVAL_MS = 2_000;
const POLLING_TIMEOUT_MS = 60_000;

// ERC-20 ABI: transfer() to fund the buyer, balanceOf() for assertions.
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll chain for the RequestCompleted event matching `requestId` via VelaClient.
 * Mirrors the vela-nova wallet's WaitForRequestCompleted pattern.
 */
async function waitForRequestCompleted(
  velaClient: VelaClient,
  provider: ethers.JsonRpcProvider,
  requestId: string,
  label: string,
): Promise<void> {
  // Bound the eth_getLogs range: many public RPCs (e.g. Base Sepolia) cap it at
  // ~10k blocks. Using the block at submission time as lower bound is safe since
  // RequestCompleted is emitted only after the request is submitted.
  // NOTE: vela-common-ts@0.1.0 internally swaps fromBlock/toBlock when calling
  // queryFilter, so we pass our lower-bound value as the `toBlock` argument.
  const lowerBound = Math.max(0, (await provider.getBlockNumber()) - 10);
  const deadline = Date.now() + POLLING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLLING_INTERVAL_MS));
    const result = await velaClient.getRequestCompletedEvent(requestId, undefined, lowerBound);
    if (result) {
      if (result.status !== 0n) {
        throw new Error(
          `${label} request failed on-chain: status=${result.status} ` +
          `errorCode=${result.errorCode} errorMessage="${result.errorMessage}"`,
        );
      }
      return;
    }
  }
  throw new Error(
    `Polling timeout (${POLLING_TIMEOUT_MS / 1000}s) waiting for RequestCompleted for ${requestId}.`,
  );
}

/**
 * Register a user's P-521 public key via ASSOCIATEKEY through the facilitator.
 */
async function associateKey(
  client: FacilitatorHelper,
  velaClient: VelaClient,
  provider: ethers.JsonRpcProvider,
  publicKey: CryptoKey,
  applicationId: bigint,
  label: string,
): Promise<void> {
  const pubKeyHex = await exportPublicKeyToHex(publicKey);
  const rawPayload = hexToBytes(pubKeyHex);
  const res = await client.submit({
    requestType: REQUEST_TYPE_ASSOCIATEKEY,
    payload: rawPayload,
    assetAmount: 0n,
    applicationId,
  });
  if (res.status !== 200) {
    throw new Error(`${label} ASSOCIATEKEY failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const reqId = res.body.requestId as string;
  console.log(`      ${label}: requestId=${reqId}, waiting...`);
  await waitForRequestCompleted(velaClient, provider, reqId, `${label} ASSOCIATEKEY`);
  console.log(`      ${label}: ASSOCIATEKEY completed.`);
}

function buildFacilitatorHelper(opts: {
  wallet: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  contractAddress: string;
  tokenAddress: string;
  chainId: number;
  teePublicKeyHex: string;
  facilitatorUrl: string;
  applicationId: bigint;
  p521PrivateKey: CryptoKey;
}): FacilitatorHelper {
  return new FacilitatorHelper({
    wallet: opts.wallet,
    provider: opts.provider,
    contractAddress: opts.contractAddress,
    tokenAddress: opts.tokenAddress,
    chainId: opts.chainId,
    teePublicKeyHex: opts.teePublicKeyHex,
    facilitatorUrl: opts.facilitatorUrl,
    applicationId: opts.applicationId,
    buyerP521PrivateKey: opts.p521PrivateKey,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- env --------------------------------------------------------------
  const facilitatorUrl = requireEnv("FACILITATOR_URL");
  const rpcProtocol = requireEnv("CHAIN_RPC_PROTOCOL");
  const rpcAddress = requireEnv("CHAIN_RPC_ADDRESS");
  const rpcPort = requireEnv("CHAIN_RPC_PORT");
  const rpcUrl = `${rpcProtocol}://${rpcAddress}:${rpcPort}`;
  const contractAddress = requireEnv("CHAIN_PROCESSOR_ADDRESS");
  const teeAuthenticatorAddress = requireEnv("TEE_AUTHENTICATOR_ADDRESS");
  const tokenAddress = requireEnv("TOKEN_ADDRESS");
  const funderPrivateKey = requireEnv("FUNDER_PRIVATE_KEY");
  const applicationId = BigInt(requireEnv("APPLICATION_ID"));
  const subgraphUrl = requireEnv("SUBGRAPH_URL");
  const amount = BigInt(requireEnv("AMOUNT"));


  // --- infrastructure ---------------------------------------------------
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const chainId = Number((await provider.getNetwork()).chainId);
  const funder = new ethers.Wallet(funderPrivateKey, provider);
  const funderVelaClient = new VelaClient(funder, false, teeAuthenticatorAddress, contractAddress);

  const tokenAsFunder = new ethers.Contract(tokenAddress, ERC20_ABI, funder);
  const tokenReader = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  // Read the TEE P-521 public key directly from the TeeAuthenticator contract
  const teeAuth = new ethers.Contract(
    teeAuthenticatorAddress,
    ["function getPubSecp521r1() view returns (bytes)"],
    provider,
  );
  const teePublicKeyHex: string = await teeAuth.getPubSecp521r1();
  const teePublicKey = await importPublicKeyFromHex(teePublicKeyHex);

  // --- participants -----------------------------------------------------
  // Fresh Ethereum wallets + P-521 keypairs (generated per-run).
  // Wrap the HDNodeWallet in a plain `ethers.Wallet` since FacilitatorHelper requires the latter.
  const buyerWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  const sellerWallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  const buyerKeyPair = await generateKeyPair();
  const sellerKeyPair = await generateKeyPair();

  const buyerClient = buildFacilitatorHelper({
    wallet: buyerWallet, provider, contractAddress, tokenAddress, chainId,
    teePublicKeyHex, facilitatorUrl, applicationId,
    p521PrivateKey: buyerKeyPair.privateKey,
  });
  const sellerClient = buildFacilitatorHelper({
    wallet: sellerWallet, provider, contractAddress, tokenAddress, chainId,
    teePublicKeyHex, facilitatorUrl, applicationId,
    p521PrivateKey: sellerKeyPair.privateKey,
  });

  console.log(`\n=== dev-smoke ===`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`RPC:         ${rpcUrl} (chainId=${chainId})`);
  console.log(`Token:       ${tokenAddress}`);
  console.log(`Funder:      ${funder.address}`);
  console.log(`Buyer:       ${buyerWallet.address}`);
  console.log(`Seller:      ${sellerWallet.address}`);
  console.log(`AppId:       ${applicationId}`);
  console.log(`AMOUNT:    ${amount} (deposit/transfer/withdraw)`);

  // --- preflight: funder must have ETH (gas) and >= AMOUNT of the token --
  console.log(`\n[0] Preflight: funder balances`);
  const [funderEthBal, funderTokenBal] = await Promise.all([
    provider.getBalance(funder.address),
    tokenReader.balanceOf(funder.address) as Promise<bigint>,
  ]);
  console.log(`    ETH:   ${ethers.formatEther(funderEthBal)}`);
  console.log(`    Token: ${funderTokenBal}`);
  if (funderEthBal === 0n) {
    throw new Error(
      `Funder ${funder.address} has 0 ETH — cannot pay gas. Fund it with ETH before running.`,
    );
  }
  if (funderTokenBal < amount) {
    throw new Error(
      `Funder ${funder.address} has insufficient token balance: ${funderTokenBal} < ${amount}. ` +
      `Fund it with at least ${amount} of ${tokenAddress} before running.`,
    );
  }

  // --- sanity: /supported ------------------------------------------------
  console.log(`\n[1] GET /supported`);
  const supported = await buyerClient.supported();
  if (supported.status !== 200) {
    throw new Error(`GET /supported failed: ${supported.status} ${JSON.stringify(supported.body)}`);
  }
  console.log(`    -> ${JSON.stringify(supported.body)}`);

  // --- step 2: funder transfers AMOUNT tokens to the buyer --------------
  console.log(`\n[2] Funder transfer -> Buyer (${amount} tokens)`);
  const transferTx = await tokenAsFunder.transfer(buyerWallet.address, amount);
  await transferTx.wait();
  console.log(`    tx: ${transferTx.hash}`);

  const buyerBalInitial: bigint = await tokenReader.balanceOf(buyerWallet.address);
  const sellerBalInitial: bigint = await tokenReader.balanceOf(sellerWallet.address);
  console.log(`    buyer balance:  ${buyerBalInitial}`);
  console.log(`    seller balance: ${sellerBalInitial}`);

  // --- step 3: ASSOCIATEKEY for buyer & seller --------------------------
  console.log(`\n[3] ASSOCIATEKEY (buyer + seller)`);
  await associateKey(buyerClient, funderVelaClient, provider, buyerKeyPair.publicKey, applicationId, "buyer");
  await associateKey(sellerClient, funderVelaClient, provider, sellerKeyPair.publicKey, applicationId, "seller");

  // --- step 4: Buyer deposits AMOUNT ----------------------------------
  console.log(`\n[4] Buyer DEPOSIT ${amount} tokens`);
  const depositRes = await buyerClient.submit({
    requestType: REQUEST_TYPE_PROCESS,
    payload: new Uint8Array(0), // deposit has an empty payload
    tokenAddress,
    assetAmount: amount,
    applicationId,
  });
  if (depositRes.status !== 200) {
    throw new Error(`Deposit /submit failed: ${depositRes.status} ${JSON.stringify(depositRes.body)}`);
  }
  const depositReqId = depositRes.body.requestId as string;
  console.log(`    requestId=${depositReqId}, waiting...`);
  await waitForRequestCompleted(funderVelaClient, provider, depositReqId, "DEPOSIT");
  console.log(`    deposit completed.`);

  // --- step 5: x402 transfer Buyer -> Seller ----------------------------
  // Buyer uses the standard x402Client.createPaymentPayload() with our
  // registered scheme — no custom wrapper. The seller uses its own
  // HTTPFacilitatorClient, wrapped by VerifyingFacilitatorClient so that
  // settle() only returns success=true once the TEE has processed the request
  // AND the decrypted transfer_received event matches the PaymentRequirements.
  console.log(`\n[5] x402 TRANSFER Buyer -> Seller (${amount} tokens)`);
  const network = `eip155:${chainId}` as `${string}:${string}`;
  const requirements: PaymentRequirements = {
    scheme: "private-vela-fixed",
    network,
    asset: tokenAddress,
    amount: amount.toString(),
    payTo: sellerWallet.address,
    maxTimeoutSeconds: 60,
    extra: { invoiceId: `INV-SMOKE-${Date.now()}` },
  };

  // Buyer-side: standard x402Client + registered scheme. skipOnchainDeposit=true
  // because the buyer already deposited in step [4] — this is a pure private-state
  // transfer (assetAmount=0 on-chain, no permit).
  const buyerX402 = new x402Client();
  await registerPrivateVelaFixedClient(buyerX402, {
    signer: buyerWallet,
    p521PrivateKey: buyerKeyPair.privateKey,
    teePublicKey,
    rpcUrl,
    contractAddress,
    applicationId,
    skipOnchainDeposit: true,
  });
  // In a real flow, `paymentRequired` comes from the seller's 402 response.
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "x402://dev-smoke" },
    accepts: [requirements],
  };
  const payment = await buyerX402.createPaymentPayload(paymentRequired);

  // Seller-side: plain HTTPFacilitatorClient is enough now — the facilitator's
  // /settle blocks until the TEE AppEvent arrives with the expected hash.
  const sellerFacilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

  const verifyResult = await sellerFacilitator.verify(payment, requirements);
  if (!verifyResult.isValid) {
    throw new Error(
      `/verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage}`,
    );
  }
  console.log(`    /verify -> isValid=true`);

  const settleResult = await sellerFacilitator.settle(payment, requirements);
  if (!settleResult.success) {
    throw new Error(
      `/settle failed: ${settleResult.errorReason} ${settleResult.errorMessage}`,
    );
  }
  const settleExt = settleResult.extensions as Record<string, unknown> | undefined;
  console.log(`    /settle + TEE confirmation OK.`);
  console.log(`      requestId=${settleExt?.requestId} eventSubType=${settleExt?.eventSubType}`);

  // --- step 6: Seller withdraws AMOUNT --------------------------------
  console.log(`\n[6] Seller WITHDRAW ${amount} tokens`);
  const withdrawPayload = await sellerClient.buildWithdrawPayload({
    to: sellerWallet.address,
    amount: amount.toString(),
    tokenAddress,
  });
  const withdrawRes = await sellerClient.submit({
    requestType: REQUEST_TYPE_PROCESS,
    payload: withdrawPayload,
    assetAmount: 0n,
    applicationId,
  });
  if (withdrawRes.status !== 200) {
    throw new Error(`Withdraw /submit failed: ${withdrawRes.status} ${JSON.stringify(withdrawRes.body)}`);
  }
  const withdrawReqId = withdrawRes.body.requestId as string;
  console.log(`    requestId=${withdrawReqId}, waiting...`);
  await waitForRequestCompleted(funderVelaClient, provider, withdrawReqId, "WITHDRAW");
  console.log(`    withdraw completed.`);

  // --- step 7: Seller CLAIM pending balance ----------------------------
  // The withdraw puts tokens in `pendingClaims[token][seller]` on-chain; the seller must
  // call claim() to move them into its wallet. Anyone can trigger it (funds always go to
  // the seller), so we use the facilitator's permissionless /claim endpoint.
  console.log(`\n[7] Seller CLAIM pending balance`);
  const claimRes = await sellerClient.claim({ tokenAddress, payee: sellerWallet.address });
  if (claimRes.status !== 200) {
    throw new Error(`/claim failed: ${claimRes.status} ${JSON.stringify(claimRes.body)}`);
  }
  console.log(claimRes);
  const claimedAmount = claimRes.body.amount as string;
  console.log(`    /claim -> tx=${claimRes.body.txHash} amount=${claimedAmount}`);
  if (BigInt(claimedAmount) !== amount) {
    throw new Error(
      `Claim amount mismatch: expected ${amount}, got ${claimedAmount}`,
    );
  }

  // --- step 8: verify seller's on-chain balance ------------------------
  console.log(`\n[8] Verify seller balance`);
  const sellerBalFinal: bigint = await tokenReader.balanceOf(sellerWallet.address);
  console.log(`    seller on-chain balance: ${sellerBalInitial} -> ${sellerBalFinal}`);
  if (sellerBalFinal !== sellerBalInitial + amount) {
    throw new Error(
      `Seller balance mismatch: expected ${sellerBalInitial + amount}, got ${sellerBalFinal}`,
    );
  }
  console.log(`    seller balance increased by AMOUNT (${amount}) as expected.`);

  // Decrypt seller's private events via subgraph to confirm private-state changes.
  // We don't filter by `eventSubType`:
  //   * the vela-nova WASM leaves EventSubType unset (zero bytes) expecting the
  //     executor to override it with a privacy-preserving HMAC derived from the
  //     user's seed (registered via ASSOCIATEKEY with 226-byte payload);
  //   * this smoke test registers ASSOCIATEKEY with just the P-521 pubkey (133
  //     bytes, no seed), so on-chain events end up with eventSubType=0x00..00
  //     regardless of the logical type ("transfer_received", "withdrawal").
  // Instead, we pull all events for the applicationId and let decryption drop
  // the ones not intended for the seller. The logical type is then read from
  // the JSON body (the `type` field below).
  console.log(`\n[9] Decrypt seller's events via subgraph`);
  const subgraph = createSubgraphClient(subgraphUrl);
  const sellerDecrypted = await fetchAndDecryptUserEvents(
    subgraph,
    teePublicKey,
    sellerKeyPair.privateKey,
    applicationId,
    undefined, // requestId — no filter
    [],        // eventSubType — no filter (see comment above)
    0,         // limit (0 = no cap)
  );
  const sellerEvents = sellerDecrypted.map((b) => JSON.parse(bytesToString(b)));
  console.log(`    decrypted ${sellerEvents.length} events for seller:`);
  for (const ev of sellerEvents) {
    console.log(`      ${JSON.stringify(ev)}`);
  }
  const withdrawalEv = sellerEvents.find((e) => e.type === "withdrawal");
  if (!withdrawalEv) {
    throw new Error(`Seller has no decrypted withdrawal event`);
  }
  if (BigInt(withdrawalEv.balance) !== 0n) {
    throw new Error(
      `Seller private balance after withdraw should be 0, got ${withdrawalEv.balance}`,
    );
  }
  console.log(`    seller private balance after withdraw: 0 (all withdrawn).`);

  console.log(`\nAll steps OK.\n`);
}

main().catch((err) => {
  console.error("\nSmoke failed:", err);
  process.exit(1);
});
