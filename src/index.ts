import { randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; 
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, ChildProcess } from "child_process";
import * as fs from 'fs'; // Import fs module

import { InitializeRequest, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const PORT = 3001;

// Logger functions to send messages via MCP
function logInfo(message: string) {
    console.error(`[INFO] ${message}`);
}

function logWarn(message: string) {
    console.error(`[WARN] ${message}`);
}

function logError(message: string) {
    console.error(`[ERROR] ${message}`);
}

function formatCdbToolError(error: Error, operationDescription: string): string {
    const lowerCaseMessage = error.message.toLowerCase();
    let specificReason = "";

    if (lowerCaseMessage.includes("enoent")) {
        specificReason = "cdb.exe (or the specified debuggerPath) was not found (ENOENT).";
    } else if (lowerCaseMessage.includes("failed to start cdb process with any of the attempted paths") || lowerCaseMessage.includes("all attempts failed")) {
        specificReason = "Failed to start the CDB process with any of the attempted paths.";
    } else if (lowerCaseMessage.includes("timeout waiting for initial prompt")) {
        specificReason = "Timeout waiting for the initial prompt from CDB. The process might have started but became unresponsive or exited prematurely.";
    }

    if (specificReason) {
        return `Error ${operationDescription}: ${specificReason} Please ensure CDB (cdb.exe) is installed correctly, accessible via your system's PATH, or that a valid 'debuggerPath' is provided if cdb.exe is in a non-standard location. CDB.exe is typically included with the Windows SDK or Windows Driver Kit (WDK), available from Microsoft. Original error: ${error.message}`;
    }
    // Default fallback message if no specific condition is met
    return `Error ${operationDescription}: An unexpected error occurred. ${error.message}`;
}

let cdbProcess: ChildProcess | null = null;
let commandInProgress = false;
let currentCommandCompletion: { resolve: (output: string) => void, reject: (error: Error) => void } | null = null;
let outputBuffer = "";

const CDB_PROMPT_REGEX = /(\b\d+:\d+>\s*$|\bkd>\s*$|0: kd>\s*$|NoTarget>\s*$)/m;

// Added function to ensure CDB process is stopped
async function ensureCdbProcessStopped(): Promise<void> {
    if (cdbProcess && cdbProcess.pid && !cdbProcess.killed) {
        logInfo(`Attempting to stop existing CDB process (PID: ${cdbProcess.pid})...`);
        const currentCdbProcess = cdbProcess; // Capture the current process
        return new Promise((resolve) => {
            const onExitCleanup = () => {
                clearTimeout(killTimeout);
                currentCdbProcess?.stdout?.removeAllListeners();
                currentCdbProcess?.stderr?.removeAllListeners();
                currentCdbProcess?.removeAllListeners('exit');
                currentCdbProcess?.removeAllListeners('error');
                if (cdbProcess === currentCdbProcess) { // Only nullify if it's the same instance
                    cdbProcess = null;
                }
                logInfo('Existing CDB process has been stopped.');
                resolve();
            };

            currentCdbProcess.once('exit', onExitCleanup);
            currentCdbProcess.once('error', (err) => { 
                logError('Error while trying to stop existing CDB process: ' + err.message);
                onExitCleanup(); 
            });

            const killTimeout = setTimeout(() => {
                if (currentCdbProcess && !currentCdbProcess.killed) {
                    logWarn('CDB process quit timed out. Force killing (SIGKILL)...');
                    currentCdbProcess.kill('SIGKILL');
                }
                setTimeout(resolve, 500); 
            }, 3000); 

            if (currentCdbProcess.stdin && currentCdbProcess.stdin.writable) {
                currentCdbProcess.stdin.write('q\r\n', (err) => {
                    if (err) {
                        logWarn('Failed to write "q" to CDB stdin, attempting SIGTERM. Error: ' + err.message);
                        currentCdbProcess?.kill('SIGTERM'); 
                    } else {
                        logInfo('Sent "q" command to CDB.');
                    }
                });
            } else {
                logWarn('CDB stdin not writable or process already closing, attempting SIGTERM.');
                currentCdbProcess.kill('SIGTERM'); 
            }
        });
    } else {
        logInfo('No existing CDB process to stop or already stopped.');
        if (cdbProcess && cdbProcess.killed) { // Ensure cdbProcess is nullified if it was killed but not yet cleared
             cdbProcess = null;
        }
        return Promise.resolve();
    }
}

let initialPromptResolver: ((output: string) => void) | null = null;

async function tryStartCdbInstance(debuggerPathToTry: string, spawnArgs: string[]): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        // Check if the debugger executable exists
        if (!fs.existsSync(debuggerPathToTry)) {
            const errorMessage = `Debugger executable not found at path: ${debuggerPathToTry} (ENOENT).`;
            logWarn(errorMessage);
            reject(new Error(errorMessage));
            return;
        }

        logInfo(`Attempting to spawn: ${debuggerPathToTry} ${spawnArgs.join(' ')}`);
        const newProcess = spawn(debuggerPathToTry, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        let promptResolverForThisAttempt: ((output: string) => void) | null = null;
        let localOutputBuffer = ""; 

        const cleanupListeners = () => {
            newProcess.removeAllListeners();
            clearTimeout(timeoutHandle);
        };

        const onSpawnError = (err: Error) => {
            logWarn(`Spawn error for '${debuggerPathToTry}': ` + err.message);
            cleanupListeners();
            reject(err);
        };

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            logInfo(`Process '${debuggerPathToTry}' exited with code ${code}, signal ${signal} during initial prompt wait.`);
            cleanupListeners();
            reject(new Error(`Process '${debuggerPathToTry}' exited (code ${code}, signal ${signal}) before initial prompt.`));
        };
        
        const onStdData = (data: Buffer, streamName: string) => {
            const chunk = data.toString();
            localOutputBuffer += chunk;
            if (CDB_PROMPT_REGEX.test(localOutputBuffer)) {
                if (promptResolverForThisAttempt) {
                    logInfo(`Prompt detected for '${debuggerPathToTry}'.`);
                    cleanupListeners();
                    resolve(newProcess);
                    promptResolverForThisAttempt = null; 
                }
            }
        };

        newProcess.once('error', onSpawnError);
        newProcess.once('exit', onExit);
        newProcess.stdout?.on('data', (data) => onStdData(data, 'STDOUT'));
        newProcess.stderr?.on('data', (data) => onStdData(data, 'STDERR'));

        promptResolverForThisAttempt = (output: string) => { };

        const timeoutHandle = setTimeout(() => {
            logWarn(`Timeout waiting for initial prompt from '${debuggerPathToTry}'.`);
            cleanupListeners();
            if (!newProcess.killed) newProcess.kill();
            reject(new Error(`Timeout waiting for initial prompt from '${debuggerPathToTry}'.`));
        }, 7000);
    });
}

function startCdbIfNeeded(callerDebuggerPath?: string, processArgs: string[] = []): Promise<void> {
    logInfo(`[MCP Server] startCdbIfNeeded called. callerDebuggerPath: ${callerDebuggerPath}, processArgs: ${processArgs.join(', ')}`);
    return new Promise(async (resolve, reject) => {
        if (cdbProcess && !cdbProcess.killed) {
            logInfo("[MCP Server] startCdbIfNeeded: CDB process already running.");
            resolve();
            return;
        }
        
        outputBuffer = "";
        commandInProgress = false;
        currentCommandCompletion = null;

        const pathsToTry: string[] = ['cdb.exe'];
        if (callerDebuggerPath) {
            pathsToTry.push(callerDebuggerPath);
        }
        const defaultHardcodedPath = "C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe";
        if (!pathsToTry.includes(defaultHardcodedPath)) {
            pathsToTry.push(defaultHardcodedPath);
        }
        const uniquePathsToTry = Array.from(new Set(pathsToTry));

        let effectiveSpawnArgs: string[];
        if (processArgs && processArgs.length > 0) {
            effectiveSpawnArgs = [...processArgs];
        } else {
            effectiveSpawnArgs = ['-p', '-1'];
        }

        let successfullyStartedProcess: ChildProcess | null = null;

        for (const currentPath of uniquePathsToTry) {
            try {
                logInfo(`Attempting to start and get initial prompt from: ${currentPath} with args: ${effectiveSpawnArgs.join(' ')}`);
                const newProcess = await tryStartCdbInstance(currentPath, effectiveSpawnArgs);
                successfullyStartedProcess = newProcess;
                logInfo(`Successfully started and received initial prompt from '${currentPath}'.`);
                break; 
            } catch (error) {
                logWarn(`Failed to start CDB with path '${currentPath}': ` + (error as Error).message);
            }
        }

        if (successfullyStartedProcess) {
            cdbProcess = successfullyStartedProcess;

            cdbProcess.stdout?.removeAllListeners('data');
            cdbProcess.stdout?.on('data', (data) => {
                const chunk = data.toString();
                outputBuffer += chunk;
                if (CDB_PROMPT_REGEX.test(outputBuffer)) {
                    if (commandInProgress && currentCommandCompletion) {
                        logInfo("Command output complete (prompt detected).");
                        const timestamp = new Date().toISOString();
                        currentCommandCompletion.resolve(`[${timestamp}]\n${outputBuffer}`);
                        commandInProgress = false;
                        currentCommandCompletion = null;
                    }
                }
            });

            cdbProcess.stderr?.removeAllListeners('data');
            cdbProcess.stderr?.on('data', (data) => {
                const chunk = data.toString();
                logError(`CDB STDERR: ${chunk}`);
                outputBuffer += chunk;
                if (CDB_PROMPT_REGEX.test(outputBuffer)) {
                    if (commandInProgress && currentCommandCompletion) {
                        logInfo("Command output complete (prompt detected after stderr).");
                        const timestamp = new Date().toISOString();
                        currentCommandCompletion.resolve(`[${timestamp}]\n${outputBuffer}`);
                        commandInProgress = false;
                        currentCommandCompletion = null;
                    }
                }
            });

            cdbProcess.removeAllListeners('exit');
            cdbProcess.on('exit', (code, signal) => {
                logInfo(`CDB process exited with code ${code}, signal ${signal}`);
                if (commandInProgress && currentCommandCompletion) {
                    const lastCommand = cdbProcess && cdbProcess.stdin && (cdbProcess.stdin as any)._lastWrittenCommand ? (cdbProcess.stdin as any)._lastWrittenCommand : "";
                    if (lastCommand.trim().toLowerCase() !== '.detach' && lastCommand.trim().toLowerCase() !== 'q') {
                        currentCommandCompletion.reject(new Error(`CDB process exited (code ${code}, signal ${signal}) during command execution.`));
                    } else {
                        currentCommandCompletion.resolve(`CDB process exited as expected after command: ${lastCommand}`);
                    }
                }
                commandInProgress = false;
                currentCommandCompletion = null;
                cdbProcess = null;
            });
            
            cdbProcess.on('error', (err) => {
                logError('Error on established CDB process: ' + err.message);
            });

            resolve();
        } else {
            reject(new Error("Failed to start CDB process with any of the attempted paths. All attempts failed."));
        }
    });
}

async function executeCdbCommandViaStdio(command: string, debuggerPath?: string, debuggerArgs: string[] = []): Promise<string> {
    logInfo(`[MCP Server] executeCdbCommandViaStdio called with command: ${command}`);
    if (commandInProgress) {
        logWarn("[MCP Server] executeCdbCommandViaStdio: Command already in progress.");
        return Promise.reject(new Error("Another command is already in progress."));
    }
    
    try {
        await startCdbIfNeeded(debuggerPath, debuggerArgs);

        if (!cdbProcess || !cdbProcess.stdin || cdbProcess.killed) {
            const errorMessage = "CDB process is not running or stdin is not available for executeCdbCommandViaStdio.";
            logError(errorMessage);
            throw new Error(errorMessage);
        }
        
        commandInProgress = true;
        outputBuffer = "";

        return new Promise((resolve, reject) => {
            currentCommandCompletion = { resolve, reject };
            
            logInfo(`CDB STDIN: ${command}`);
            if (cdbProcess && cdbProcess.stdin) {
                (cdbProcess.stdin as any)._lastWrittenCommand = command;
            }
            cdbProcess!.stdin!.write(`${command}\r\n`, (err) => {
                if (err) {
                    logError("Error writing command to CDB stdin: " + err.message);
                    commandInProgress = false;
                    currentCommandCompletion = null;
                    reject(err);
                }
            });

            setTimeout(() => {
                if (commandInProgress && currentCommandCompletion) {
                    logWarn(`Command '${command}' timed out.`);
                    const currentOutput = outputBuffer;
                    outputBuffer = "";
                    commandInProgress = false;
                    const timestamp = new Date().toISOString();
                    currentCommandCompletion.reject(new Error(`Command '${command}' timed out after 30 seconds. Output so far: [${timestamp}]\n${currentOutput}`));
                    currentCommandCompletion = null;
                }
            }, 30000);
        });
    } catch (error) {
        commandInProgress = false;
        currentCommandCompletion = null;
        logError("Error in executeCdbCommandViaStdio sequence: " + (error as Error).message);
        throw error;
    }
}

const createCdbMcpServer = () => {
  const server = new McpServer({
    name: "cdb-mcp-stdio",
    version: "1.0.0",
    capabilities: {
      resources: {},
      tools: {},
    },
  });

  server.tool(
    "execute-cdb-command",
    "Executes a command in the configured debugger (e.g., CDB) via stdio and returns the output.",
    {
      command: z.string().describe("The debugger command to execute (e.g., !version, k, r)"),
      debuggerPath: z.string().optional().describe("Optional path to the debugger executable (e.g., cdb.exe). Defaults to 'cdb.exe'."),
      debuggerArgs: z.array(z.string()).optional().describe("Optional arguments to pass to the debugger when starting it (e.g., for attaching to a process: ['-p', '1234'] or ['-o', 'notepad.exe'])."),
    },
    async ({ command, debuggerPath, debuggerArgs }: { command: string; debuggerPath?: string, debuggerArgs?: string[] }) => {
      logInfo(`[MCP Server] Tool \'execute-cdb-command\' invoked with command: ${command}`);
      try {
        const output = await executeCdbCommandViaStdio(command, debuggerPath, debuggerArgs);
        return {
          content: [
            { type: "text", text: output },
          ],
        };
      } catch (error: any) {
        logError(`Error executing debugger command \'${command}\': ` + error.message);
        const userMessage = formatCdbToolError(error, `executing command \'${command}\'`);
        return {
          content: [
            {
              type: "text",
              text: userMessage
            },
          ],
        };
      }
    }
  );

  server.tool(
    "cdb-attach-to-process",
    "Attaches the debugger to a specified process. Stops any existing debugger session first.",
    {
      processId: z.string().optional().describe("The ID of the process to attach to."),
      processName: z.string().optional().describe("The name of the process to attach to. (Use if PID is not known or for broader matching)"),
      initialCommand: z.string().optional().describe("Optional command to execute immediately after attaching (e.g., !process, lm). Defaults to an echo message."),
      debuggerPath: z.string().optional().describe("Optional path to the debugger executable (e.g., cdb.exe)."),
    },
    async ({ processId, processName, initialCommand, debuggerPath }: { processId?: string; processName?: string; initialCommand?: string; debuggerPath?: string; }) => {
      logInfo(`[MCP Server] Tool 'cdb-attach-to-process' invoked. PID: ${processId}, Name: ${processName}`);
      if (!processId && !processName) {
        return { content: [{ type: "text", text: "Error: Either processId or processName must be provided." }] };
      }

      await ensureCdbProcessStopped();

      let debuggerArgs: string[];
      if (processId) {
        debuggerArgs = ['-p', processId];
      } else if (processName) {
        debuggerArgs = ['-pn', processName];
      } else {
        return { content: [{ type: "text", text: "Internal Error: No process identifier specified." }] };
      }
      
      const commandToRun = initialCommand || `.echo Attached to process. Target args: ${debuggerArgs.join(' ')}`;

      try {
        // ensureCdbProcessStopped is called before starting a new CDB instance for attach/dump
        const output = await executeCdbCommandViaStdio(commandToRun, debuggerPath, debuggerArgs);
        return { content: [{ type: "text", text: output }] };
      } catch (error: any) {
        logError(`Error in cdb-attach-to-process: ` + error.message);
        const userMessage = formatCdbToolError(error, "attaching to process");
        return { content: [{ type: "text", text: userMessage }] };
      }
    }
  );

  server.tool(
    "cdb-open-crash-dump",
    "Opens a crash dump file in the debugger. Stops any existing debugger session first.",
    {
      dumpFilePath: z.string().describe("The absolute path to the crash dump file (.dmp, .mdmp, etc.)."),
      initialCommand: z.string().optional().describe("Optional command to execute immediately after loading the dump (e.g., !analyze -v, k). Defaults to an echo message."),
      debuggerPath: z.string().optional().describe("Optional path to the debugger executable (e.g., cdb.exe)."),
    },
    async ({ dumpFilePath, initialCommand, debuggerPath }: { dumpFilePath: string; initialCommand?: string; debuggerPath?: string; }) => {
      logInfo(`[MCP Server] Tool 'cdb-open-crash-dump' invoked with dump file: ${dumpFilePath}`);
      
      await ensureCdbProcessStopped();

      const debuggerArgs = ['-z', dumpFilePath];
      const commandToRun = initialCommand || `.echo Loaded dump file: ${dumpFilePath}. Target args: ${debuggerArgs.join(' ')}`;

      try {
        // ensureCdbProcessStopped is called before starting a new CDB instance for attach/dump
        const output = await executeCdbCommandViaStdio(commandToRun, debuggerPath, debuggerArgs);
        return { content: [{ type: "text", text: output }] };
      } catch (error: any) {
        logError(`Error in cdb-open-crash-dump: ` + error.message);
        const userMessage = formatCdbToolError(error, "opening dump file");
        return { content: [{ type: "text", text: userMessage }] };
      }
    }
  );

  return server;
};

async function main() {
    console.error("Starting CDB MCP Server (STDIO)..."); // Changed to console.error
    const server = createCdbMcpServer();
    const transport = new StdioServerTransport();
    server.connect(transport);
    logInfo("CDB MCP Server (STDIO) connected and listening.");
}

main().catch(error => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
});

process.on('SIGINT', async () => {
  console.error('Shutting down server...'); // Changed to console.error
  if (cdbProcess && !cdbProcess.killed) {
    console.error('Killing CDB process...'); // Changed to console.error
    cdbProcess.stdin?.write('q\r\n', (err) => {
        if (err) console.error("Error sending quit command to CDB:", err);
        setTimeout(() => {
            if (cdbProcess && !cdbProcess.killed) {
                cdbProcess.kill('SIGTERM');
                console.error('CDB process killed.'); // Changed to console.error
            }
        }, 500);
    });
  }
  setTimeout(() => {
      process.exit(0);
  }, 1000);
});
