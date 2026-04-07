import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setTrayCommandFile } from "./update-check";

export function startTray(port: number): void {
  if (process.platform !== "win32") return;

  const commandFilePath = join(tmpdir(), `raceiq-tray-cmd-${process.pid}.txt`);

  // Tell update-check where to write tray commands
  setTrayCommandFile(commandFilePath);

  // Escape for use inside PowerShell single-quoted strings
  const commandFilePs = commandFilePath.replace(/\\/g, "\\\\");

  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$port = ${port}
$url = "http://localhost:$port"
$cmdFile = '${commandFilePs}'

# Extract icon from the running exe
$exePath = (Get-Process -Id ${process.pid}).Path
$raceiqIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $raceiqIcon
$tray.Text = "RaceIQ"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open RaceIQ"
$openItem.add_Click({ Start-Process $url })
$menu.Items.Add($openItem) | Out-Null

$consoleItem = New-Object System.Windows.Forms.ToolStripMenuItem
$consoleItem.Text = "Show Console"
$consoleItem.add_Click({
  $logPath = [System.IO.Path]::Combine($env:APPDATA, 'RaceIQ', 'raceiq.log')
  if (Test-Path $logPath) {
    Start-Process powershell -ArgumentList @('-NoProfile', '-Command', "Get-Content '$logPath' -Wait -Tail 50")
  }
})
$menu.Items.Add($consoleItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$updateItem = New-Object System.Windows.Forms.ToolStripMenuItem
$updateItem.Text = "Install Update"
$updateItem.Visible = $false
$updateItem.add_Click({
  Start-Process "http://localhost:${port}?update=1"
})
$menu.Items.Add($updateItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit"
$exitItem.add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    try { Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue } catch {}
    [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($exitItem) | Out-Null

$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Start-Process $url })

# Poll command file every 5s for server->tray IPC
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if (Test-Path $cmdFile) {
    try {
      $cmd = (Get-Content $cmdFile -Raw).Trim()
      Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
      if ($cmd -match '^update-available:(.+)$') {
        $ver = $matches[1]
        $updateItem.Text = "Install Update (v$ver)"
        $updateItem.Visible = $true
        $tray.BalloonTipTitle = "RaceIQ Update Available"
        $tray.BalloonTipText = "RaceIQ v$ver is available. Click to install."
        $tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $tray.ShowBalloonTip(5000)
        $script:updateVersion = $ver
      }
    } catch {}
  }
})
$timer.Start()

$script:updateVersion = $null
$tray.add_BalloonTipClicked({
  if ($script:updateVersion) {
    Start-Process "http://localhost:${port}?update=1"
  }
})

[System.Windows.Forms.Application]::Run()
`.trimStart();

  const tmpScript = join(tmpdir(), `raceiq-tray-${process.pid}.ps1`);

  try {
    writeFileSync(tmpScript, script, "utf8");
  } catch {
    return;
  }

  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", tmpScript],
    { stdio: "ignore", detached: false, windowsHide: true },
  );

  const cleanup = () => {
    try { unlinkSync(tmpScript); } catch {}
    try { unlinkSync(commandFilePath); } catch {}
  };

  proc.on("exit", (code) => {
    cleanup();
    if (code === 0) process.exit(0);
  });

  proc.on("error", cleanup);

  process.on("exit", () => {
    try { proc.kill(); } catch {}
    cleanup();
  });
}
