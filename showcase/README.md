# showcase

Minimal Node.js webapp that will host the interactive demo of the
vela-facilitator (x402 private payments on Base Sepolia).

Right now it only serves a descriptive landing
page describing the process.

## Run

```bash
cd showcase
pnpm install
pnpm start
# -> http://localhost:3001
```

Use `pnpm dev` for auto-reload (`node --watch`).

Override the port with `PORT=4000 pnpm start`.

## Structure

- `server.js` — tiny Express server serving `public/`
- `public/index.html` — homepage
- `public/styles.css` — styles (Horizen Labs palette)
