import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`showcase listening on http://localhost:${PORT}`);
});
