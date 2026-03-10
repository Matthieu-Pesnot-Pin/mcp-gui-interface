import { ChildProcess } from "child_process";
import { createLogger } from "./logger.js";
import type { IpcMessage } from "./types.js";

export type { IpcMessage };

const logger = createLogger("IpcHub");

export class IpcHub {
  private targetProcess: ChildProcess | null = null;

  constructor(targetProcess?: ChildProcess) {
    if (targetProcess) {
      this.targetProcess = targetProcess;
    }
  }

  setTargetProcess(targetProcess: ChildProcess): void {
    this.targetProcess = targetProcess;
  }

  send(message: IpcMessage): boolean {
    if (this.targetProcess && this.targetProcess.connected) {
      try {
        return this.targetProcess.send(message) ?? false;
      } catch (err: any) {
        logger.error(`Failed to send message: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  onMessage(callback: (msg: IpcMessage) => void): void {
    if (this.targetProcess) {
      this.targetProcess.on("message", (msg: any) => {
        if (msg && typeof msg === "object" && "type" in msg) {
          callback(msg as IpcMessage);
        }
      });
    }
  }

  async request(
    message: Omit<IpcMessage, "timestamp" | "correlationId">,
    timeout = 2000
  ): Promise<IpcMessage> {
    if (!this.targetProcess || !this.targetProcess.connected) {
      throw new Error("IPC target process not connected");
    }

    const correlationId = Math.random().toString(36).substring(7);
    const fullMessage: IpcMessage = {
      ...message,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.targetProcess?.off("message", handler);
        reject(new Error(`IPC request timed out after ${timeout}ms`));
      }, timeout);

      const handler = (msg: any) => {
        if (msg && msg.correlationId === correlationId) {
          clearTimeout(timer);
          this.targetProcess?.off("message", handler);
          resolve(msg as IpcMessage);
        }
      };

      this.targetProcess?.on("message", handler);
      const sent = this.send(fullMessage);
      if (!sent) {
        clearTimeout(timer);
        this.targetProcess?.off("message", handler);
        reject(new Error("Failed to send IPC message"));
      }
    });
  }
}
