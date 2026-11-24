// Runs the bridge CLI straight from source (the image has no built `dist`):
// `bun containers/tests/support/bridge-cli.ts <command> [args...]`.
import { main } from "../../../packages/cli/src/index.js";

process.exitCode = await main();
