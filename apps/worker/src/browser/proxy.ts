import { randomBytes } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";

/*
 * Everything the browser requests goes through this proxy, one per check. It is what keeps a monitored page from
 * reaching private addresses: the proxy resolves each host itself, refuses anything that is not a public address,
 * and connects to the address it checked, so a name that changes its answer between the check and the connection
 * (DNS rebinding) gains nothing. Redirects, images, scripts and WebSockets all pass through it the same way.
 * HTTPS is tunnelled untouched (CONNECT): nothing here reads or changes a page.
 */

export interface EgressProxy {
  port: number;
  /** Sent by the browser as proxy credentials, so only this check's browser can use the proxy. */
  username: string;
  password: string;
  /** Hosts the browser asked for that were refused. */
  blocked: Set<string>;
  close(): void;
}

/** The public address to connect to for a host, or null when it must not be reached. */
export type ResolveHost = (host: string) => Promise<string | null>;

const MAX_HEAD = 16_384;
const IDLE_MS = 60_000;

function hostPort(target: string, fallbackPort: number): { host: string; port: number } | null {
  const m = target.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? target.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : fallbackPort;
  return port >= 1 && port <= 65_535 ? { host: m[1]!, port } : null;
}

const deny = (client: Socket, status: string) => {
  // A 407 must say how to authenticate, or the browser shows it as the page instead of retrying with credentials.
  const challenge = status.startsWith("407") ? 'Proxy-Authenticate: Basic realm="upzy"\r\n' : "";
  client.end(`HTTP/1.1 ${status}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`);
};

export async function startEgressProxy(resolve: ResolveHost): Promise<EgressProxy> {
  const blocked = new Set<string>();
  const sockets = new Set<Socket>();
  const username = "upzy";
  const password = randomBytes(16).toString("hex");
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
    s.setTimeout(IDLE_MS, () => s.destroy());
  };

  const server = createServer((client) => {
    track(client);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > MAX_HEAD) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      void handle(buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4)).catch(() =>
        client.destroy(),
      );
    };

    async function handle(head: string, rest: Buffer) {
      const [line, ...headers] = head.split("\r\n");
      const [method, target, version] = (line ?? "").split(" ");
      if (!method || !target || !version) return deny(client, "400 Bad Request");
      const auth = headers.find((h) => /^proxy-authorization:/i.test(h));
      if (auth?.slice(auth.indexOf(":") + 1).trim() !== expected)
        return deny(client, "407 Proxy Authentication Required");

      let dest: { host: string; port: number } | null;
      let path = "";
      if (method === "CONNECT") {
        dest = hostPort(target, 443);
      } else {
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          return deny(client, "400 Bad Request");
        }
        if (url.protocol !== "http:") return deny(client, "400 Bad Request");
        dest = hostPort(url.host, 80);
        path = `${url.pathname}${url.search}`;
      }
      if (!dest) return deny(client, "400 Bad Request");

      const address = await resolve(dest.host);
      if (!address) {
        blocked.add(dest.host);
        return deny(client, "403 Forbidden");
      }
      const up = connect({ host: address, port: dest.port });
      track(up);
      up.once("error", () => client.destroy());
      up.once("close", () => client.destroy());
      client.once("close", () => up.destroy());
      up.once("connect", () => {
        if (method === "CONNECT") {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } else {
          // One request per connection: the simplest way to be sure the next request is checked too.
          const kept = headers.filter((h) => !/^(proxy-[a-z-]+|connection|keep-alive):/i.test(h));
          up.write(
            `${method} ${path || "/"} ${version}\r\n${kept.join("\r\n")}\r\nConnection: close\r\n\r\n`,
          );
        }
        if (rest.length > 0) up.write(rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
    }

    client.on("data", onData);
  });

  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    server.listen(0, "0.0.0.0", ok);
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    username,
    password,
    blocked,
    close() {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}
