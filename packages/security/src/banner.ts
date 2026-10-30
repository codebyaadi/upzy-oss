import { connect as tcpConnect } from "node:net";

/**
 * The first bytes a service sends. Services that speak first (SSH, FTP, SMTP, MySQL) are read as they are; if the
 * port stays silent and a command was given, it is sent once and the answer is read. At most 1 KB, 4 s in all.
 * The caller has already checked that the address is public.
 */
export function readBanner(address: string, port: number, send?: string): Promise<string | null> {
  return new Promise((ok) => {
    const socket = tcpConnect({ host: address, port, timeout: 4_000 });
    const chunks: Buffer[] = [];
    let size = 0;
    let sent = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(settle);
      clearTimeout(wait);
      clearTimeout(overall);
      socket.destroy();
      ok(size ? Buffer.concat(chunks).subarray(0, 1024).toString("latin1") : null);
    };
    const overall = setTimeout(finish, 4_000);
    socket.once("connect", () => {
      wait = setTimeout(() => {
        if (size === 0 && send !== undefined && !sent) {
          sent = true;
          socket.write(send);
          wait = setTimeout(finish, 1_500);
        } else finish();
      }, 1_500);
    });
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      clearTimeout(wait);
      clearTimeout(settle);
      // The rest of the greeting usually follows within a moment.
      if (size >= 1024) finish();
      else settle = setTimeout(finish, 300);
    });
    socket.once("error", finish);
    socket.once("timeout", finish);
    socket.once("close", finish);
  });
}
