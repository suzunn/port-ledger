import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directories = ["src", "scripts", "test"];
const files = directories.flatMap((directory) =>
  fs
    .readdirSync(new URL(`../${directory}/`, import.meta.url))
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(directory, file)),
);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
