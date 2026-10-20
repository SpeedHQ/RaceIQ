import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import os from "node:os";

export class RecordingFolderPickerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let active = false;

async function initialDirectory(requested?: string): Promise<string> {
  let directory = requested ?? process.env.RACEIQ_RECORDING_DIRECTORY ?? os.homedir();
  if (!isAbsolute(directory) || directory.includes("\0")) {
    throw new RecordingFolderPickerError("INVALID_DIRECTORY", "Path must be absolute");
  }
  directory = resolve(directory);
  for (;;) {
    try {
      const resolved = await realpath(directory);
      if (!(await lstat(resolved)).isDirectory()) throw new RecordingFolderPickerError("INVALID_DIRECTORY", "Path is not a directory");
      return resolved;
    } catch (error) {
      if (error instanceof RecordingFolderPickerError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

function run(command: string, args: string[], cancelCodes: number[] = [], env?: NodeJS.ProcessEnv): Promise<string | null> {
  const { promise, resolve, reject } = Promise.withResolvers<string | null>();
  let child;
  try { child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env }); }
  catch (error) { reject(new RecordingFolderPickerError("PICKER_UNAVAILABLE", error instanceof Error ? error.message : "Unable to launch folder picker")); return promise; }
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", (error) => reject(new RecordingFolderPickerError("PICKER_UNAVAILABLE", error.message)));
  child.once("close", (code) => {
    if (code === 0) resolve(output.trim() || null);
    else if (cancelCodes.includes(code ?? -1) && !stderr.trim()) resolve(null);
    else reject(new RecordingFolderPickerError("PICKER_UNAVAILABLE", stderr.trim() || `Folder picker exited with code ${code}`));
  });
  return promise;
}


export async function pickRecordingFolder(requested?: string): Promise<string | null> {
  if (active) throw new RecordingFolderPickerError("PICKER_ACTIVE", "A folder picker is already open");
  active = true;
  try {
    const initial = await initialDirectory(requested);
    let selected: string | null;
    if (process.platform === "win32") {
      const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = $env:RACEIQ_PICKER_INITIAL_DIRECTORY; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) } else { exit 10 }";
      selected = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script], [10], { ...process.env, RACEIQ_PICKER_INITIAL_DIRECTORY: initial });
    } else if (process.platform === "darwin") {
      const script = "on run argv\ntry\nset chosen to choose folder default location (POSIX file (item 1 of argv))\nreturn POSIX path of chosen\non error errMsg number errNum\nif errNum is -128 then\nreturn \"\"\nelse\nerror errMsg number errNum\nend if\nend try\nend run";
      selected = await run("osascript", ["-e", script, initial]);
    } else if (process.platform === "linux") {
      selected = await run("zenity", ["--file-selection", "--directory", `--filename=${initial.endsWith("/") ? initial : `${initial}/`}`], [1]);
    } else {
      throw new RecordingFolderPickerError("PICKER_UNSUPPORTED", `Native folder picker unsupported on ${process.platform}`);
    }
    return selected;
  } catch (error) {
    if (error instanceof RecordingFolderPickerError) throw error;
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new RecordingFolderPickerError(code === "ENOENT" ? "PICKER_UNAVAILABLE" : "PICKER_FAILED", "Unable to open native folder picker");
  } finally {
    active = false;
  }
}
