import { childMain } from "./child.js";

const code = await childMain(process.argv.slice(2));
process.exit(code);
