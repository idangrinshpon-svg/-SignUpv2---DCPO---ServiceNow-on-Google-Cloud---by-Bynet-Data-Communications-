$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "Running Marketplace simulation..."
npm run simulate:marketplace

Write-Host ""
Write-Host "Running live regression and browser QA..."
npm test
