# vela-facilitator-base-poc

Standalone PoC for exercising a **Horizen VELA** dev stack deployed on **Base Sepolia** , 
including the **vela-facilitator** (with the x402 private payment extension).

## Project structure

- [`smoketest/`](./smoketest) <br/>
  End-to-end dev-smoke script (`src/dev-smoke.ts`)
  that runs the full buyer/seller flow: fund → associate keys → deposit →
  verify/settle via x402 → withdraw → claim → on-chain + subgraph assertions.<br/>
  See [`smoketest/README.md`](./smoketest/README.md) for details.


