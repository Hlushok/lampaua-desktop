$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $root 'build/libmpv-runtime.json') -Raw | ConvertFrom-Json
$cache = Join-Path $root '.cache/mpv-prototype'
$archive = Join-Path $cache 'libmpv-sdk.7z'
$sdk = Join-Path $cache 'sdk'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
function Test-Hash($file, $hash) {
    if (!(Test-Path -LiteralPath $file)) { return $false }
    $stream = [System.IO.File]::OpenRead($file)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actual = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
        return $actual -eq $hash
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}
function Get-PinnedAsset($asset, $hash, $destination, $mirror) {
    if ($asset -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') { throw 'Invalid libmpv asset name' }
    if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid libmpv asset checksum' }
    if (Test-Hash $destination $hash) { return }
    if ($env:GH_TOKEN -and $manifest.repository -eq 'Hlushok/lampaua-desktop') {
        & gh release download $manifest.tag --repo $manifest.repository --pattern $asset --dir $cache --clobber
        if ($LASTEXITCODE -ne 0) { throw "Cannot download pinned libmpv asset: $asset" }
        $download = Join-Path $cache $asset
        if ($download -ne $destination) { Copy-Item -LiteralPath $download -Destination $destination -Force }
    } else {
        try {
            Invoke-WebRequest -Uri "https://github.com/$($manifest.repository)/releases/download/$($manifest.tag)/$asset" -OutFile $destination
        } catch {
            if (!$mirror) { throw }
            Invoke-WebRequest -Uri $mirror -OutFile $destination
        }
    }
    if (!(Test-Hash $destination $hash)) { throw "libmpv asset checksum mismatch: $asset" }
}
Get-PinnedAsset $manifest.asset $manifest.sha256 $archive $manifest.mirror
if ($manifest.sourceAsset) {
    Get-PinnedAsset $manifest.sourceAsset $manifest.sourceSha256 (Join-Path $cache $manifest.sourceAsset) $null
}
if (!(Test-Hash (Join-Path $sdk 'libmpv-2.dll') $manifest.dllSha256)) {
    New-Item -ItemType Directory -Path $sdk -Force | Out-Null
    $sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
    if (!$sevenZip -and (Test-Path -LiteralPath 'C:/Program Files/7-Zip/7z.exe')) { $sevenZip = 'C:/Program Files/7-Zip/7z.exe' }
    if (!$sevenZip) {
        $sevenZip = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder/Cache') -Recurse -Filter 7za.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    }
    if (!$sevenZip) { throw 'Install 7-Zip or provide 7z.exe on PATH' }
    & $sevenZip x -y "-o$sdk" $archive
    if ($LASTEXITCODE -ne 0) { throw 'libmpv SDK extraction failed' }
}
if (!(Test-Hash (Join-Path $sdk 'libmpv-2.dll') $manifest.dllSha256)) { throw 'libmpv DLL checksum mismatch' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual Studio C++ build tools are required' }
$version = (Get-Content -LiteralPath (Join-Path $vs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
$tools = Join-Path $vs "VC/Tools/MSVC/$version/bin/Hostx64/x64"
$exports = & (Join-Path $tools 'dumpbin.exe') /exports (Join-Path $sdk 'libmpv-2.dll')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read libmpv exports' }
$names = @($exports | ForEach-Object {
    if ($_ -match '^\s+\d+\s+[A-Fa-f0-9]+\s+[A-Fa-f0-9]+\s+(mpv_\w+)\s*$') { $Matches[1] }
})
if ($names.Count -lt 30) { throw 'Unexpected libmpv export table' }
$lib = Join-Path $sdk 'lib'
New-Item -ItemType Directory -Path $lib -Force | Out-Null
@('LIBRARY libmpv-2.dll', 'EXPORTS') + $names | Set-Content -LiteralPath (Join-Path $lib 'mpv.def') -Encoding ascii
& (Join-Path $tools 'lib.exe') /nologo /machine:x64 "/def:$lib/mpv.def" "/out:$lib/mpv.lib"
if ($LASTEXITCODE -ne 0) { throw 'MSVC import library generation failed' }
Write-Output 'Pinned libmpv SDK and MSVC import library ready'
