param([switch]$AllowUnconfigured)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    if (!(Test-Path .env)) { Copy-Item .env.example .env }
    $envPath = Join-Path $PSScriptRoot '.env'
    $envText = [IO.File]::ReadAllText($envPath)
    if ($envText -notmatch '(?m)^KNOWLEDGE_SERVICE_KEY=\S+') {
        $serviceKey = 'ks-svc-' + [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
        if ($envText -match '(?m)^KNOWLEDGE_SERVICE_KEY=.*$') {
            $envText = [regex]::Replace($envText, '(?m)^KNOWLEDGE_SERVICE_KEY=.*$', "KNOWLEDGE_SERVICE_KEY=$serviceKey")
        } else { $envText += "`nKNOWLEDGE_SERVICE_KEY=$serviceKey`n" }
        [IO.File]::WriteAllText($envPath, $envText, [Text.UTF8Encoding]::new($false))
    }
    # Let Compose parse dotenv quoting/interpolation; never print resolved credentials.
    $resolved = docker compose config --format json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Invalid Compose configuration.' }
    $proxyEnv = $resolved.services.proxy.environment
    $coreEnv = $resolved.services.'memory-core'.environment
    $langfuseEnabled = $coreEnv.LANGFUSE_ENABLED -eq 'true'
    if ($langfuseEnabled) {
        foreach ($name in @('LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY')) {
            if ([string]::IsNullOrWhiteSpace($coreEnv.$name)) { throw "Fill $name in .env before enabling Langfuse (LANGFUSE_HOST uses LANGFUSE_BASE_URL)." }
        }
        $langfuseUri = $null
        if (![Uri]::TryCreate($coreEnv.LANGFUSE_HOST, [UriKind]::Absolute, [ref]$langfuseUri) -or $langfuseUri.Scheme -notin @('http', 'https')) {
            throw 'LANGFUSE_BASE_URL must be an absolute HTTP(S) URL.'
        }
    }
    $required = @($coreEnv.TDAI_LLM_BASE_URL, $coreEnv.TDAI_LLM_API_KEY, $coreEnv.TDAI_LLM_MODEL,
        $proxyEnv.PROXY_UPSTREAM_URL, $proxyEnv.PROXY_UPSTREAM_API_KEY, $proxyEnv.PROXY_UPSTREAM_MODEL)
    $unconfigured = @($required | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -eq 'REPLACE_ME' }).Count -gt 0
    if ($unconfigured -and !$AllowUnconfigured) { throw 'Fill MEMORY_LLM_* and PROXY_UPSTREAM_* in .env first, or use -AllowUnconfigured for UI-only setup.' }
    # Reuse the repository's full-stack proxy configuration; JSON escaping preserves YAML strings.
    $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'start-proxy.sh'))
    $template = [regex]::Match($source, '(?s)cat > "\$CONFIG_FILE" <<YAML\r?\n(.*?)\r?\nYAML').Groups[1].Value
    if (!$template) { throw 'Proxy template was not found.' }
    $values = @{
        PROXY_UPSTREAM_URL = $proxyEnv.PROXY_UPSTREAM_URL
        PROXY_UPSTREAM_API_KEY = $proxyEnv.PROXY_UPSTREAM_API_KEY
        # Core Bearer gate is off for local mode. These non-empty internal tokens
        # still enable the knowledge/skill injectors, as in the upstream scripts.
        MEMORY_CORE_GATEWAY_API_KEY = 'local'
    }
    foreach ($name in $values.Keys) {
        $encoded = ConvertTo-Json -InputObject ([string]$values[$name]) -Compress
        $template = $template.Replace(('"${' + $name + '}"'), $encoded)
    }
    foreach ($flag in @('PROXY_ENABLE_TDAI', 'PROXY_ENABLE_AUTH', 'PROXY_ENABLE_SESSION_INIT')) {
        $template = $template.Replace(('$(bool $' + $flag + ')'), 'true')
    }
    $proxyPort = ($resolved.services.proxy.ports | Select-Object -First 1).published
    $template = $template.Replace("injection:`n", "injection:`n  externalGatewayUrl: http://127.0.0.1:$proxyPort`n")
    $template = $template.Replace("injection:`r`n", "injection:`r`n  externalGatewayUrl: http://127.0.0.1:$proxyPort`r`n")
    # Local deployments do not use the cloud billing endpoint or Redis rate limits.
    $template += "`ncreditReport:`n  url: ''`nrateLimit:`n  tpm: 0`n  qpm: 0`n"
    # Persist session bindings before the first request, so every client type
    # can resolve its identity through memory-bridge (including after restart).
    $template += "`nstorage:`n  enabled: true`n  backend: sqlite`n  sqlite:`n    dbPath: /data/tdai-memory-proxy/storage.db`n"
    # Proxy reads Langfuse from YAML; core and knowledge read environment variables.
    $lfHost = ConvertTo-Json -InputObject ([string]$coreEnv.LANGFUSE_HOST).TrimEnd('/') -Compress
    $lfPublic = ConvertTo-Json -InputObject ([string]$coreEnv.LANGFUSE_PUBLIC_KEY) -Compress
    $lfSecret = ConvertTo-Json -InputObject ([string]$coreEnv.LANGFUSE_SECRET_KEY) -Compress
    $lfEnabled = $langfuseEnabled.ToString().ToLowerInvariant()
    $template += "`nlangfuse:`n  enabled: $lfEnabled`n  host: $lfHost`n  publicKey: $lfPublic`n  secretKey: $lfSecret`n  debug: false`n"
    if ($template -match '\$\{|\$\(bool') { throw 'Unresolved proxy template variables.' }
    New-Item -ItemType Directory -Path .proxy-config -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot '.proxy-config/config.yaml'), $template, [Text.UTF8Encoding]::new($false))
    # Recreate proxy to reload its generated bind-mounted config, including when
    # only this script/template changed. Compose starts both dependencies as well.
    docker compose up -d --wait --wait-timeout 240 --force-recreate proxy
    if ($LASTEXITCODE -ne 0) { throw 'Services did not become healthy. Inspect docker compose logs.' }

    $port = ($resolved.services.'memory-core'.ports | Select-Object -First 1).published
    $base = "http://127.0.0.1:$port"
    $headers = @{ 'x-tdai-service-id' = 'default' }
    $keyPath = Join-Path $PSScriptRoot '.admin-key'
    if (Test-Path $keyPath) { $adminKey = [IO.File]::ReadAllText($keyPath).Trim() }
    else {
        $adminKey = 'sk-mem-' + [Guid]::NewGuid().ToString('N')
        $body = @{ username = 'admin'; user_key = $adminKey } | ConvertTo-Json
        $null = Invoke-RestMethod "$base/v3/internal/meta/user/init-admin" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
        [IO.File]::WriteAllText($keyPath, $adminKey, [Text.UTF8Encoding]::new($false))
    }
    $verification = Invoke-RestMethod "$base/v3/meta/auth/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ user_key = $adminKey } | ConvertTo-Json)
    if (!$verification.data.valid) { throw 'Admin key verification failed.' }
    $panelPort = ($resolved.services.'memory-hub'.ports | Where-Object target -eq 8125).published
    Write-Host "Services healthy. Panel: http://localhost:$panelPort"
    Write-Host "Admin login key: $keyPath"
    if ($unconfigured) { Write-Warning 'LLM is not configured. UI is ready; LLM extraction and upstream chat are not available yet.' }
} finally { Pop-Location }
