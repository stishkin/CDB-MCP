# This code is 100% AI generated
- VS Code Github Copilot Agent Gemini 2.5 Pro (Preview)
- It actually seems to be working....

# CDB MCP Server

This project implements a Model Context Protocol (MCP) server that acts as a bridge to the Windows Debugger (CDB). It allows MCP-compatible clients (e.g., VS Code extensions) to interact with the debugger to perform actions like opening crash dumps, executing debugger commands, and attaching to processes.

This server is built using TypeScript and leverages the `@modelcontextprotocol/sdk`.

## Features

*   Open crash dump files (`.dmp`) in CDB.
*   Execute arbitrary CDB commands.
*   Attach CDB to running processes.
*   STDIO-based communication with MCP clients.

## Prerequisites

*   [Node.js](https://nodejs.org/) (which includes npm) - Version 18.x or later recommended.
*   A standalone CDB installation. Ensure `cdb.exe` is accessible, preferably in your system's PATH or configured within the server if needed (not currently implemented, assumes PATH).

## Installation

1.  Clone the repository (if you haven't already):
    ```bash
    git clone <repository-url>
    cd CDB-MCP
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```

## Building

To compile the TypeScript source code to JavaScript, run:

```bash
npm run build
```

This will output the compiled files to the `build` directory.

## Running the Server

There are multiple ways to run the MCP server:

1.  **Using npm (recommended for development):**
    ```bash
    npm run start
    ```
    This command executes `node ./build/index.js` as defined in `package.json`.

2.  **Directly with Node.js:**
    ```bash
    node ./build/index.js
    ```

3.  **Using the batch script (primarily for VS Code MCP integration):**
    ```bash
    .\run_mcp_server.bat
    ```
    This script changes to the project directory and then runs `node ./build/index.js` using an absolute path to Node.js (configurable in the script).

## Configuration

### For VS Code MCP Integration (`.vscode/mcp.json`)

If you are using this server with a VS Code extension that supports MCP, you'll typically configure it in a `.vscode/mcp.json` file within your workspace. An example configuration:

```jsonc
{
  "servers": {
    "cdb-mcp": {
      "type": "stdio",
      "command": "${workspaceFolder}/run_mcp_server.bat",
      "env": {}
    }
  }
}
```

*   `type: "stdio"`: Indicates the server communicates over standard input/output.
*   `command`: Specifies the command to launch the server. Using `${workspaceFolder}` makes the path relative to the VS Code workspace root.

### `run_mcp_server.bat`

This batch file is a helper to launch the server. It ensures the correct working directory and can be configured with a specific path to `node.exe` if it's not in the system PATH or if you need to use a particular Node.js version.

## Usage with an MCP Client

Once the server is running, an MCP client can connect to it. The server listens for JSON-RPC messages on stdin and sends responses/notifications to stdout.

### Available MCP Methods

The server exposes the following custom MCP methods (requests):

*   **`cdb/openCrashDump`**: Opens a crash dump file.
    *   Parameters: `{ path: string }`
    *   Example: `{"jsonrpc": "2.0", "method": "cdb/openCrashDump", "params": {"path": "C:\path\to\your\dump.dmp"}, "id": 1}`
*   **`cdb/executeCommand`**: Executes a CDB command.
    *   Parameters: `{ command: string }`
    *   Example: `{"jsonrpc": "2.0", "method": "cdb/executeCommand", "params": {"command": "!analyze -v"}, "id": 2}`
*   **`cdb/attachToProcess`**: Attaches the debugger to a running process.
    *   Parameters: `{ processId?: string, processName?: string }` (at least one must be provided)
    *   Example (by ID): `{"jsonrpc": "2.0", "method": "cdb/attachToProcess", "params": {"processId": "1234"}, "id": 3}`
    *   Example (by Name): `{"jsonrpc": "2.0", "method": "cdb/attachToProcess", "params": {"processName": "notepad.exe"}, "id": 4}`

(Note: The actual method names like `f1e.cdb/open-crash-dump` used by some clients might be specific to that client's mapping and not the direct MCP method name exposed by this server if it follows a different convention. The server-side handlers are currently named `f1e_cdb_open_crash_dump`, `f1e_cdb_execute_cdb_command`, etc. which implies the client might be sending requests like `f1e/cdb/openCrashDump`. This section should be updated if the server strictly adheres to a different naming convention for its MCP methods.)

## Available `package.json` Scripts

*   `npm run build`: Compiles the TypeScript code from `src` to `build`.
*   `npm run start`: Starts the MCP server by running the compiled `build/index.js`.
*   `npm test`: Currently displays an error message ("Error: no test specified").

## Project Structure

*   `src/`: Contains the TypeScript source code for the server.
    *   `index.ts`: The main entry point of the application.
*   `build/`: Contains the compiled JavaScript code (output of `npm run build`).
*   `node_modules/`: Contains project dependencies.
*   `.vscode/`: Contains VS Code specific settings.
    *   `mcp.json`: Example configuration for MCP client integration.
*   `package.json`: Defines project metadata, dependencies, and scripts.
*   `tsconfig.json`: TypeScript compiler configuration.
*   `run_mcp_server.bat`: Utility script to run the server.
*   `README.md`: This file.

## Troubleshooting

*   **"Failed to parse message" in client logs:** This server uses `console.error` for its own logging. If the MCP client strictly expects only JSON-RPC on stdout/stderr, these server logs might appear as parsing errors on the client side. These are generally for server-side diagnostics.
*   **CDB not found:** Ensure `cdb.exe` is in your system's PATH or modify the server logic/scripts to point to its explicit location.
*   **Node.js/npm not found:** Ensure Node.js is installed correctly and its `bin` directory is in your system PATH.

## License

This project is licensed under the ISC License. See the `package.json` for more details.
