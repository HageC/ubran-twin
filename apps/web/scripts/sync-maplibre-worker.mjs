import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
const destination = resolve("public/maplibre-gl-worker.mjs");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
