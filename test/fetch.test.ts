// Download limits against a local server, with DNS replaced so hostnames can point anywhere. No internet.
import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { FetchBlockedError, isBlockedAddress, safeFetch, type SafeFetchOptions } from "../src/services/fetch.js";

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/ok") return void res.writeHead(200, { "content-type": "image/png; x=1" }).end("hello");
    if (u.pathname === "/big") return void res.writeHead(200).end(Buffer.alloc(5000));
    if (u.pathname === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (u.pathname === "/to-private") return void res.writeHead(302, { location: "http://10.0.0.5/secret" }).end();
    if (u.pathname === "/to-evil") return void res.writeHead(302, { location: `http://evil.test:${port}/ok` }).end();
    if (u.pathname === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Only the local test server is reachable; "evil.test" resolves to a private address. */
const opts = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  allowHttp: true,
  allowAddress: (a) => a === "127.0.0.1",
  lookup: async (host) => [{ address: host === "evil.test" ? "10.1.2.3" : "127.0.0.1", family: 4 }],
  ...extra,
});
const url = (p: string) => `http://files.test:${port}${p}`;

test("isBlockedAddress covers local, private, link-local, and mapped addresses", () => {
  for (const a of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "52.95.110.1", "2606:4700::1111"]) assert.equal(isBlockedAddress(a), false, a);
});

test("downloads within limits, and reports the content type", async () => {
  const r = await safeFetch(url("/ok"), opts());
  assert.equal(r.status, 200);
  assert.equal(r.contentType, "image/png");
  assert.equal(Buffer.from(r.body).toString(), "hello");
});

test("refuses http by default, literal private IPs, and hosts that resolve privately", async () => {
  await assert.rejects(safeFetch(url("/ok"), { ...opts(), allowHttp: false }), /Only https/);
  await assert.rejects(safeFetch("https://169.254.169.254/latest/meta-data", opts()), FetchBlockedError);
  await assert.rejects(safeFetch(`http://evil.test:${port}/ok`, opts()), /private or local/);
  // Without the test allowance, the local server itself is off limits.
  await assert.rejects(safeFetch(url("/ok"), { ...opts(), allowAddress: undefined }), /private or local/);
});

test("redirects are re-checked at every hop and limited", async () => {
  await assert.rejects(safeFetch(url("/to-private"), opts()), /private or local/);
  await assert.rejects(safeFetch(url("/to-evil"), opts()), /private or local/);
  await assert.rejects(safeFetch(url("/loop"), opts()), /More than 5 redirects/);
});

test("size and time limits stop the download", async () => {
  await assert.rejects(safeFetch(url("/big"), opts({ maxBytes: 1000 })), /limit/);
  await assert.rejects(safeFetch(url("/slow"), opts({ timeoutMs: 300 })), /longer than|timed out/);
});
