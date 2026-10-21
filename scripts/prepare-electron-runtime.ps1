$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'build/electron-runtime-windows-x64.json') -Raw | ConvertFrom-Json
$archive = Join-Path $projectRoot '.cache/electron-runtime-windows-x64.zip'
$runtime = Join-Path $projectRoot '.cache/electron-windows-x64'
New-Item -ItemType Directory -Path (Split-Path $archive -Parent) -Force | Out-Null

function Test-Checksum($Path, $Expected) {
    if (!(Test-Path -LiteralPath $Path)) { return $false }
    $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
        return $hash -eq $Expected
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

if (!(Test-Checksum $archive $manifest.sha256)) {
    $url = "https://github.com/$($manifest.repository)/releases/download/$($manifest.tag)/$($manifest.asset)"
    Invoke-WebRequest -Uri $url -OutFile $archive
}
if (!(Test-Checksum $archive $manifest.sha256)) { throw 'Official Electron archive checksum mismatch' }

$valid = $true
foreach ($inputFile in $manifest.inputs.PSObject.Properties) {
    if (!(Test-Checksum (Join-Path $runtime $inputFile.Name) $inputFile.Value)) { $valid = $false }
}
if (!$valid) {
    if (Test-Path -LiteralPath $runtime) {
        $expected = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.cache/electron-windows-x64'))
        if ([System.IO.Path]::GetFullPath($runtime) -ne $expected) { throw 'Unsafe Electron cache path' }
        Remove-Item -LiteralPath $runtime -Recurse -Force
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
}
node (Join-Path $PSScriptRoot 'verify-electron-runtime.cjs') (Join-Path $runtime 'electron.exe') (Join-Path $runtime 'ffmpeg.dll')
if ($LASTEXITCODE -ne 0) { throw 'Official Electron runtime verification failed' }
