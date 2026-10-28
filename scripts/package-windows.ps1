param(
    [string]$RelayUrl = $env:RELAY_URL,
    [switch]$StageOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stageRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist\windows'))
$expectedStage = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist\windows'))
if ($stageRoot -ne $expectedStage -or -not $stageRoot.StartsWith("$repoRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to modify a packaging folder outside this project.'
}

if ([string]::IsNullOrWhiteSpace($RelayUrl)) { throw 'Supply the deployed HTTPS relay URL with -RelayUrl or RELAY_URL.' }
$parsedUrl = $null
if (-not [Uri]::TryCreate($RelayUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.Scheme -ne 'https' -or $parsedUrl.UserInfo -or $parsedUrl.AbsolutePath -ne '/' -or $parsedUrl.Query -or $parsedUrl.Fragment) {
    throw 'RelayUrl must be the trusted HTTPS origin of the deployed relay, without credentials, query, or fragment.'
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = $nodeCommand.Source
$nodeVersion = (& $nodePath --version).Trim()
$nodeParts = $nodeVersion.TrimStart('v').Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = [int]$nodeParts[1]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 13)) { throw "Node.js 22.13 or newer is required to package the receiver. Found $nodeVersion." }

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
$null = New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'receiver'), (Join-Path $stageRoot 'server')
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $stageRoot 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\receiver\index.js') -Destination (Join-Path $stageRoot 'receiver\index.js') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\receiver\launch.js') -Destination (Join-Path $stageRoot 'receiver\launch.js') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\receiver\credential-store.js') -Destination (Join-Path $stageRoot 'receiver\credential-store.js') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\receiver\single-instance.js') -Destination (Join-Path $stageRoot 'receiver\single-instance.js') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\server\windows.js') -Destination (Join-Path $stageRoot 'server\windows.js') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\server\validation.js') -Destination (Join-Path $stageRoot 'server\validation.js') -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stageRoot 'package.json'), '{"type":"module"}', $utf8NoBom)
$receiverConfig = @{ relayUrl = $parsedUrl.GetLeftPart([UriPartial]::Authority); mockMode = $false } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $stageRoot 'receiver\config.json'), $receiverConfig, $utf8NoBom)

$nodeLicense = Join-Path (Split-Path $nodePath -Parent) 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense) { Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stageRoot 'Node-LICENSE.txt') -Force }
Write-Output "Staged receiver for $nodeVersion at $stageRoot"
Write-Output 'The receiver uses the current Windows user session and stores its identity with Windows DPAPI.'
if ($StageOnly) { return }

$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $compiler) {
    $candidate = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $candidate) { $compiler = @{ Source = $candidate } }
}
if (-not $compiler) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $candidate) { $compiler = @{ Source = $candidate } }
}
if (-not $compiler) {
    $candidate = Join-Path $env:USERPROFILE 'AppData\Local\Programs\Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $candidate) { $compiler = @{ Source = $candidate } }
}
if ($compiler) {
    & $compiler.Source (Join-Path $PSScriptRoot '..\installer\LiquidGlassRemote.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
    Write-Output (Join-Path $repoRoot 'dist\installer\LiquidGlassRemoteSetup.exe')
    return
}
throw 'The receiver is staged, but the open-source Inno Setup 6 compiler is not installed. Install Inno Setup 6, then run this script again to create the installer.'
