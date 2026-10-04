$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($service in @(
    @{ Name = 'core'; Container = 'tdai-memory-core'; Directory = '/app' },
    @{ Name = 'knowledge'; Container = 'tdai-memory-hub'; Directory = '/app/knowledge' },
    @{ Name = 'proxy'; Container = 'tdai-proxy'; Directory = '/app' }
)) {
    docker cp (Join-Path $PSScriptRoot 'verify-langfuse.mjs') "$($service.Container):/tmp/verify-langfuse.mjs"
    if ($LASTEXITCODE -ne 0) { throw "Cannot copy smoke test to $($service.Container)" }
    $nodeArgs = @('node')
    if ($service.Name -eq 'core') { $nodeArgs += @('--import', 'tsx') }
    docker exec -w $service.Directory $service.Container @nodeArgs /tmp/verify-langfuse.mjs $service.Name
    if ($LASTEXITCODE -ne 0) { throw "Langfuse verification failed for $($service.Name)" }
}
