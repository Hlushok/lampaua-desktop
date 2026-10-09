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
function Get-PinnedSources {
    if (!$manifest.sourceAsset) { return }
    if ($null -eq $manifest.sourceParts) {
        Get-PinnedAsset $manifest.sourceAsset $manifest.sourceSha256 (Join-Path $cache $manifest.sourceAsset) $null
        return
    }
    if ($manifest.sourceAsset -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$' -or
        $manifest.sourceSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid combined source archive metadata'
    }
    $parts = @($manifest.sourceParts)
    if ($parts.Count -lt 2 -or $parts.Count -gt 999) { throw 'Invalid source part count' }
    for ($index = 0; $index -lt $parts.Count; $index++) {
        $part = $parts[$index]
        $expectedName = '{0}.{1:000}' -f $manifest.sourceAsset, ($index + 1)
        $size = 0L
        if ($part.asset -cne $expectedName -or $part.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [string]$part.size -cnotmatch '^[1-9][0-9]*$' -or
            ![long]::TryParse([string]$part.size, [ref]$size) -or $size -ge 2GB) {
            throw "Invalid source part metadata: $expectedName"
        }
    }
    foreach ($part in $parts) {
        $file = Join-Path $cache $part.asset
        Get-PinnedAsset $part.asset $part.sha256 $file $null
        if ((Get-Item -LiteralPath $file).Length -ne [long]$part.size) {
            throw "Source part size mismatch: $($part.asset)"
        }
    }
    $destination = Join-Path $cache $manifest.sourceAsset
    $temporary = Join-Path $cache "$($manifest.sourceAsset).$([guid]::NewGuid()).partial"
    try {
        $output = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew)
        try {
            foreach ($part in $parts) {
                $input = [System.IO.File]::OpenRead((Join-Path $cache $part.asset))
                try { $input.CopyTo($output) } finally { $input.Dispose() }
            }
        } finally { $output.Dispose() }
        if (!(Test-Hash $temporary $manifest.sourceSha256)) {
            throw 'Combined source archive checksum mismatch'
        }
        if (Test-Path -LiteralPath $destination) {
            # Windows PowerShell otherwise converts a null string to an empty path.
            [System.IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [System.IO.File]::Move($temporary, $destination)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Get-PinnedAsset $manifest.asset $manifest.sha256 $archive $manifest.mirror
Get-PinnedSources
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
