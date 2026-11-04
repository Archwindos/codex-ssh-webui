param()
$ErrorActionPreference = 'Stop'
# npm can inherit PowerShell 7 module paths; load the module for this host.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
. (Join-Path $PSScriptRoot 'windows.ps1')

function Assert-Test { param([bool]$Condition, [string]$Message); if (!$Condition) { throw $Message } }
function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $threw = $false
    try { & $Action | Out-Null } catch { $threw = $true }
    Assert-Test $threw $Message
}
function Get-FreeTestPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('webui client tests ' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$children = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$oldMode = $env:WEBUI_CLIENT_FAKE_MODE
$oldForward = $env:WEBUI_CLIENT_FAKE_FORWARD
$oldProxy = [Net.WebRequest]::DefaultWebProxy
try {
    $configPath = Join-Path $testRoot 'connection.dpapi'
    $statePath = Join-Path $testRoot 'connection.windows.state.json'
    $fakePath = Join-Path $testRoot 'fake ssh.exe'
    Add-Type -OutputAssembly $fakePath -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
public class FakeSsh {
    public static void Main(string[] args) {
        if (Array.IndexOf(args, "-V") >= 0) { Console.WriteLine("OpenSSH_for_Windows_9.5p2"); return; }
        if (Array.IndexOf(args, "--echo-args") >= 0) {
            foreach (string arg in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
            return;
        }
        int forward = Array.IndexOf(args, "-L");
        string[] parts = args[forward + 1].Split(':');
        if (Array.IndexOf(args, "-G") >= 0) {
            Console.WriteLine("localforward [127.0.0.1]:" + parts[1] + " [127.0.0.1]:" + parts[3]);
            Console.WriteLine("hostname demo-host");
            if (Environment.GetEnvironmentVariable("WEBUI_CLIENT_FAKE_FORWARD") == "extra") Console.WriteLine("remoteforward 9090 127.0.0.1:9090");
            return;
        }
        string mode = Environment.GetEnvironmentVariable("WEBUI_CLIENT_FAKE_MODE");
        if (mode == "fail") Environment.Exit(23);
        TcpListener listener = new TcpListener(IPAddress.Loopback, Int32.Parse(parts[1]));
        listener.Start();
        while (true) {
            using (TcpClient client = listener.AcceptTcpClient()) {
                client.ReceiveTimeout = 2000;
                using (NetworkStream stream = client.GetStream()) {
                    StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    string first = reader.ReadLine(), line; bool origin = false;
                    while (!String.IsNullOrEmpty(line = reader.ReadLine())) {
                        if (line.Equals("X-Relay-Origin: http://127.0.0.1:" + parts[1], StringComparison.OrdinalIgnoreCase)) origin = true;
                    }
                    string body = "{\"mode\":\"production\",\"authenticated\":false,\"authTransport\":\"bearer\",\"eventTransport\":\"poll\",\"connected\":true,\"capabilities\":{\"overview\":true},\"projects\":[],\"csrf\":\"" + new String('a',43) + "\",\"sessionToken\":\"" + new String('b',43) + "\"}";
                    if (mode == "bad" || !origin || first != "GET /api/session HTTP/1.1") body = "{\"authenticated\":true}";
                    byte[] response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body);
                    stream.Write(response, 0, response.Length);
                }
            }
        }
    }
}
'@
    $script:sshCalls = 0
    function Get-DesktopSshPath { $script:sshCalls++; return $fakePath }
    $script:opened = @()
    function Open-DesktopBrowser { param([string]$Url); $script:opened += $Url }

    $config = @{ host = 'demo-host'; sshPort = '22'; user = 'demo-user'; password = 'test-only-$() & "quoted" password'; localPort = [string](Get-FreeTestPort); remotePort = '8443' }
    Write-DesktopConfig $configPath $config
    $originalConfigure = (Get-Item Function:\Set-DesktopConfig).ScriptBlock
    $script:configureFixture = $config.Clone()
    function Set-DesktopConfig { param([string]$Path); Write-DesktopConfig $Path $script:configureFixture; return $script:configureFixture }
    try {
        $callsBefore = $script:sshCalls
        Invoke-DesktopClient $configPath $statePath -Configure
        Assert-Test ($script:sshCalls -eq $callsBefore) '-Configure must save and return without looking up or launching SSH.'
        Assert-Test ((Read-DesktopConfig $configPath).host -ceq $config.host) '-Configure did not save the connection.'
    } finally { Set-Item Function:\Set-DesktopConfig -Value $originalConfigure }
    Assert-Test ((Read-DesktopConfig $configPath).password -ceq $config.password) 'DPAPI round trip changed the password.'
    $encryptedText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($configPath))
    foreach ($value in @($config.host, $config.user, $config.password, 'password')) { Assert-Test (!$encryptedText.Contains($value)) 'Saved connection contains plaintext settings.' }
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($path in @($testRoot, $configPath)) {
        $acl = Get-Acl -LiteralPath $path
        Assert-Test $acl.AreAccessRulesProtected 'Credential ACL still inherits other users.'
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        Assert-Test ($rules.Count -eq 2) 'Credential ACL contains extra principals.'
        foreach ($rule in $rules) { Assert-Test ($rule.IdentityReference.Value -in @($userSid, 'S-1-5-18') -and $rule.AccessControlType -eq 'Allow') 'Credential ACL allows an unexpected principal.' }
    }
    foreach ($invalid in @('-oProxyCommand=evil', 'host;whoami', 'host$(evil)', '"host"', "host`thost", 'user@host', '[::1]')) {
        $bad = $config.Clone(); $bad.host = $invalid
        Assert-Throws { Assert-DesktopConfig $bad } 'Unsafe host was accepted.'
    }
    foreach ($invalid in @('', '0', '65536', '080', '22;cmd', '-1')) {
        $bad = $config.Clone(); $bad.sshPort = $invalid
        Assert-Throws { Assert-DesktopConfig $bad } 'Invalid SSH port was accepted.'
    }
    $bad = $config.Clone(); $bad.localPort = '443'
    Assert-Throws { Assert-DesktopConfig $bad } 'Privileged local port was accepted.'
    $bad = $config.Clone(); $bad.extra = 'secret'
    Assert-Throws { Assert-DesktopConfig $bad } 'Unknown setting was accepted.'
    $bad = $config.Clone(); $bad.password = "line`nline"
    Assert-Throws { Assert-DesktopConfig $bad } 'Password containing a control character was accepted.'
    [IO.File]::WriteAllBytes($configPath, [byte[]]@(1, 2, 3))
    Assert-Throws { Read-DesktopConfig $configPath } 'Corrupt encrypted credentials were accepted.'
    Write-DesktopConfig $configPath $config
    $askpass = Initialize-DesktopAskpass $testRoot
    [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($askpass)) | Out-Null
    Assert-Test ([DesktopAskPass]::Classify("demo-user@demo-host's password: ", "demo-user@demo-host's password:") -eq 'password') 'Standard password prompt was not recognized.'
    Assert-Test ([DesktopAskPass]::Classify("other-user@demo-host's password: ", "demo-user@demo-host's password:") -eq 'reject') 'Wrong username prompt was accepted.'
    Assert-Test ([DesktopAskPass]::Classify('Enter passphrase for key: ', "demo-user@demo-host's password:") -eq 'reject') 'Private key prompt was accepted.'
    Assert-Test ([DesktopAskPass]::Classify('Password: ', "demo-user@demo-host's password:") -eq 'reject') 'Arbitrary password prompt was accepted.'
    Assert-Test ([DesktopAskPass]::Classify('Are you sure you want to continue connecting (yes/no)?', "demo-user@demo-host's password:") -eq 'reject') 'Host key without fingerprint was accepted.'
    Assert-Test ([DesktopAskPass]::Classify('ED25519 key fingerprint is SHA256:abc123. Are you sure you want to continue connecting (yes/no/[fingerprint])?', "demo-user@demo-host's password:") -eq 'hostkey') 'Host key was not separated from password.'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $askpass; $info.Arguments = Get-DesktopArgumentLine @("demo-user@demo-host's password: ")
    $info.UseShellExecute = $false; $info.RedirectStandardOutput = $true
    $info.EnvironmentVariables['CODEX_WEBUI_CREDENTIAL_FILE'] = $configPath
    $info.EnvironmentVariables['CODEX_WEBUI_PASSWORD_PROMPT'] = "demo-user@demo-host's password:"
    $answer = [Diagnostics.Process]::Start($info); $children.Add($answer)
    $received = $answer.StandardOutput.ReadToEnd(); $answer.WaitForExit()
    Assert-Test ($answer.ExitCode -eq 0 -and $received -ceq ($config.password + "`n")) 'Askpass did not return the exact saved password over its private stdout pipe.'
    $info.Arguments = Get-DesktopArgumentLine @('Password: ')
    $answer = [Diagnostics.Process]::Start($info); $children.Add($answer)
    $received = $answer.StandardOutput.ReadToEnd(); $answer.WaitForExit()
    Assert-Test ($answer.ExitCode -ne 0 -and $received -eq '') 'Unknown prompt leaked a password.'
    $arguments = Get-DesktopSshArguments $config -BatchMode
    Assert-Test ($arguments -contains 'BatchMode=yes') 'BatchMode switch was lost.'
    Assert-Test ($arguments -contains 'StrictHostKeyChecking=ask') 'Host-key verification was weakened.'
    Assert-Test ($arguments -notcontains $config.password) 'Password was placed in SSH arguments.'
    Assert-DesktopForwarding $fakePath $arguments $config | Out-Null
    $env:WEBUI_CLIENT_FAKE_FORWARD = 'extra'
    Assert-Throws { Assert-DesktopForwarding $fakePath $arguments $config } 'Additional SSH forwards were accepted.'
    $env:WEBUI_CLIENT_FAKE_FORWARD = ''
    Write-Host 'PASS DPAPI-only storage, private ACL, prompt separation, safe configuration, and SSH effective forwarding'

    $quoteArgs = @('--echo-args', '', 'a path with spaces', 'a"quote', 'C:\a path\', 'plain', 'slashes\\"quote')
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $fakePath; $info.Arguments = Get-DesktopArgumentLine $quoteArgs
    $info.UseShellExecute = $false; $info.RedirectStandardOutput = $true
    $echo = [Diagnostics.Process]::Start($info); $children.Add($echo)
    $actual = @($echo.StandardOutput.ReadToEnd() -split '\r?\n' | Select-Object -SkipLast 1 | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
    $echo.WaitForExit()
    Assert-Test ($actual.Count -eq $quoteArgs.Count) 'Native argument count changed.'
    for ($i = 0; $i -lt $quoteArgs.Count; $i++) { Assert-Test ($actual[$i] -ceq $quoteArgs[$i]) 'Native argument quoting changed a value.' }
    Write-Host 'PASS executable paths and argument quoting with spaces, quotes, and backslashes'

    $foreign = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$config.localPort)
    try {
        $foreign.Start()
        Assert-Throws { Invoke-DesktopClient $configPath $statePath -NoBrowser -BatchMode -CheckConnection } 'Foreign occupied port was accepted.'
        Assert-Test ($foreign.Server.IsBound) 'Foreign listener was stopped.'
        Assert-Test ($script:opened.Count -eq 0) 'Browser opened for a foreign listener.'
    } finally { $foreign.Stop() }
    $env:WEBUI_CLIENT_FAKE_MODE = 'fail'
    Assert-Throws { Invoke-DesktopClient $configPath $statePath -BatchMode -CheckConnection } 'SSH startup failure was accepted.'
    Assert-Test ($script:opened.Count -eq 0) 'Browser opened after SSH failure.'
    Write-Host 'PASS occupied foreign port and SSH startup failure do not open browser'

    $argumentLine = Get-DesktopArgumentLine $arguments
    $env:WEBUI_CLIENT_FAKE_MODE = 'bad'
    $badProcess = Start-DesktopSsh $fakePath $argumentLine $configPath $askpass "demo-user@demo-host's password:"; $children.Add($badProcess)
    Assert-Throws { Wait-DesktopReady $badProcess ([int]$config.localPort) -TimeoutSeconds 2 } 'Unrecognized HTTP service was accepted.'
    $badProcess.Kill(); $badProcess.WaitForExit()
    Assert-Test ($script:opened.Count -eq 0) 'Browser opened for an unrecognized service.'

    $env:WEBUI_CLIENT_FAKE_MODE = 'healthy'
    [Net.WebRequest]::DefaultWebProxy = [Net.WebProxy]::new('http://127.0.0.1:1')
    Invoke-DesktopClient $configPath $statePath -NoBrowser -BatchMode -CheckConnection
    Assert-Test ($script:opened.Count -eq 0) '-NoBrowser was ignored.'
    Assert-Test (!(Test-Path -LiteralPath $statePath)) 'Diagnostic run left its ownership state behind.'
    Assert-Test (Test-DesktopPortFree ([int]$config.localPort)) 'Diagnostic run left its own SSH listener behind.'
    Invoke-DesktopClient $configPath $statePath -BatchMode -CheckConnection
    Assert-Test ($script:opened.Count -eq 1) 'Verified readiness did not request exactly one browser open.'
    Write-Host 'PASS bounded health check, explicit origin, proxy bypass, browser readiness, and diagnostic cleanup'

    $own = Start-DesktopSsh $fakePath $argumentLine $configPath $askpass "demo-user@demo-host's password:"; $children.Add($own)
    Wait-DesktopReady $own ([int]$config.localPort) -TimeoutSeconds 10
    $identity = Get-DesktopProcessIdentity $own $fakePath $argumentLine
    Assert-Test ($null -ne $identity) 'Owned process could not be identified.'
    $identity.ConfigHash = Get-DesktopConfigHash $configPath
    [IO.File]::WriteAllText($statePath, ($identity | ConvertTo-Json -Compress))
    $matched = Get-DesktopOwnedProcess $statePath $identity.ConfigHash $fakePath $argumentLine
    Assert-Test ($null -ne $matched -and $matched.Id -eq $own.Id) 'Exact live SSH ownership was not recognized.'
    Invoke-DesktopClient $configPath $statePath -BatchMode -CheckConnection
    Assert-Test ($script:opened.Count -eq 2 -and !$own.HasExited) 'Reuse must open the verified service and leave its original process running.'
    $saved = [IO.File]::ReadAllText($statePath)
    Assert-Test ($saved -notmatch 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') 'Probe tokens were stored.'
    foreach ($field in @('StartTicks', 'ArgumentHash', 'ConfigHash', 'Executable')) {
        $tampered = $identity.Clone(); $tampered[$field] = 'different'
        [IO.File]::WriteAllText($statePath, ($tampered | ConvertTo-Json -Compress))
        Assert-Test ($null -eq (Get-DesktopOwnedProcess $statePath $identity.ConfigHash $fakePath $argumentLine)) "Mismatched $field was accepted for reuse."
    }
    Assert-Throws { Invoke-DesktopClient $configPath $statePath -NoBrowser -BatchMode -CheckConnection } 'An unowned live listener was accepted.'
    Assert-Test (!$own.HasExited) 'A rejected ownership record caused a foreign process to be stopped.'
    Assert-Test ((Read-DesktopConfig $configPath).password -ceq $config.password) 'Runtime changed the encrypted saved password.'
    Invoke-DesktopClient $configPath $statePath -ForgetCredentials
    Assert-Test (!(Test-Path -LiteralPath $configPath)) 'ForgetCredentials left the credential file.'
    Assert-Test (!$own.HasExited) 'Forgetting credentials stopped an existing connection.'
    Write-Host 'PASS exact ownership reuse, mismatched state rejection, and no session-secret storage'
    Write-Host 'All Windows desktop-client tests passed. No real SSH connection or browser was launched.'
} finally {
    foreach ($child in $children) {
        try { if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }; $child.Dispose() } catch { }
    }
    $env:WEBUI_CLIENT_FAKE_MODE = $oldMode
    $env:WEBUI_CLIENT_FAKE_FORWARD = $oldForward
    [Net.WebRequest]::DefaultWebProxy = $oldProxy
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\webui client tests '
    if ($resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
