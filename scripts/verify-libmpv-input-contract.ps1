$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$scriptText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prepare-libmpv.ps1') -Raw
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$null, [ref]$errors)
if ($errors.Count) { throw 'Invalid libmpv preparation script' }
# Load only the asset helpers; do not run downloads or Visual Studio preparation.
foreach ($name in @('Test-Hash', 'Get-PinnedAsset', 'Get-PinnedSources')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (!$definition) { throw "Missing helper: $name" }
    Invoke-Expression $definition.Extent.Text
}
if ($scriptText -notmatch 'Get-PinnedAsset \$manifest.sourceAsset \$manifest.sourceSha256') {
    throw 'Corresponding sources must use the checksum-verified download path'
}
$cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $root '.cache'))
$cache = [System.IO.Path]::GetFullPath((Join-Path $cacheRoot "libmpv-input-contract-$([guid]::NewGuid())"))
if (!$cache.StartsWith($cacheRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Test cache must stay inside the workspace'
}
$fixture = Join-Path $root 'LICENSE'
$expected = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = @{ repository = 'Hlushok/lampaua-desktop'; tag = 'v2.0.0' }
$originalToken = $env:GH_TOKEN
$script:ghCalls = 0
$script:webCalls = 0
$script:failPrimary = $false
function gh {
    if ($args[0] -ne 'release' -or $args[1] -ne 'download') { throw 'Unexpected GitHub command' }
    if ($args[[array]::IndexOf($args, '--repo') + 1] -ne $manifest.repository) { throw 'Wrong GitHub repository' }
    $asset = $args[[array]::IndexOf($args, '--pattern') + 1]
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $cache $asset) -Force
    $script:ghCalls++
    $global:LASTEXITCODE = 0
}
function Invoke-WebRequest {
    param($Uri, $OutFile)
    $script:webCalls++
    if ($script:failPrimary -and $Uri -like 'https://github.com/*') { throw 'Simulated unavailable primary asset' }
    Copy-Item -LiteralPath $fixture -Destination $OutFile -Force
}
function Expect-Error($operation, $message) {
    $failed = $false
    try { & $operation } catch {
        if ($_.Exception.Message -notlike "*$message*") { throw }
        $failed = $true
    }
    if (!$failed) { throw "Expected failure: $message" }
}
try {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $env:GH_TOKEN = 'mock-token-never-transmitted'
    $sdk = Join-Path $cache 'libmpv-sdk.7z'
    Copy-Item -LiteralPath $fixture -Destination $sdk
    Get-PinnedAsset 'own-sdk.7z' $expected $sdk $null
    if ($script:ghCalls -ne 0) { throw 'Valid cache must not contact GitHub' }

    $uncached = Join-Path $cache 'new-sdk.7z'
    Get-PinnedAsset 'own-sdk.7z' $expected $uncached $null
    if ($script:ghCalls -ne 1 -or !(Test-Hash $uncached $expected)) { throw 'Authenticated draft SDK download failed' }
    Get-PinnedAsset 'own-sources.tar.gz' $expected (Join-Path $cache 'own-sources.tar.gz') $null
    if ($script:ghCalls -ne 2) { throw 'Corresponding sources were not downloaded' }

    $bytes = [System.IO.File]::ReadAllBytes($fixture)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $joinedHash = -join ($sha.ComputeHash([byte[]]($bytes + $bytes)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
    $manifest.sourceAsset = 'multipart-sources.tar.gz'
    $manifest.sourceSha256 = $joinedHash
    $manifest.sourceParts = @(
        @{asset='multipart-sources.tar.gz.001';sha256=$expected;size=$bytes.Length},
        @{asset='multipart-sources.tar.gz.002';sha256=$expected;size=$bytes.Length}
    )
    Get-PinnedSources
    $joined = Join-Path $cache $manifest.sourceAsset
    if ($script:ghCalls -ne 4 -or !(Test-Hash $joined $joinedHash)) { throw 'Multipart source assembly failed' }
    Get-PinnedSources
    if ($script:ghCalls -ne 4) { throw 'Valid source parts must use their verified cache' }
    $manifest.sourceSha256 = '0' * 64
    Expect-Error { Get-PinnedSources } 'Combined source archive checksum mismatch'
    if (!(Test-Hash $joined $joinedHash)) { throw 'Failed assembly replaced a previously verified source archive' }
    $manifest.sourceSha256 = $joinedHash
    $manifest.sourceParts[1].size++
    Expect-Error { Get-PinnedSources } 'Source part size mismatch'
    $manifest.sourceParts[1].size--
    $manifest.sourceParts[1].asset = '../escape'
    Expect-Error { Get-PinnedSources } 'Invalid source part'
    $manifest.sourceParts[1].asset = 'multipart-sources.tar.gz.001'
    Expect-Error { Get-PinnedSources } 'Invalid source part'
    $manifest.sourceParts[1].asset = 'multipart-sources.tar.gz.002'
    $manifest.sourceParts[1].sha256 = 'bad-hash'
    Expect-Error { Get-PinnedSources } 'Invalid source part'
    $manifest.sourceParts[1].sha256 = $expected
    $manifest.sourceParts[1].size = 2GB
    Expect-Error { Get-PinnedSources } 'Invalid source part'
    $manifest.sourceParts[1].size = -1
    Expect-Error { Get-PinnedSources } 'Invalid source part'
    $manifest.sourceParts[1].size = $bytes.Length
    if ($script:ghCalls -ne 4) { throw 'Invalid source part metadata must fail before downloading' }
    if (Get-ChildItem -LiteralPath $cache -Filter *.partial) { throw 'Temporary source assembly was not cleaned up' }
    $manifest.sourceParts = $null
    $manifest.sourceAsset = 'own-sources.tar.gz'
    $manifest.sourceSha256 = $expected
    Get-PinnedSources

    Expect-Error { Get-PinnedAsset '../escape.7z' $expected $uncached $null } 'Invalid libmpv asset name'
    Expect-Error { Get-PinnedAsset 'own-sdk.7z' 'bad-hash' $uncached $null } 'Invalid libmpv asset checksum'
    Expect-Error { Get-PinnedAsset 'wrong-sdk.7z' ('0' * 64) (Join-Path $cache 'wrong-sdk.7z') $null } 'checksum mismatch'

    $env:GH_TOKEN = $null
    $manifest.repository = 'shinchiro/mpv-winbuild-cmake'
    $script:failPrimary = $true
    Get-PinnedAsset 'legacy-sdk.7z' $expected (Join-Path $cache 'legacy-sdk.7z') 'https://mirror.invalid/legacy-sdk.7z'
    if ($script:webCalls -ne 2) { throw 'Legacy verified mirror fallback was not retained' }
    Write-Output 'libmpv cache, draft SDK/sources, multipart assembly, checksum rejection and legacy mirror contracts verified'
} finally {
    $env:GH_TOKEN = $originalToken
    if (Test-Path -LiteralPath $cache) { Remove-Item -LiteralPath $cache -Recurse -Force }
}
