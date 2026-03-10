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
}
