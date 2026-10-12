param([Parameter(Mandatory = $true)][string]$WorkerPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $WorkerPath -Library
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class SiphonFetchTestServer : IDisposable {
    private readonly TcpListener listener;
    private readonly CancellationTokenSource stop = new CancellationTokenSource();
    private readonly Task serving;
    private TcpClient connection;
    private readonly string mode;
    public readonly string Uri;

    public SiphonFetchTestServer(string mode) {
        this.mode = mode;
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Uri = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/";
        serving = Serve();
    }

    private async Task Serve() {
        try {
            using (connection = await listener.AcceptTcpClientAsync()) {
                var stream = connection.GetStream();
                var buffer = new byte[1];
                string request = "";
                while (!request.EndsWith("\r\n\r\n", StringComparison.Ordinal)) {
                    if (await stream.ReadAsync(buffer, 0, 1) == 0) return;
                    request += (char)buffer[0];
                    if (request.Length > 4096) throw new InvalidDataException("Oversized test request");
                }
                if (mode == "headers") await Task.Delay(1800, stop.Token);
                var headers = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n");
                await stream.WriteAsync(headers, 0, headers.Length);
                if (mode == "body") await Task.Delay(1800, stop.Token);
                var body = Encoding.ASCII.GetBytes("abc");
                if (mode == "trickle") {
                    for (int i = 0; i < body.Length; i++) {
                        await Task.Delay(120, stop.Token);
                        await stream.WriteAsync(body, i, 1);
                    }
                } else {
                    await stream.WriteAsync(body, 0, body.Length);
                }
            }
        } catch (OperationCanceledException) {
            if (!stop.IsCancellationRequested) throw;
        } catch (IOException) {
            if (!stop.IsCancellationRequested) throw;
        } catch (SocketException) {
            if (!stop.IsCancellationRequested) throw;
        } catch (ObjectDisposedException) {
            if (!stop.IsCancellationRequested) throw;
        }
    }

    public void Dispose() {
        stop.Cancel();
        listener.Stop();
        if (connection != null) connection.Dispose();
        serving.GetAwaiter().GetResult();
        stop.Dispose();
    }
}
'@

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$completed = New-Object 'Threading.Tasks.TaskCompletionSource[int]'
$completed.SetResult(0)
$clock = [Diagnostics.Stopwatch]::StartNew()
$null = Wait-SiphonFetchTask -Task $completed.Task -Budget $clock -BudgetSeconds 20 -Phase 'warmup'

$rejected = $false
try { $null = Invoke-SiphonFetch 'http://127.0.0.1:1/' 16 } catch {
    Assert-True ($_.Exception.Message.Contains('outside the official Siphon release channel')) 'Local network test bypassed the production release allowlist'
    $rejected = $true
}
Assert-True $rejected 'Production fetch accepted a nonofficial release URL'

foreach ($mode in @('complete', 'headers', 'body', 'trickle')) {
    $server = New-Object SiphonFetchTestServer($mode)
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    $response = $null
    $stream = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $bodyClock = $null
    $timedOut = $false
    $phase = 'response headers'
    try {
        $headersBudget = if ($mode -eq 'headers') { 0.2 } else { 5 }
        $response = Wait-SiphonFetchTask -Task ($client.GetAsync($server.Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead)) -Budget $clock -BudgetSeconds $headersBudget -Phase $phase -IdleMilliseconds 1000
        $stream = Wait-SiphonFetchTask -Task ($response.Content.ReadAsStreamAsync()) -Budget $clock -BudgetSeconds 5 -Phase 'response stream'
        $phase = 'body read'
        $bodyClock = [Diagnostics.Stopwatch]::StartNew()
        $overall = if ($mode -eq 'trickle') { 0.3 } else { 5 }
        $idle = if ($mode -eq 'body') { 200 } else { 1000 }
        $bytes = New-Object byte[] 3
        $body = ''
        for (;;) {
            $count = Wait-SiphonFetchTask -Task ($stream.ReadAsync($bytes, 0, $bytes.Length)) -Budget $clock -BudgetSeconds $overall -Phase $phase -IdleMilliseconds $idle
            if ($count -eq 0) { break }
            $body += [Text.Encoding]::ASCII.GetString($bytes, 0, $count)
        }
        Assert-True ($mode -eq 'complete' -and $body -ceq 'abc') 'The native transport accepted a stalled or incomplete body'
    } catch [TimeoutException] {
        Assert-True ($mode -ne 'complete') 'The complete native response timed out'
        Assert-True ($_.Exception.Message.Contains($phase)) 'Timeout did not identify the stalled network phase'
        $elapsed = if ($null -eq $bodyClock) { $clock.ElapsedMilliseconds } else { $bodyClock.ElapsedMilliseconds }
        Assert-True ($elapsed -ge 150 -and $elapsed -lt 1200) 'Native wait did not enforce the actual idle/overall threshold'
        $timedOut = $true
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
        $server.Dispose()
    }
    Assert-True ($timedOut -eq ($mode -ne 'complete')) "Unexpected native timeout result for $mode"
}

$clock = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 250
$rejected = $false
try { $null = Wait-SiphonFetchTask -Task $completed.Task -Budget $clock -BudgetSeconds 0.2 -Phase 'body read' } catch [TimeoutException] {
    $rejected = $true
}
Assert-True $rejected 'Completed EOF bypassed the overall download deadline'

$failed = New-Object 'Threading.Tasks.TaskCompletionSource[int]'
$failed.SetException([IO.IOException]::new('fixture transport failure'))
$rejected = $false
try { $null = Wait-SiphonFetchTask -Task $failed.Task -Budget ([Diagnostics.Stopwatch]::StartNew()) -BudgetSeconds 5 -Phase 'body read' } catch [IO.IOException] {
    Assert-True ($_.Exception.Message.Contains('body read failed: fixture transport failure')) 'Native fault lost its phase or original cause'
    $rejected = $true
}
Assert-True $rejected 'A faulted native transport task reported success'

Write-Output 'PASS: bounded native release transport'
