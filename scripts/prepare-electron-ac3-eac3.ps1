$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $projectRoot 'build/electron-runtime-ac3-eac3.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$cache = Join-Path $projectRoot '.cache'
$archive = Join-Path $cache 'electron-runtime-ac3-eac3.zip'
$runtime = Join-Path $cache 'electron-ac3-eac3'

New-Item -ItemType Directory -Path $cache -Force | Out-Null

function Test-Checksum($Path, $Expected) {
    if (!(Test-Path -LiteralPath $Path)) {
        return $false
    }

    $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }

    return $hash -eq $Expected.ToLowerInvariant()
}

if (!(Test-Checksum $archive $manifest.sha256)) {
    $url = "https://github.com/$($manifest.repository)/releases/download/$($manifest.tag)/$($manifest.asset)"
    Invoke-WebRequest -Uri $url -OutFile $archive
}

if (!(Test-Checksum $archive $manifest.sha256)) {
    throw 'Custom Electron ZIP checksum does not match the pinned build.'
}

if (Test-Path -LiteralPath $runtime) {
    Remove-Item -LiteralPath $runtime -Recurse -Force
}

Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force

$version = (Get-Content -LiteralPath (Join-Path $runtime 'version') -Raw).Trim()
if ($version -ne $manifest.version) {
    throw "Expected Electron $($manifest.version), got $version"
}

node (Join-Path $PSScriptRoot 'verify-electron-runtime.cjs') (Join-Path $runtime 'electron.exe') (Join-Path $runtime 'ffmpeg.dll')
if ($LASTEXITCODE -ne 0) {
    throw 'Custom Electron runtime verification failed.'
}
