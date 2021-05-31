import { Config as FileServerConfig, FileServer } from "./serve.ts";
import { parse } from "https://deno.land/std@0.97.0/flags/mod.ts";

const args = parse(Deno.args);

const cfg: FileServerConfig = {
  port: args.port ?? 80,
  hostname: args.hostname ?? "127.0.0.1",
  root: args.root ?? ".",
  rescanTimeout: args.timeout ?? 1000 * 60,
  cors: args.cors,
};

if (args.tls) {
  if (typeof args.cert != "string" || typeof args.key != "string") {
    throw new Error("Invalid tls configuration");
  }
}

const server = new FileServer(cfg);

await server.run();
