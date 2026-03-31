$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$fallbackPython = "c:\dev\my-python\gpt-agent\.venv\Scripts\python.exe"
if (Get-Command py -ErrorAction SilentlyContinue) {
  py .\scripts\regression_check.py @args
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  python .\scripts\regression_check.py @args
} elseif (Test-Path -LiteralPath $fallbackPython) {
  & $fallbackPython .\scripts\regression_check.py @args
} else {
  throw "Python launcher not found. Install Python or add 'py' or 'python' to PATH."
}
