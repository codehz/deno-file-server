import { Sha256 } from "https://deno.land/std@0.97.0/hash/sha256.ts";
import {
  extname,
  join,
  relative as relativePath,
  resolve as resolvePath,
  sep as pathSep,
} from "https://deno.land/std@0.97.0/path/mod.ts";
import { mime } from "https://deno.land/x/mimetypes@v1.0.0/mod.ts";
import { Accepts } from "https://deno.land/x/accepts@2.1.0/mod.ts";
import { exists } from "https://deno.land/std@0.97.0/fs/exists.ts";

import { parseRange, toReadableStream } from "./stream.ts";
import { ErrorWithStatusCode } from "./errors.ts";
import { applyDirectTemplate } from "./dtemp.ts";

export interface Config {
  port: number;
  hostname: string;
  tls?: {
    cert: string;
    key: string;
  };
  root: string;
  rescanTimeout: number;
  cors?: string;
}

const encoder = new TextEncoder();

class CacheEntry {
  path: string;
  #expires: number;

  constructor(path: string, timeout: number) {
    this.path = path;
    this.#expires = new Date().getTime() + timeout;
  }

  expired() {
    return new Date().getTime() > this.#expires;
  }

  static async cache(path: string, timeout: number): Promise<CacheEntry> {
    const info = await Deno.lstat(path);
    if (info.isFile) {
      const hasher = new Sha256();
      const block = new Uint8Array(4096);
      const file = await Deno.open(path, { read: true });
      let fullsize = 0;
      try {
        let size: number | null;
        while ((size = await file.read(block))) {
          fullsize += size;
          const slice = block.slice(0, size);
          hasher.update(slice);
        }
      } finally {
        file.close();
      }
      const hash = hasher.hex();
      return new FileCacheEntry(path, timeout, hash, fullsize);
    } else if (info.isDirectory) {
      const dir = Deno.readDir(path);
      const list: BasicFileInfo[] = [];
      for await (const entry of dir) {
        try {
          const stat = await Deno.lstat(join(path, entry.name));
          const birthtime = stat.birthtime?.getTime() ?? -1;
          const mtime = stat.mtime?.getTime() ?? -1;
          list.push({
            kind: entry.isFile
              ? FileKind.File
              : entry.isDirectory
              ? FileKind.Folder
              : FileKind.Symlink,
            filename: entry.name,
            birthtime,
            mtime,
            size: stat.size,
            mode: stat.mode ?? -1,
            nlink: stat.nlink ?? -1,
          });
        } catch {
          // ignore illegal file entry
        }
      }
      return new FolderCacheEntry(path, timeout, list);
    } else {
      const target = await Deno.readLink(path);
      return new SymlinkCacheEntry(path, timeout, target);
    }
  }
}

enum FileKind {
  File,
  Folder,
  Symlink,
}

interface BasicFileInfo {
  filename: string;
  birthtime: number;
  mtime: number;
  kind: FileKind;
  size: number;
  mode: number;
  nlink: number;
}

class FileCacheEntry extends CacheEntry {
  hash: string;
  size: number;

  constructor(path: string, timeout: number, hash: string, size: number) {
    super(path, timeout);
    this.hash = hash;
    this.size = size;
  }

  get contents() {
    return Deno.readFile(this.path);
  }

  get text() {
    return Deno.readTextFile(this.path);
  }

  get file() {
    return Deno.open(this.path, { read: true });
  }
}

class FolderCacheEntry extends CacheEntry {
  list: BasicFileInfo[];

  constructor(path: string, timeout: number, list: BasicFileInfo[]) {
    super(path, timeout);
    this.list = list;
  }
}

class SymlinkCacheEntry extends CacheEntry {
  target: string;

  constructor(path: string, timeout: number, target: string) {
    super(path, timeout);
    this.target = target;
  }
}

export class FileServer {
  #config: Config;
  #server: Deno.Listener;
  #cache: Map<string, CacheEntry> = new Map();
  #template_cache: WeakMap<FileCacheEntry, string[]> = new WeakMap();

  constructor(config: Config) {
    this.#config = config;
    this.#config.root = resolvePath(this.#config.root);
    if (config.tls) {
      this.#server = Deno.listenTls({
        certFile: config.tls.cert,
        keyFile: config.tls.key,
        port: config.port,
        hostname: config.hostname,
        alpnProtocols: ["h2", "http/1.1"],
      });
    } else {
      this.#server = Deno.listen({
        port: config.port,
        hostname: config.hostname,
      });
    }
  }

  private headerMixin(): Record<string, string> {
    return this.#config.cors
      ? {
        "Access-Control-Allow-Origin": this.#config.cors,
        "Access-Control-Allow-Headers": "Accept, Range",
        "Access-Control-Request-Methods": "OPTIONS, GET, HEAD",
        "Access-Control-Expose-Headers": "X-File-Hash, Location",
      }
      : {};
  }

  private handleOptions(_event: Deno.RequestEvent): Response {
    return new Response(null, {
      status: 200,
      headers: {
        Allow: "OPTIONS, GET, HEAD",
        ...this.headerMixin(),
      },
    });
  }

  private async cache(path: string): Promise<CacheEntry> {
    const got = this.#cache.get(path);
    if (got != undefined) {
      if (!got.expired()) {
        return Promise.resolve(got);
      }
      this.#cache.delete(path);
    }
    const entry = await CacheEntry.cache(path, this.#config.rescanTimeout);
    this.#cache.set(path, entry);
    return entry;
  }

  private async cacheTemplate(path: string): Promise<string[]> {
    const cached = await this.cache(path);
    if (cached instanceof FileCacheEntry) {
      const occ = this.#template_cache.get(cached);
      if (occ) {
        return occ;
      }
      const text = await cached.text;
      const lines = text.split(/\n\r?/g);
      this.#template_cache.set(cached, lines);
      return lines;
    }
    throw new Error("invalid template");
  }

  private async handleGet(
    event: Deno.RequestEvent,
    head = false,
  ): Promise<Response> {
    const url = new URL(decodeURI(event.request.url));
    const pathname = decodeURIComponent(url.pathname);
    const stripedPathname = pathname.replaceAll(/(?!^\/)\/*$/g, "");
    const path = join(this.#config.root, stripedPathname);
    console.log("access", path);
    const cache = await this.cache(path);
    if (cache instanceof SymlinkCacheEntry) {
      const rel = relativePath(
        this.#config.root,
        join(path, "..", cache.target),
      );
      if (pathSep != "/") url.pathname = rel.replaceAll(pathSep, "/");
      else url.pathname = rel;
      return new Response(null, {
        status: 302,
        statusText: "Follow Symlink",
        headers: {
          "Location": url.toString(),
          "Accept-Ranges": "none",
          ...this.headerMixin(),
        },
      });
    } else if (cache instanceof FileCacheEntry) {
      const type = mime.getType(extname(path)) ?? "application/octet-stream";
      if (head) {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Type": type,
            "Content-Length": cache.size + "",
            "X-File-Hash": cache.hash,
            "Accept-Ranges": "bytes",
            ...this.headerMixin(),
          },
        });
      } else {
        if (event.request.headers.has("Range")) {
          const range = parseRange(event.request.headers.get("Range")!);
          const file = await cache.file;
          const diff =
            Math.min(range.end ?? Number.MAX_SAFE_INTEGER, cache.size - 1) -
            range.start;
          if (diff < 0) {
            return new Response(null, {
              status: 206,
              headers: {
                "Content-Range": `bytes */${cache.size}`,
                "Content-Type": type,
                "Accept-Ranges": "bytes",
                ...this.headerMixin(),
              },
            });
          }
          return new Response(await toReadableStream(file, range), {
            status: 206,
            headers: {
              "Content-Type": type,
              "Content-Range": `bytes ${range.start}-${range.start +
                diff}/${cache.size}`,
              "Content-Length": diff + 1 + "",
              "Accept-Ranges": "bytes",
              ...this.headerMixin(),
            },
          });
        } else {
          const file = await cache.file;
          return new Response(await toReadableStream(file), {
            status: 200,
            headers: {
              "Content-Type": type,
              "Content-Length": cache.size + "",
              "X-File-Hash": cache.hash,
              "Accept-Ranges": "bytes",
              ...this.headerMixin(),
            },
          });
        }
      }
    } else if (cache instanceof FolderCacheEntry) {
      const folderPath = stripedPathname.replace(/(?!^)(?<!\/)$/, "/");
      if (pathname !== folderPath) {
        url.pathname = folderPath;
        return new Response(null, {
          status: 302,
          headers: {
            "Location": url.toString(),
            "Accept-Ranges": "none",
            ...this.headerMixin(),
          },
        });
      }
      const body = {
        path: folderPath,
        list: cache.list,
      };
      const accept = new Accepts(event.request.headers);
      let type = accept.types(["json", "html"]);
      type = type === false || url.searchParams.has("json")
        ? "json"
        : typeof type === "string"
        ? type
        : type[0];
      if (type === "json") {
        const list = encoder.encode(JSON.stringify(body));
        return new Response(head ? null : list, {
          status: 200,
          headers: {
            "Content-Length": list.byteLength + "",
            "Content-Type": "application/json",
            "Accept-Ranges": "none",
            ...this.headerMixin(),
          },
        });
      } else {
        const indexpath = await (async () => {
          if (cache.list.some((info) => info.filename == "index.html")) {
            return join(path, "index.html");
          } else if (await exists(join(this.#config.root, "index.html"))) {
            return join(this.#config.root, "index.html");
          } else {
            throw new Deno.errors.NotFound("No index file");
          }
        })();
        const html = applyDirectTemplate(
          await this.cacheTemplate(indexpath),
          body,
        );
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "Accept-Ranges": "none",
            ...this.headerMixin(),
          },
        });
      }
    }
    throw "not implemented";
  }

  private processEvent(event: Deno.RequestEvent): Promise<Response> | Response {
    switch (event.request.method) {
      case "OPTIONS":
        return this.handleOptions(event);
      case "HEAD":
        return this.handleGet(event, true);
      case "GET":
        return this.handleGet(event);
      default:
        return new Response("Only support HEAD/GET/OPTIONS", {
          status: 405,
          statusText: "Method Not Allowed",
        });
    }
  }

  private async processConnection(conn: Deno.Conn) {
    const httpConn = Deno.serveHttp(conn);
    for await (const event of httpConn) {
      try {
        await event.respondWith(await this.processEvent(event));
      } catch (e) {
        if (e instanceof Deno.errors.Http) {
          continue;
        } else if (e instanceof Deno.errors.NotFound) {
          await event.respondWith(
            new Response(e + "", { status: 404 }),
          );
        } else if (e instanceof Deno.errors.PermissionDenied) {
          await event.respondWith(
            new Response(e + "", { status: 403 }),
          );
        } else if (e instanceof ErrorWithStatusCode) {
          await event.respondWith(
            new Response(e + "", { status: e.code }),
          );
        } else {
          await event.respondWith(
            new Response(e + "", { status: 500 }),
          );
        }
        console.warn(e);
      }
    }
  }

  async run() {
    console.log(
      `listen on ${this.#config.hostname}:${this.#config.port} serve ${this.#config.root}`,
    );
    while (true) {
      try {
        for await (const conn of this.#server) {
          this.processConnection(conn).catch(console.error);
        }
      } catch (e) {
        console.log(e);
      }
    }
  }
}
