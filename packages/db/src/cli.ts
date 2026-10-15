// `pnpm db:migrate`: applies migrations to $WEFT_DATA_DIR/weft.db (default .data).
import { resolve } from "node:path";
import { openDb, closeDb } from "./client";
import { migrate } from "./migrate";

const dataDir = resolve(process.env.WEFT_DATA_DIR ?? ".data");
const db = openDb({ dataDir });
try {
  await migrate(db);
  console.log(`migrated ${dataDir}/weft.db`);
} finally {
  await closeDb(db);
}
