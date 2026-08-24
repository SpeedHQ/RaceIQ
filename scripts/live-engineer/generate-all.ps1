[CmdletBinding()]
param(
    [switch]$SkipValidation
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$python = Join-Path $root ".venv/Scripts/python.exe"
$generator = Join-Path $PSScriptRoot "generate.py"
$referenceAudio = Join-Path $PSScriptRoot "voices/Aussie-short.flac"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Missing repo Python environment: $python. Run the maintainer setup first."
}
if (-not (Test-Path -LiteralPath $referenceAudio)) {
    throw "Missing reference voice: $referenceAudio"
}

$referenceText = "G'day mate, Tom here."

$args = @(
    $generator,
    "--render",
    "--force",
    "--batch-size", "8",
    "--ref-audio", $referenceAudio,
    "--ref-text", $referenceText
)
if (-not $SkipValidation) {
    $args += "--validate"
}

Write-Host "Generating Live Engineer voice catalog with $python"
& $python @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $python $generator --check
exit $LASTEXITCODE
