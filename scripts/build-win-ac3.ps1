$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent

& (Join-Path $PSScriptRoot 'prepare-electron-ac3-eac3.ps1')
if ($LASTEXITCODE -ne 0) {
    throw 'Custom Electron preparation failed.'
}

Push-Location $projectRoot
try {
    yarn electron-builder --win --x64 --publish=never --config electron-builder.ac3.cjs
    if ($LASTEXITCODE -ne 0) {
        throw 'Windows AC3/EAC3 build failed.'
    }
} finally {
    Pop-Location
}
