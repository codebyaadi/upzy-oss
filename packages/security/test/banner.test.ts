import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import { readBanner } from "../src/banner";

let server: Server | undefined;
afterEach(() => server?.close());

const listen = (onConnect: (s: Socket) => void) =>
  new Promise<number>((ok) => {
    server = createServer(onConnect).listen(0, "127.0.0.1", () =>
      ok((server!.address() as { port: number }).port),
    );
  });

describe("readBanner", () => {
  test("reads the greeting of a service that speaks first, without sending anything", async () => {
    let got = "";
    const port = await listen((s) => {
      s.on("data", (d) => (got += d));
      s.write("SSH-2.0-OpenSSH_8.2p1 Ubuntu\r\n");
    });
    expect(await readBanner("127.0.0.1", port, "INFO server\r\n")).toBe(
      "SSH-2.0-OpenSSH_8.2p1 Ubuntu\r\n",
    );
    expect(got).toBe("");
  });

  test("a silent service gets the one command, and its answer is read", async () => {
    let got = "";
    const port = await listen((s) =>
      s.on("data", (d) => {
        got += d;
        s.write("VERSION 1.6.9\r\n");
      }),
    );
    expect(await readBanner("127.0.0.1", port, "version\r\n")).toBe("VERSION 1.6.9\r\n");
    expect(got).toBe("version\r\n");
  });

  test("a silent service with no command to send is left alone", async () => {
    let got = "";
    const port = await listen((s) => s.on("data", (d) => (got += d)));
    expect(await readBanner("127.0.0.1", port)).toBeNull();
    expect(got).toBe("");
  });

  test("a closed port is null", async () => {
    const port = await listen(() => {});
    server!.close();
    expect(await readBanner("127.0.0.1", port)).toBeNull();
  });

  test("never returns more than a kilobyte, however much the service sends", async () => {
    const port = await listen((s) => s.write("A".repeat(50_000)));
    const b = await readBanner("127.0.0.1", port);
    expect(b!.length).toBeGreaterThan(0);
    expect(b!.length).toBeLessThanOrEqual(1024);
  });
});
