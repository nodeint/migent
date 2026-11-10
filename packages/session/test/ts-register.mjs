// Lets a child `node` process import the kernel's TypeScript sources, which name each other as `.js`.
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
