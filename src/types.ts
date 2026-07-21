export interface IpcMessage {
  type: string;
  correlationId?: string;
  data?: any;
  error?: string;
  timestamp: string;
}

export interface ProxyConfig {
  proxyUrl?: string;
  appPath: string;
  appName: string;
  fallbackPort: number;
}

export interface RegisterResult {
  success: boolean;
  port: number;
  url?: string;
  error?: string;
}

export interface RegisterOptions {
  path: string;
  name?: string;
  port?: number;
}

export interface Logger {
  debug: (message: string, ...meta: unknown[]) => void;
  info: (message: string, ...meta: unknown[]) => void;
  warn: (message: string, ...meta: unknown[]) => void;
  error: (message: string, ...meta: unknown[]) => void;
}

export interface SetupLoggingOptions {
  processLabel: string;
  logDir?: string;
}

export interface GuiLauncherOptions {
  guiPath: string;
  env?: Record<string, string>;
  maxRestarts?: number;
  restartDelay?: number;
  onMessage?: (msg: IpcMessage) => void;
  /**
   * Optional hook invoked at the start of reconnect() before PROXY_URL is read.
   * Use it to reload the .env file (e.g. dotenv.config({ override: true }) or a
   * custom getConfig()) so a PROXY_URL added after startup is picked up.
   */
  reloadEnv?: () => void;
}

/** Runtime lifecycle state of the GUI worker, tracked from its IPC messages. */
export type GuiRuntimeStatus =
  | "disabled"
  | "starting"
  | "ready"
  | "already_running"
  | "stopped";

/** Structured outcome of a GuiLauncher.reconnect() call. */
export interface ReconnectResult {
  outcome:
    | "ready"
    | "already_running"
    | "exited"
    | "timeout"
    | "disabled"
    | "noop";
  url?: string;
  code?: number | null;
  /** Human-readable message suitable for returning to an MCP client. */
  message: string;
}

/** MCP tool result shape (structural — avoids depending on the MCP SDK types). */
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
