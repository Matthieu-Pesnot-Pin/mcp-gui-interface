import fs from "fs";
import path from "path";
import { inspect } from "util";
import type { Logger, SetupLoggingOptions } from "./types.js";

let loggingInitialized = false;
let currentProcessLabel = "PROCESS";
let logStream: fs.WriteStream | null = null;
let consoleErrorPatched = false;
let originalConsoleError: typeof console.error = console.error;

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, { depth: 5, breakLength: 120, compact: true });
}

function serializeArgs(args: unknown[]): string {
  return args.map((arg) => serialize(arg)).join(" ");
}

function writeToFile(message: string): void {
  if (!logStream) return;
  const entry = `[${new Date().toISOString()}] [PID ${process.pid}] [${currentProcessLabel}] ${message}\n`;
  logStream.write(entry);
}

function ensureConsoleErrorPatched(): void {
  if (consoleErrorPatched) return;

  originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    writeToFile(serializeArgs(args));
    originalConsoleError(...(args as Parameters<typeof console.error>));
  };
  consoleErrorPatched = true;
}

function normalizeMessage(message: string, meta: unknown[]): string {
  if (meta.length === 0) return message;
  return `${message} ${serializeArgs(meta)}`;
}

export function setupLogging(options: SetupLoggingOptions): void {
  if (loggingInitialized) return;

  currentProcessLabel = options.processLabel;

  const resolvedLogDir = options.logDir ?? path.join(process.cwd(), ".mcp-gui", "logs");

  fs.mkdirSync(resolvedLogDir, { recursive: true });
  const logFilePath = path.join(resolvedLogDir, "server.log");
  logStream = fs.createWriteStream(logFilePath, { flags: "a", encoding: "utf8" });

  logStream.on("error", (error) => {
    originalConsoleError(`Critical: Failed to write to log file: ${serialize(error)}`);
  });

  ensureConsoleErrorPatched();

  // Redirect console.log/info/warn to console.error to protect stdout
  // which is reserved for the MCP JSON-RPC protocol in the MASTER process.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);

  loggingInitialized = true;
  writeToFile("[INFO] [LOGGER] Logging system initialized");
}

export function createLogger(scope: string): Logger {
  const logWithLevel = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, ...meta: unknown[]) => {
    console.error(`[${level}] [${scope}] ${normalizeMessage(message, meta)}`);
  };

  return {
    debug: (message: string, ...meta: unknown[]) => logWithLevel("DEBUG", message, ...meta),
    info: (message: string, ...meta: unknown[]) => logWithLevel("INFO", message, ...meta),
    warn: (message: string, ...meta: unknown[]) => logWithLevel("WARN", message, ...meta),
    error: (message: string, ...meta: unknown[]) => logWithLevel("ERROR", message, ...meta),
  };
}
