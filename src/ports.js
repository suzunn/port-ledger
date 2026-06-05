import net from "node:net";

/**
 * Check whether a TCP port can be bound on the requested host.
 *
 * @param {number} port - TCP port to probe.
 * @param {string} [host="127.0.0.1"] - Host interface used for the probe.
 * @returns {Promise<boolean>} True when the port is available.
 */
export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host, exclusive: true });
  });
}
