# showcase

Minimal Node.js webapp that only serves a bounch of descriptive landing
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
- `public/index.html` — step by step explanation of how the system works
- `public/privacy.html` — privacy diagram
- `public/styles.css` — styles (Horizen Labs palette)
