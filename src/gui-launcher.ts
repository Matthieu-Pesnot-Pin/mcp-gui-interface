import { fork, ChildProcess } from "child_process";
import { createLogger } from "./logger.js";
import { IpcHub } from "./ipc-hub.js";
import type {
  GuiLauncherOptions,
  GuiRuntimeStatus,
  IpcMessage,
  McpToolResult,
  ReconnectResult,
} from "./types.js";

export type { GuiLauncherOptions };

const logger = createLogger("GuiLauncher");

const RECONNECT_TIMEOUT_MS = 15000;

/** Waiter resolved when the GUI worker confirms registration with the proxy. */
type StartWaiter = (result: {
  outcome: "ready" | "already_running";
  url?: string;
}) => void;

export class GuiLauncher {
  private guiProcess: ChildProcess | null = null;
  private ipcHub: IpcHub = new IpcHub();
  private restartCount = 0;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;

  private status: GuiRuntimeStatus = "disabled";
  private url: string | null = null;
  private startWaiter: StartWaiter | null = null;

  constructor(private readonly options: GuiLauncherOptions) {
    this.maxRestarts = options.maxRestarts ?? 0;
    this.restartDelay = options.restartDelay ?? 2000;

    this.registerSignalHandlers();
  }

  /** Current lifecycle state of the GUI worker. */
  getStatus(): GuiRuntimeStatus {
    return this.status;
  }

  /** URL the GUI is registered under, once known. */
  getUrl(): string | null {
    return this.url;
  }

  /**
   * Intercepts the GUI worker's lifecycle messages to keep local state in sync,
   * then forwards every message to the consumer's onMessage handler unchanged.
   */
  private handleMessage(msg: IpcMessage): void {
    if (msg.type === "ALREADY_RUNNING") {
      this.status = "already_running";
      this.url = msg.data?.url ?? this.url;
      this.startWaiter?.({ outcome: "already_running", url: msg.data?.url });
    } else if (msg.type === "READY") {
      this.status = "ready";
      this.url = msg.data?.url ?? null;
      this.startWaiter?.({ outcome: "ready", url: msg.data?.url });
    }
    this.options.onMessage?.(msg);
  }

  private registerSignalHandlers(): void {
    const syncCleanup = () => {
      this.guiProcess?.kill();
      this.guiProcess = null;
    };

    process.on("exit", syncCleanup);

    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.stdin.on("close", async () => {
      logger.info("stdin closed, shutting down.");
      await this.cleanup();
      process.exit(0);
    });
  }

  start(): ChildProcess {
    if (this.guiProcess) {
      this.guiProcess.kill();
    }

    logger.info(`Starting GUI process: ${this.options.guiPath}`);
    this.status = "starting";

    this.guiProcess = fork(this.options.guiPath, [], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
      env: { ...process.env, ...this.options.env },
    });
    const child = this.guiProcess;

    this.guiProcess.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    this.ipcHub = new IpcHub(this.guiProcess);
    this.ipcHub.onMessage((msg) => this.handleMessage(msg));

    this.guiProcess.on("exit", (code, signal) => {
      logger.info(`GUI process exited (code=${code}, signal=${signal})`);

      // A later start() replaces the current process: only the active process
      // exiting should flip state to "stopped". ALREADY_RUNNING means the GUI
      // lives in another instance, so this worker's exit is expected.
      if (this.guiProcess === child && this.status !== "already_running") {
        this.status = "stopped";
      }

      // Only auto-restart on unexpected crashes (code !== 0 and code !== null)
      const shouldRestart = code !== 0 && code !== null;
      if (shouldRestart && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        logger.warn(
          `Restarting GUI (attempt ${this.restartCount}/${this.maxRestarts}) in ${this.restartDelay}ms...`
        );
        setTimeout(() => this.start(), this.restartDelay);
      } else if (shouldRestart) {
        logger.error(`GUI crashed ${this.maxRestarts} times. Giving up.`);
      } else {
        this.restartCount = 0;
      }
    });

    this.guiProcess.on("error", (err) => {
      logger.error(`GUI process error: ${err.message}`);
    });

    logger.info(`GUI process started (PID ${this.guiProcess.pid})`);
    return this.guiProcess;
  }

  getProcess(): ChildProcess | null {
    return this.guiProcess;
  }

  getIpcHub(): IpcHub {
    return this.ipcHub;
  }

  send(message: Omit<IpcMessage, "timestamp">): boolean {
    return this.ipcHub.send({ ...message, timestamp: new Date().toISOString() });
  }

  /**
   * Relaunch the GUI worker and wait for it to re-register with the proxy.
   * Safe to call when the proxy was down at MCP startup: it re-reads PROXY_URL
   * (via the reloadEnv hook), relaunches the worker and resolves once the worker
   * confirms READY / ALREADY_RUNNING, exits, or the timeout elapses.
   */
  async reconnect(options?: {
    force?: boolean;
    timeoutMs?: number;
  }): Promise<ReconnectResult> {
    this.options.reloadEnv?.();

    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) {
      this.status = "disabled";
      return {
        outcome: "disabled",
        message:
          "PROXY_URL is not set — the GUI is disabled. Add PROXY_URL to the .env file, then call reconnect_gui again.",
      };
    }

    const child = this.guiProcess;
    const alive = !!child && child.exitCode === null && !child.killed;
    const force = options?.force === true;

    if (alive && !force) {
      if (this.status === "starting") {
        return {
          outcome: "noop",
          message:
            "GUI worker is already starting (proxy registration in progress). Wait a few seconds, then call reconnect_gui again if needed.",
        };
      }
      return {
        outcome: this.status === "already_running" ? "already_running" : "ready",
        url: this.url ?? undefined,
        message: `GUI is already registered with the proxy${
          this.url ? ` at ${this.url}` : ""
        }. Nothing to do (use force=true to restart it anyway).`,
      };
    }

    logger.info(
      `reconnect: ${alive ? "restarting (force)" : "relaunching"} GUI worker...`
    );

    const timeoutMs = options?.timeoutMs ?? RECONNECT_TIMEOUT_MS;

    return await new Promise<ReconnectResult>((resolve) => {
      const newChild = this.start();

      const cleanup = () => {
        clearTimeout(timer);
        newChild.off("exit", onExit);
        this.startWaiter = null;
      };

      const onExit = (code: number | null) => {
        cleanup();
        resolve({
          outcome: "exited",
          code,
          message: `GUI worker exited before completing registration (code=${code}). The proxy server is probably still unreachable at ${proxyUrl}. Start the proxy server, then call reconnect_gui again.`,
        });
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({
          outcome: "timeout",
          message: `GUI worker started but did not confirm proxy registration within ${Math.round(
            timeoutMs / 1000
          )}s. Check the logs, then retry.`,
        });
      }, timeoutMs);

      this.startWaiter = (r) => {
        cleanup();
        resolve({
          outcome: r.outcome,
          url: r.url,
          message:
            r.outcome === "ready"
              ? `GUI reconnected and registered with the proxy. URL: ${r.url}`
              : `GUI is already registered by another MCP instance. URL: ${
                  r.url ?? "unknown"
                }`,
        });
      };

      newChild.on("exit", onExit);
    });
  }

  /**
   * Runs reconnect() and adapts the result to the MCP tool-call return shape,
   * so a server can wire the `reconnect_gui` tool in a single line:
   *   case "reconnect_gui": return launcher.handleReconnectTool(args);
   */
  async handleReconnectTool(args?: {
    force?: boolean;
  }): Promise<McpToolResult> {
    const result = await this.reconnect({ force: args?.force === true });
    const isError =
      result.outcome === "disabled" ||
      result.outcome === "exited" ||
      result.outcome === "timeout";
    return {
      content: [{ type: "text", text: result.message }],
      ...(isError ? { isError: true } : {}),
    };
  }

  async cleanup(): Promise<void> {
    if (!this.guiProcess) return;

    logger.info("Cleaning up GUI process...");
    const proc = this.guiProcess;
    this.guiProcess = null;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });

    logger.info("GUI process cleaned up.");
  }
}

/**
 * Ready-made MCP tool definition for `reconnect_gui`. Spread it into your
 * server's tools list, then dispatch to `launcher.handleReconnectTool(args)`.
 */
export function reconnectGuiToolDefinition() {
  return {
    name: "reconnect_gui",
    description:
      "Relaunch the GUI worker and re-register it with the proxy server. Use this when the proxy server was not running when the MCP server started (so the GUI registration failed), to redeploy the GUI without restarting the MCP server. Does nothing if the GUI is already registered, unless force=true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        force: {
          type: "boolean",
          description:
            "Restart the GUI worker even if it is already running and registered (default: false)",
        },
      },
    },
  };
}
