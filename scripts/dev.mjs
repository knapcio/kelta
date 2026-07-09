import { build } from "./build.mjs";
import { startServer } from "./serve.mjs";

const result = await build();
console.log(
  `Built ${result.bindings} bindings and ${result.routes} delegated event routes.`,
);
startServer();
