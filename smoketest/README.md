## Quick start

```bash
cd smoketest
cp .env.template .env
# edit .env and set FUNDER_PRIVATE_KEY to the private key of an address
# that holds both USDC (Base Sepolia) and some ETH for gas
pnpm install
pnpm dev:smoke
```

Use`smoketest/.env.template` as the starting point — the other defaults point at
the vela dev stack on Base Sepolia (facilitator URL, processor/authenticator
addresses, USDC token, nova `APPLICATION_ID`, subgraph URL) and should not be
changed.

### Prerequisites

- `FUNDER_PRIVATE_KEY` (set in your `smoketest/.env`) funded with Base Sepolia
  ETH **and** holding at least `AMOUNT` of the configured ERC-20 (USDC by
  default).

See the header comment in [`smoketest/src/dev-smoke.ts`](./smoketest/src/dev-smoke.ts)
for the full step-by-step description of the flow and all env vars.
