// Every download this server makes (re-uploading files, backing up chart images) goes through here, with limits:
// HTTPS only, no private or local network addresses (checked on the address actually connected to, so a DNS answer
// can't be swapped between the check and the connection), a few redirects at most, a size cap, and a timeout.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export interface SafeFetchOptions {
  /** Largest body accepted, in bytes. */
  maxBytes?: number;
  /** For the whole download, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Plain http:// (tests, or hosts the user chose explicitly). */
  allowHttp?: boolean;
  /** Tests only: addresses to allow although they're private (such as a local test server). */
  allowAddress?: (address: string) => boolean;
  /** Tests only: replace DNS. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

export interface SafeFetchResult {
  status: number;
  contentType: string | null;
  body: Uint8Array;
  /** Where the body came from after redirects. */
  url: string;
}

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Addresses a download must never reach: this machine, private networks, link-local (cloud metadata), and the like. */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, including 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }
  if (net.isIPv6(address)) {
    const x = address.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || /^fe[89ab]/.test(x) || x.startsWith("ff") || x.startsWith("64:ff9b");
  }
  return true;
}

function blocked(address: string, opts: SafeFetchOptions): boolean {
  return isBlockedAddress(address) && !opts.allowAddress?.(address);
}

function guardedLookup(opts: SafeFetchOptions): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    const resolve = opts.lookup ? opts.lookup(hostname) : dns.promises.lookup(hostname, { all: true, verbatim: true });
    resolve.then(
      (addrs) => {
        const allowed = addrs.filter((a) => !blocked(a.address, opts));
        if (!allowed.length) {
          callback(new FetchBlockedError(`${hostname} resolves to a private or local address (${addrs.map((a) => a.address).join(", ")}); downloads can't reach those.`), "", 4);
          return;
        }
        if (options.all) callback(null, allowed.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, allowed[0].address, allowed[0].family);
      },
      (e: NodeJS.ErrnoException) => callback(e, "", 4)
    );
  }) as LookupFunction;
}

function checkUrl(raw: string, opts: SafeFetchOptions): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError(`Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new FetchBlockedError(`Only https:// downloads are allowed (got ${url.protocol}).`);
  }
  if (url.username || url.password) throw new FetchBlockedError("URLs with credentials aren't downloaded.");
  // A literal IP skips DNS, so check it here too.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && blocked(host, opts)) {
    throw new FetchBlockedError(`${host} is a private or local address; downloads can't reach it.`);
  }
  return url;
}

// agent: false: a fresh connection every time, so no pooled socket skips the address check.
function once(url: URL, opts: SafeFetchOptions, deadline: number, maxBytes: number): Promise<{ status: number; location?: string; contentType: string | null; body?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "GET", agent: false, lookup: guardedLookup(opts), headers: { "user-agent": "notion-plus-mcp-server", accept: "*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = res.headers["content-type"]?.split(";")[0].trim() ?? null;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, location: res.headers.location, contentType });
        return;
      }
      const declared = Number(res.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        reject(new FetchBlockedError(`The file is ${declared} bytes, over the ${maxBytes}-byte limit.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new FetchBlockedError(`The download passed the ${maxBytes}-byte limit and was stopped.`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, contentType, body: new Uint8Array(Buffer.concat(chunks)) }));
      res.on("error", reject);
    });
    const left = deadline - Date.now();
    if (left <= 0) {
      req.destroy();
      reject(new FetchBlockedError("The download timed out."));
      return;
    }
    req.setTimeout(left, () => req.destroy(new FetchBlockedError(`The download took longer than ${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s and was stopped.`)));
    req.on("error", reject);
    req.end();
  });
}

/** Download a URL within the limits above. Non-2xx statuses are returned, not thrown. */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let url = checkUrl(raw, opts);
  for (let hop = 0; ; hop++) {
    const r = await once(url, opts, deadline, maxBytes);
    if (r.location) {
      if (hop >= maxRedirects) throw new FetchBlockedError(`More than ${maxRedirects} redirects; stopped.`);
      url = checkUrl(new URL(r.location, url).toString(), opts);
      continue;
    }
    return { status: r.status, contentType: r.contentType, body: r.body ?? new Uint8Array(), url: url.toString() };
  }
}
