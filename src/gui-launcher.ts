import { fork, ChildProcess } from "child_process";
import { createLogger } from "./logger.js";
import { IpcHub } from "./ipc-hub.js";
import type { GuiLauncherOptions, IpcMessage } from "./types.js";

export type { GuiLauncherOptions };

const logger = createLogger("GuiLauncher");

export class GuiLauncher {
  private guiProcess: ChildProcess | null = null;
  private ipcHub: IpcHub = new IpcHub();
  private restartCount = 0;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;

  constructor(private readonly options: GuiLauncherOptions) {
    this.maxRestarts = options.maxRestarts ?? 0;
    this.restartDelay = options.restartDelay ?? 2000;

    this.registerSignalHandlers();
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

    this.guiProcess = fork(this.options.guiPath, [], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
      env: { ...process.env, ...this.options.env },
    });

    this.guiProcess.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    this.ipcHub = new IpcHub(this.guiProcess);

    if (this.options.onMessage) {
      this.ipcHub.onMessage(this.options.onMessage);
    }

    this.guiProcess.on("exit", (code, signal) => {
      logger.info(`GUI process exited (code=${code}, signal=${signal})`);

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
