# vela-facilitator-base-poc

Standalone PoC for exercising a **Horizen VELA** dev stack deployed on **Base Sepolia** , 
including the **vela-facilitator** (allowing gass-less submission of Vela request actions
and x402 private payments).

## Project structure

- [`smoketest/`](./smoketest) <br/>
  End-to-end dev-smoke script (`src/dev-smoke.ts`)
  that demos a full buyer/seller flow on-chain: fund → associate keys → deposit →
  verify/settle via x402 → withdraw → claim <br/>
  See [`smoketest/README.md`](./smoketest/README.md) for details.


