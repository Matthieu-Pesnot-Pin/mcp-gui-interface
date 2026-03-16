# @imenam/mcp-gui-interface

Shared library for MCP GUI lifecycle management — spawning, IPC, proxy registration, and logging.

This package encapsulates the boilerplate every MCP server needs when it runs a companion GUI: spawning a child process safely, communicating with it over IPC, registering it with the central proxy, and logging without polluting stdout.

---

## Installation

```bash
npm install @imenam/mcp-gui-interface
```

No runtime dependencies. Requires Node.js with ESM support (`"type": "module"`).

---

## Why this library exists

MCP servers communicate with their host (Cursor, Claude Desktop, etc.) over **stdout** using JSON-RPC. Any `console.log` or stray output on stdout will corrupt the protocol and break the connection.

When an MCP server also needs to serve a GUI (typically an Express server), it must:

1. Spawn the GUI as a **separate child process** so its stdout doesn't pollute the parent's JSON-RPC channel.
2. Keep the two processes in sync via **typed IPC messages**.
3. **Register the GUI** with a central proxy so it can be reached at a predictable URL.
4. **Log safely** — always to stderr and/or a log file, never to stdout.

This library handles all four concerns.

---

## API Reference

### `GuiLauncher`

Spawns and supervises a GUI child process.

```typescript
import { GuiLauncher } from "@imenam/mcp-gui-interface";

const launcher = new GuiLauncher({
  guiPath: "./dist/gui.js",     // Path to the GUI entry point (forked with Node)
  env: { PORT: "3000" },        // Extra environment variables passed to the child
  maxRestarts: 3,               // Max auto-restarts on crash (default: 3)
  restartDelay: 2000,           // Delay in ms before restarting (default: 2000)
  onMessage: (msg) => {         // Optional callback for incoming IPC messages
    console.error("Received:", msg);
  },
});

launcher.start();
```

**Options (`GuiLauncherOptions`)**

| Property | Type | Default | Description |
|---|---|---|---|
| `guiPath` | `string` | — | Absolute or relative path to the GUI script to fork |
| `env` | `Record<string, string>` | `{}` | Additional env vars merged with `process.env` |
| `maxRestarts` | `number` | `3` | Maximum number of auto-restarts after unexpected crashes |
| `restartDelay` | `number` | `2000` | Milliseconds to wait before each restart attempt |
| `onMessage` | `(msg: IpcMessage) => void` | — | Callback invoked when the GUI sends an IPC message |

**Methods**

| Method | Returns | Description |
|---|---|---|
| `start()` | `ChildProcess` | Spawns (or re-spawns) the GUI process |
| `send(message)` | `boolean` | Fire-and-forget IPC message to the GUI |
| `getIpcHub()` | `IpcHub` | Access the underlying `IpcHub` for advanced usage |
| `getProcess()` | `ChildProcess \| null` | The current child process instance |
| `cleanup()` | `Promise<void>` | Gracefully terminates the GUI (SIGTERM → SIGKILL after 3s) |

The launcher automatically handles `SIGINT`, `SIGTERM`, and stdin `close` events so the GUI is always cleaned up when the MCP server exits.

---

### `IpcHub`

Typed IPC messaging between the MCP server (parent) and the GUI (child).

```typescript
import { IpcHub } from "@imenam/mcp-gui-interface";

// Parent side (access via GuiLauncher.getIpcHub())
const ipc = launcher.getIpcHub();

// Fire-and-forget
ipc.send({ type: "CONFIG_UPDATE", data: { theme: "dark" }, timestamp: new Date().toISOString() });

// Request/response with correlation ID and timeout
const response = await ipc.request({ type: "GET_STATUS" }, 3000);
console.error(response.data);

// Subscribe to all incoming messages
ipc.onMessage((msg) => {
  if (msg.type === "READY") console.error("GUI is ready");
});
```

**`IpcMessage` interface**

```typescript
interface IpcMessage {
  type: string;          // Message type identifier
  correlationId?: string; // Auto-set by request() for matching responses
  data?: any;            // Payload
  error?: string;        // Error description (used in error responses)
  timestamp: string;     // ISO 8601 timestamp
}
```

**Methods**

| Method | Description |
|---|---|
| `send(message)` | Sends a typed message. Returns `false` if the process is not connected. |
| `onMessage(callback)` | Subscribes to all incoming messages from the target process. |
| `request(message, timeout?)` | Sends a message and waits for a response with a matching `correlationId`. Rejects on timeout (default: 2000ms) or if the process is disconnected. |

---

### `ProxyClient`

Registers and unregisters the GUI with the central HTTP proxy ([`mcp-http-gateway`](https://github.com/Matthieu-Pesnot-Pin/mcp-http-gateway)).

```typescript
import { ProxyClient } from "@imenam/mcp-gui-interface";

const proxy = new ProxyClient("http://localhost:4242");

// Register — proxy allocates a port and returns it
const result = await proxy.register(
  { path: "/my-app", name: "my-app" },
  fallbackPort  // Used if proxy is unreachable
);

if (result.success) {
  console.error(`GUI available at port ${result.port}`);
} else {
  console.error(`Running on fallback port ${fallbackPort}`);
}

// Check current status
proxy.getStatus(); // "connected" | "fallback" | "error"

// Unregister on shutdown
await proxy.unregister();
```

**`RegisterOptions`**

| Property | Type | Description |
|---|---|---|
| `path` | `string` | The URL path to register (e.g. `/my-app`) |
| `name` | `string` | Optional display name for the app |
| `port` | `number` | Optional preferred port |

**`RegisterResult`**

| Property | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether registration succeeded |
| `port` | `number` | Allocated port (or `fallbackPort` on failure) |
| `url` | `string \| undefined` | Full URL returned by the proxy |
| `error` | `string \| undefined` | Error description on failure |

The proxy registration has a 1-second timeout. If the proxy is unreachable, `status` is set to `"fallback"` and the fallback port is used — the GUI still starts normally.

---

### `setupLogging` / `createLogger`

Safe logging for MCP servers, keeping stdout clean for JSON-RPC.

```typescript
import { setupLogging, createLogger } from "@imenam/mcp-gui-interface";

// Call once at startup in the MCP server process
setupLogging({
  processLabel: "MY-MCP",          // Label used in log file entries
  logDir: "./logs",                // Optional. Default: .mcp-gui/logs/
});

// Create scoped loggers anywhere in the codebase
const logger = createLogger("MyModule");

logger.info("Server started");
logger.warn("Config missing, using defaults");
logger.error("Failed to connect", { reason: "timeout" });
logger.debug("Verbose detail");
```

**What `setupLogging` does:**
- Redirects `console.log`, `console.info`, `console.warn` → `console.error` (protecting stdout).
- Patches `console.error` to also append every line to a rotating log file at `.mcp-gui/logs/server.log`.
- Log entries include ISO timestamp, PID, and process label.

**`SetupLoggingOptions`**

| Property | Type | Default | Description |
|---|---|---|---|
| `processLabel` | `string` | — | Label shown in log file lines |
| `logDir` | `string` | `.mcp-gui/logs` | Directory where `server.log` is written |

**Log format:**
```
[2026-03-10T12:00:00.000Z] [PID 1234] [MY-MCP] [INFO] [MyModule] Server started
```

---

## Complete usage example

Here is a typical MCP server that uses all four features:

```typescript
import { GuiLauncher, ProxyClient, setupLogging, createLogger } from "@imenam/mcp-gui-interface";

// 1. Safe logging (must be called first)
setupLogging({ processLabel: "MY-MCP" });
const logger = createLogger("Main");

// 2. Register the GUI with the proxy
const proxy = new ProxyClient(process.env.PROXY_URL ?? "http://localhost:4242");
const result = await proxy.register({ path: "/my-app", name: "my-app" }, 3001);
const port = result.port;

// 3. Launch the GUI child process
const launcher = new GuiLauncher({
  guiPath: new URL("./gui.js", import.meta.url).pathname,
  env: { PORT: String(port) },
  onMessage: (msg) => {
    if (msg.type === "READY") logger.info("GUI reported ready");
  },
});

launcher.start();
logger.info(`GUI process started on port ${port}`);

// 4. Two-way IPC: request data from the GUI
const ipc = launcher.getIpcHub();
const status = await ipc.request({ type: "GET_STATUS" });
logger.info("GUI status:", status.data);
```

---

## Type reference

All public types are exported from the package root:

```typescript
import type {
  GuiLauncherOptions,
  IpcMessage,
  RegisterOptions,
  RegisterResult,
  ProxyConfig,
  Logger,
  SetupLoggingOptions,
} from "@imenam/mcp-gui-interface";
```

---

## Development

```bash
# Build
npm run build

# Watch mode
npm run build:watch

# Release (patch bump, build, publish, push tag)
npm run release
```

The compiled output and type declarations are in `dist/`.

---

## License

ISC © [Matthieu Pesnot-Pin](https://github.com/Matthieu-Pesnot-Pin)
