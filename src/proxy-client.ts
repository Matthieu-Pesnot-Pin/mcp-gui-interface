import http from "http";
import { createLogger } from "./logger.js";
import type { RegisterOptions, RegisterResult } from "./types.js";

export type { RegisterOptions, RegisterResult };

const logger = createLogger("ProxyClient");

export class ProxyClient {
  private registeredPath?: string;
  private status: "connected" | "fallback" | "error" = "error";

  constructor(private proxyUrl: string) {}

  getStatus(): "connected" | "fallback" | "error" {
    return this.status;
  }

  async register(options: RegisterOptions, fallbackPort: number): Promise<RegisterResult> {
    this.registeredPath = options.path;

    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(`${this.proxyUrl}/proxy/register`.replace(/\/+/g, "/").replace(":/", "://"));
      } catch {
        logger.error(`Invalid Proxy URL: ${this.proxyUrl}`);
        this.status = "error";
        return resolve({ success: false, port: fallbackPort, error: "Invalid Proxy URL" });
      }

      const timeout = 1000;
      logger.info(`Sending registration request to ${url.href}...`);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeout,
        },
        (res) => {
          logger.info(`Received response: HTTP ${res.statusCode}`);
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              try {
                const raw = JSON.parse(data);
                if (
                  raw &&
                  typeof raw === "object" &&
                  typeof raw.port === "number"
                ) {
                  logger.info(`Registration verified. Allocated port: ${raw.port}`);
                  this.status = "connected";
                  resolve({ success: true, port: raw.port, url: raw.url });
                } else {
                  logger.error(`Invalid proxy response schema: ${data}`);
                  this.status = "fallback";
                  resolve({ success: false, port: fallbackPort, error: "Invalid proxy response schema" });
                }
              } catch {
                logger.error(`JSON parse error: ${data}`);
                this.status = "fallback";
                resolve({ success: false, port: fallbackPort, error: "Invalid JSON response" });
              }
            } else {
              logger.error(`Registration rejected with HTTP ${res.statusCode}`);
              this.status = "fallback";
              resolve({ success: false, port: fallbackPort, error: `HTTP ${res.statusCode}` });
            }
          });
        }
      );

      req.on("error", (err) => {
        logger.error(`Registration error: ${err.message}`);
        this.status = "fallback";
        resolve({ success: false, port: fallbackPort, error: err.message });
      });

      req.on("timeout", () => {
        logger.error(`Registration timeout after ${timeout}ms`);
        req.destroy();
        this.status = "fallback";
        resolve({ success: false, port: fallbackPort, error: "Timeout" });
      });

      req.write(JSON.stringify(options));
      req.end();
    });
  }

  async unregister(): Promise<boolean> {
    if (!this.registeredPath) return true;

    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(`${this.proxyUrl}/proxy/unregister`.replace(/\/+/g, "/").replace(":/", "://"));
      } catch {
        return resolve(false);
      }

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          timeout: 2000,
        },
        (res) => {
          logger.info(`Unregister response: HTTP ${res.statusCode}`);
          resolve(res.statusCode === 200);
        }
      );

      req.on("error", (err) => {
        logger.error(`Unregister error: ${err.message}`);
        resolve(false);
      });

      req.write(JSON.stringify({ path: this.registeredPath }));
      req.end();
    });
  }
}
