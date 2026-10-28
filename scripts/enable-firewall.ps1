$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Create .env from .env.example first.' }
$settings = @{}
foreach ($line in Get-Content -LiteralPath $configPath) {
    if ($line -match '^(REMOTE_HOST|ALLOWED_CIDR)=(.+)$') {
        $settings[$Matches[1]] = $Matches[2].Trim().Trim('"')
    }
}
$localIp = $settings.REMOTE_HOST
$subnet = $settings.ALLOWED_CIDR
$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($localIp, [ref]$parsedIp) -or $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'REMOTE_HOST must be an IPv4 address.' }
if ($subnet -notmatch '^\d{1,3}(\.\d{1,3}){3}/(\d|[12]\d|3[0-2])$') { throw 'ALLOWED_CIDR must be an IPv4 subnet such as 192.168.1.0/24.' }
$subnetParts = $subnet.Split('/')
$prefixLength = [int]$subnetParts[1]
$maskBytes = [byte[]]::new(4)
for ($i = 0; $i -lt 4; $i++) {
    $bitsInOctet = [Math]::Max(0, [Math]::Min(8, $prefixLength - (8 * $i)))
    $maskBytes[$i] = [byte](256 - [Math]::Pow(2, 8 - $bitsInOctet))
}
$subnetWithMask = "$($subnetParts[0])/$([System.Net.IPAddress]::new($maskBytes).ToString())"
$programPath = (Get-Command node.exe -ErrorAction Stop).Source
$ruleName = 'LiquidGlassRemoteLAN8787'
$displayName = "Liquid Glass Remote Wi-Fi $subnet"
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
    New-NetFirewallRule `
        -Name $ruleName `
        -DisplayName $displayName `
        -Direction Inbound `
        -Action Allow `
        -Program $programPath `
        -Protocol TCP `
        -LocalPort 8787 `
        -LocalAddress $localIp `
        -RemoteAddress $subnet `
        -Profile Any | Out-Null
}

$rule = Get-NetFirewallRule -Name $ruleName
$addresses = $rule | Get-NetFirewallAddressFilter
$ports = $rule | Get-NetFirewallPortFilter
$program = $rule | Get-NetFirewallApplicationFilter
if ($rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or
    $addresses.LocalAddress -notcontains $localIp -or
    ($addresses.RemoteAddress -notcontains $subnet -and $addresses.RemoteAddress -notcontains $subnetWithMask) -or
    $ports.Protocol -ne 'TCP' -or $ports.LocalPort -ne '8787' -or
    $program.Program -ne $programPath) {
    throw 'The firewall rule does not match the approved scope. Remove it and inspect the rule before proceeding.'
}

Write-Output "Enabled $displayName for TCP 8787 from $subnet only."
