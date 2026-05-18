#!/usr/bin/env node
import { installSystemCas } from "./systemCa.js";
installSystemCas();
import { runCli } from "./program.js";
runCli(process.argv).then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
