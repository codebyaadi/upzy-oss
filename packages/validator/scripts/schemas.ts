/**
 * Writes the contracts to `schemas/` (default) or, with --check, fails if they differ from the files on disk.
 *
 *   bun run schemas          rewrite
 *   bun run schemas:check    CI
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { generateSchemas } from "../src/json-schemas";

const dir = join(import.meta.dir, "../../../schemas");
const wanted = generateSchemas();
const check = process.argv.includes("--check");

if (check) {
  const problems: string[] = [];
  for (const [name, text] of Object.entries(wanted)) {
    const path = join(dir, name);
    if (!existsSync(path)) problems.push(`${name} is missing`);
    // Git may check files out with CRLF on Windows; the contents are the same.
    else if (readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== text)
      problems.push(`${name} is out of date`);
  }
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (!(name in wanted)) problems.push(`${name} is not generated any more`);
  if (problems.length) {
    console.error(`schemas/ does not match packages/validator:\n  ${problems.join("\n  ")}`);
    console.error("Run `bun run schemas` and commit the result.");
    process.exit(1);
  }
  console.log("schemas/ is up to date");
} else {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(wanted)) writeFileSync(join(dir, name), text);
  console.log(`wrote ${Object.keys(wanted).length} files to schemas/`);
}
