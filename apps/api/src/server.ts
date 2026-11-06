import Fastify from "fastify";
import { createServer } from "./createServer.js";
import { loadConfig } from "./config/env.js";

// Vercel's Fastify detector requires the entrypoint itself to import the framework.
void Fastify;

const config = loadConfig();
const app = await createServer(config);

void app.listen({
  host: config.host,
  port: config.apiPort
}).then(() => {
  console.log(`Paintopia API listening on http://${config.host}:${config.apiPort}`);
}).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
