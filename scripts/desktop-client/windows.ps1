param([switch]$Configure, [switch]$ForgetCredentials, [switch]$NoBrowser, [switch]$BatchMode, [switch]$CheckConnection)

# Windows PowerShell 5.1. The SSH child shares this visible console.
function Assert-DesktopConfig {
    param([System.Collections.IDictionary]$Config)
    $keys = @('host', 'sshPort', 'user', 'password', 'localPort', 'remotePort')
    if ($Config.Count -ne 6) { throw 'The encrypted connection settings are incomplete. Use -Configure to replace them.' }
    foreach ($key in $Config.Keys) {
        if ($keys -cnotcontains $key) { throw 'Unknown encrypted connection setting.' }
    }
    if ([string]$Config.host -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') {
        throw 'Server address must be a hostname, IPv4 address, or SSH alias using letters, digits, dots, underscores, and hyphens.'
    }
    if ([string]$Config.user -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw 'SSH username contains unsupported characters.' }
    if ([string]::IsNullOrEmpty([string]$Config.password) -or [string]$Config.password -match '[\x00-\x1f\x7f]') { throw 'Enter a nonempty SSH password without control characters.' }
    foreach ($key in @('sshPort', 'localPort', 'remotePort')) {
        $value = [string]$Config[$key]
        if ($value -cnotmatch '^[1-9][0-9]{0,4}$' -or [int]$value -gt 65535) { throw "Invalid port in $key." }
        if ($key -eq 'localPort' -and [int]$value -lt 1024) { throw 'Local WebUI port must be between 1024 and 65535.' }
    }
}

function Set-DesktopPrivateAcl {
    param([string]$Path, [switch]$Directory)
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The credential path must not be a symbolic link or junction.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = if ($Directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = if ($Directory) {
            [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else { [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
    }
    if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) } else { [IO.File]::SetAccessControl($Path, $acl) }
}

function Initialize-DesktopPrivateDirectory {
    param([string]$Path)
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    Set-DesktopPrivateAcl $Path -Directory
}

function Write-DesktopConfig {
    param([string]$Path, [System.Collections.IDictionary]$Config)
    Assert-DesktopConfig $Config
    Initialize-DesktopPrivateDirectory ([IO.Path]::GetDirectoryName($Path))
    Add-Type -AssemblyName System.Security
    $plain = [Text.Encoding]::UTF8.GetBytes(($Config | ConvertTo-Json -Compress))
    try { $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
    if (!(Test-Path -LiteralPath $Path)) { [IO.File]::WriteAllBytes($Path, [byte[]]@()) }
    Set-DesktopPrivateAcl $Path
    [IO.File]::WriteAllBytes($Path, $encrypted)
}

function Read-DesktopConfig {
    param([string]$Path)
    Add-Type -AssemblyName System.Security
    $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($Path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $object = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
        $config = @{}
        foreach ($property in $object.PSObject.Properties) { $config[$property.Name] = $property.Value }
    } catch { throw 'Could not decrypt the saved connection for this Windows user. Use -Configure to replace it.' }
    finally { if ($plain) { [Array]::Clear($plain, 0, $plain.Length) } }
    Assert-DesktopConfig $config
    return $config
}

function Set-DesktopConfig {
    param([string]$Path)
    $config = @{ host = ''; sshPort = ''; user = ''; password = ''; localPort = '8443'; remotePort = '8443' }
    if (Test-Path -LiteralPath $Path) {
        try { $config = Read-DesktopConfig $Path } catch { Write-Host 'Replacing invalid connection settings.' }
    }
    Write-Host 'Enter your server connection. All settings, including the password, are encrypted for this Windows user.'
    foreach ($key in @('host', 'sshPort', 'user', 'localPort', 'remotePort')) {
        $hint = [string]$config[$key]
        $value = Read-Host "$key [$hint]"
        if ($value -ne '') { $config[$key] = $value }
    }
    $secure = Read-Host 'SSH password (blank keeps an existing saved password)' -AsSecureString
    if ($secure.Length -gt 0) {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $config.password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    } else { $secure.Dispose() }
    Write-DesktopConfig $Path $config
    return $config
}

function Get-DesktopConfigHash {
    param([string]$Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-DesktopArgumentHash {
    param([string]$Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Initialize-DesktopAskpass {
    param([string]$Directory)
    $source = Join-Path $PSScriptRoot 'windows-askpass.cs'
    $executable = Join-Path $Directory 'windows-askpass.exe'
    $hashPath = Join-Path $Directory 'windows-askpass.sha256'
    $hash = Get-DesktopConfigHash $source
    if (!(Test-Path -LiteralPath $executable) -or !(Test-Path -LiteralPath $hashPath) -or [IO.File]::ReadAllText($hashPath) -cne $hash) {
        if (Test-Path -LiteralPath $executable) { Remove-Item -LiteralPath $executable -Force }
        Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ReferencedAssemblies System.Security.dll,System.Windows.Forms.dll,System.Web.Extensions.dll -OutputAssembly $executable -OutputType WindowsApplication
        [IO.File]::WriteAllText($hashPath, $hash)
    }
    Set-DesktopPrivateAcl $executable
    Set-DesktopPrivateAcl $hashPath
    return $executable
}

function Get-DesktopSshPath {
    $command = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$command) { throw 'OpenSSH Client (ssh.exe) is missing. Install the Windows OpenSSH Client optional feature first.' }
    return $command.Source
}

function Assert-DesktopAskpassSupport {
    param([string]$SshPath)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $SshPath; $info.Arguments = '-V'; $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    try {
        if (!$process.WaitForExit(3000)) { $process.Kill(); throw 'Could not verify the installed Windows OpenSSH version.' }
        $version = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0 -or $version -notmatch 'OpenSSH_for_Windows_(\d+)\.(\d+)' -or
            [int]$Matches[1] -lt 8 -or ([int]$Matches[1] -eq 8 -and [int]$Matches[2] -lt 4)) {
            throw 'Automatic password entry requires native Windows OpenSSH 8.4 or newer with SSH_ASKPASS_REQUIRE support. No plaintext fallback is used.'
        }
    } finally { $process.Dispose() }
}

function Get-DesktopSshArguments {
    param([System.Collections.IDictionary]$Config, [switch]$BatchMode)
    $argsList = @('-N', '-T', '-L', "127.0.0.1:$($Config.localPort):127.0.0.1:$($Config.remotePort)",
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=ask', '-o', 'EscapeChar=none',
        '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no',
        '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-S', 'none')
    $argsList += @('-o', $(if ($BatchMode) { 'BatchMode=yes' } else { 'BatchMode=no' }))
    return $argsList + @('-p', [string]$Config.sshPort, '-l', [string]$Config.user, [string]$Config.host)
}

function Assert-DesktopForwarding {
    param([string]$SshPath, [string[]]$Arguments, [System.Collections.IDictionary]$Config)
    $effective = @(& $SshPath '-G' @Arguments)
    if ($LASTEXITCODE -ne 0) { throw 'SSH could not read the effective SSH configuration.' }
    $forwards = @($effective | Where-Object { $_ -match '^(localforward|remoteforward|dynamicforward)\s' })
    $expected = "localforward 127.0.0.1:$($Config.localPort) 127.0.0.1:$($Config.remotePort)"
    if ($forwards.Count -ne 1 -or (($forwards[0] -replace '[\[\]]', '') -cne $expected)) {
        throw 'SSH config must leave exactly this launcher''s loopback LocalForward. Remove extra LocalForward/RemoteForward/DynamicForward or ClearAllForwardings from this alias.'
    }
    $hostLine = @($effective | Where-Object { $_ -match '^hostname\s' })
    if ($hostLine.Count -ne 1) { throw 'SSH did not report one effective hostname.' }
    $promptHost = ($hostLine[0] -replace '^hostname\s+', '').ToLowerInvariant()
    $aliasLine = @($effective | Where-Object { $_ -match '^hostkeyalias\s' })
    if ($aliasLine.Count -gt 0) {
        $alias = $aliasLine[0] -replace '^hostkeyalias\s+', ''
        if ($alias -ne 'none' -and $alias -ne '') { $promptHost = $alias }
    }
    if ($promptHost -match '[\x00-\x1f\x7f]') { throw 'Unsupported SSH host alias.' }
    return "$($Config.user)@${promptHost}'s password:"
}

function ConvertTo-DesktopNativeArgument {
    param([AllowEmptyString()][string]$Value)
    # CommandLineToArgvW quoting, including quotes and trailing backslashes.
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Get-DesktopArgumentLine {
    param([string[]]$Arguments)
    return ($Arguments | ForEach-Object { ConvertTo-DesktopNativeArgument $_ }) -join ' '
}

function Get-DesktopProcessIdentity {
    param([Diagnostics.Process]$Process, [string]$SshPath, [string]$ArgumentLine)
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return $null }
        $actualPath = $Process.MainModule.FileName
        $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction Stop).CommandLine
        $quoted = '"' + $SshPath + '" ' + $ArgumentLine
        $bare = $SshPath + ' ' + $ArgumentLine
        if ($actualPath -ine $SshPath -or ($command -cne $quoted -and ($SshPath -match '\s' -or $command -cne $bare))) { return $null }
        return @{ Pid = $Process.Id; StartTicks = [string]$Process.StartTime.ToUniversalTime().Ticks; Executable = $actualPath; ArgumentHash = (Get-DesktopArgumentHash $ArgumentLine) }
    } catch { return $null }
}

function Get-DesktopOwnedProcess {
    param([string]$StatePath, [string]$ConfigHash, [string]$SshPath, [string]$ArgumentLine)
    try {
        $record = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
        if ($record.ConfigHash -cne $ConfigHash -or $record.ArgumentHash -cne (Get-DesktopArgumentHash $ArgumentLine)) { return $null }
        $process = Get-Process -Id ([int]$record.Pid) -ErrorAction Stop
        $identity = Get-DesktopProcessIdentity $process $SshPath $ArgumentLine
        if (!$identity -or $identity.StartTicks -cne $record.StartTicks -or $identity.Executable -ine $record.Executable -or $identity.ArgumentHash -cne $record.ArgumentHash) { return $null }
        return $process
    } catch { return $null }
}

function Test-DesktopPortFree {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function Test-DesktopOwnedListener {
    param([Diagnostics.Process]$Process, [int]$Port)
    $Process.Refresh()
    if ($Process.HasExited) { return $false }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    return @($listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $Process.Id }).Count -gt 0
}

function Test-DesktopSession {
    param([int]$Port)
    $origin = "http://127.0.0.1:$Port"
    $request = [Net.HttpWebRequest]::Create("$origin/api/session")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1200
    $request.ReadWriteTimeout = 1200
    $request.Headers['X-Relay-Origin'] = $origin
    $response = $null; $reader = $null
    try {
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ContentType -notmatch '^application/json(?:;|$)' -or $response.ContentLength -gt 65536) { return $false }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        $buffer = New-Object char[] 65537
        $count = 0
        $readDeadline = [DateTime]::UtcNow.AddMilliseconds(1200)
        while ($count -lt $buffer.Length) {
            $remaining = [int]($readDeadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { return $false }
            $readTask = $reader.ReadAsync($buffer, $count, $buffer.Length - $count)
            if (!$readTask.Wait($remaining)) { return $false }
            $read = $readTask.Result
            if ($read -eq 0) { break }
            $count += $read
        }
        if ($count -gt 65536) { return $false }
        $session = ([string]::new($buffer, 0, $count)) | ConvertFrom-Json
        return ($session.mode -ceq 'production' -and $session.authenticated -is [bool] -and !$session.authenticated -and
            $session.authTransport -ceq 'bearer' -and $session.eventTransport -ceq 'poll' -and
            $session.csrf -cmatch '^[A-Za-z0-9_-]{43}$' -and $session.sessionToken -cmatch '^[A-Za-z0-9_-]{43}$' -and
            $session.connected -is [bool] -and $session.capabilities.overview -eq $true -and $session.projects -is [array])
    } catch { return $false }
    finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Dispose() }; $request.Abort() }
}

function Wait-DesktopReady {
    param([Diagnostics.Process]$Process, [int]$Port, [int]$TimeoutSeconds = 90)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw "SSH exited before the WebUI was ready (exit $($Process.ExitCode))." }
        if ((Test-DesktopOwnedListener $Process $Port) -and (Test-DesktopSession $Port) -and (Test-DesktopOwnedListener $Process $Port)) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "The SSH tunnel did not reach a recognizable WebUI session within $TimeoutSeconds seconds. Check SSH authentication and the existing remote WebUI."
}

function Start-DesktopSsh {
    param([string]$SshPath, [string]$ArgumentLine, [string]$ConfigPath, [string]$AskpassPath, [string]$PasswordPrompt)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $SshPath; $info.Arguments = $ArgumentLine
    $info.UseShellExecute = $false; $info.CreateNoWindow = $false
    $info.EnvironmentVariables['SSH_ASKPASS'] = $AskpassPath
    $info.EnvironmentVariables['SSH_ASKPASS_REQUIRE'] = 'force'
    $info.EnvironmentVariables['CODEX_WEBUI_CREDENTIAL_FILE'] = $ConfigPath
    $info.EnvironmentVariables['CODEX_WEBUI_PASSWORD_PROMPT'] = $PasswordPrompt
    return [Diagnostics.Process]::Start($info)
}

function Open-DesktopBrowser {
    param([string]$Url)
    Start-Process $Url | Out-Null
}

function Wait-DesktopConnection {
    param([Diagnostics.Process]$Process)
    while (!$Process.WaitForExit(250)) { }
}

function Invoke-DesktopClient {
    param([string]$ConfigPath, [string]$StatePath, [switch]$Configure, [switch]$ForgetCredentials, [switch]$NoBrowser, [switch]$BatchMode, [switch]$CheckConnection)
    if ($ForgetCredentials) {
        if ($Configure) { throw 'Choose either -Configure or -ForgetCredentials.' }
        if (Test-Path -LiteralPath $ConfigPath) { Remove-Item -LiteralPath $ConfigPath -Force }
        Write-Host 'Saved connection credentials were forgotten. Close any existing connection window separately.'
        return
    }
    Initialize-DesktopPrivateDirectory ([IO.Path]::GetDirectoryName($ConfigPath))
    if (Test-Path -LiteralPath $ConfigPath) { Set-DesktopPrivateAcl $ConfigPath }
    if ($Configure) {
        Set-DesktopConfig $ConfigPath | Out-Null
        Write-Host 'Connection settings saved. Open WebUI to connect.'
        return
    }
    $config = if (!(Test-Path -LiteralPath $ConfigPath)) { Set-DesktopConfig $ConfigPath } else { Read-DesktopConfig $ConfigPath }
    $ssh = Get-DesktopSshPath
    Assert-DesktopAskpassSupport $ssh
    $askpass = Initialize-DesktopAskpass ([IO.Path]::GetDirectoryName($ConfigPath))
    $arguments = Get-DesktopSshArguments $config -BatchMode:$BatchMode
    $passwordPrompt = Assert-DesktopForwarding $ssh $arguments $config
    $argumentLine = Get-DesktopArgumentLine $arguments
    $hash = Get-DesktopConfigHash $ConfigPath
    $url = "http://127.0.0.1:$($config.localPort)/"
    $existing = Get-DesktopOwnedProcess $StatePath $hash $ssh $argumentLine
    if ($existing) {
        if (!(Test-DesktopOwnedListener $existing ([int]$config.localPort)) -or !(Test-DesktopSession ([int]$config.localPort)) -or !(Test-DesktopOwnedListener $existing ([int]$config.localPort))) {
            throw 'The recorded SSH connection is still running but its WebUI is not ready. Check its original window.'
        }
        if (!$NoBrowser) { Open-DesktopBrowser $url }
        Write-Host "Reused the verified connection: $url (keep its original terminal open)."
        return
    }
    if (!(Test-DesktopPortFree ([int]$config.localPort))) { throw "Local port $($config.localPort) is already in use. No process was stopped. Choose another local port with -Configure." }
    Write-Host 'Connecting with your saved credentials. Verify any SSH host-key fingerprint prompt.'
    Write-Host 'Keep this window open. Ctrl+C or closing it stops only this SSH connection.'
    $process = $null
    try {
        $process = Start-DesktopSsh $ssh $argumentLine $ConfigPath $askpass $passwordPrompt
        Wait-DesktopReady $process ([int]$config.localPort)
        $identity = Get-DesktopProcessIdentity $process $ssh $argumentLine
        if (!$identity) { throw 'Could not verify the SSH child identity; the browser was not opened.' }
        $identity.ConfigHash = $hash
        [IO.File]::WriteAllText($StatePath, ($identity | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
        Set-DesktopPrivateAcl $StatePath
        if (!$NoBrowser) { Open-DesktopBrowser $url }
        Write-Host "WebUI ready: $url"
        if ($CheckConnection) { return }
        Wait-DesktopConnection $process
        if ($process.ExitCode -ne 0) { throw "SSH connection ended (exit $($process.ExitCode)). Run the launcher again to reconnect." }
    } finally {
        if ($process) {
            $process.Refresh()
            if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
            try {
                $saved = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
                if ([int]$saved.Pid -eq $process.Id -and $saved.StartTicks -ceq [string]$process.StartTime.ToUniversalTime().Ticks) { Remove-Item -LiteralPath $StatePath -Force }
            } catch { }
            $process.Dispose()
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex SSH WebUI'
        Invoke-DesktopClient -ConfigPath (Join-Path $directory 'connection.dpapi') -StatePath (Join-Path $directory 'connection.windows.state.json') -Configure:$Configure -ForgetCredentials:$ForgetCredentials -NoBrowser:$NoBrowser -BatchMode:$BatchMode -CheckConnection:$CheckConnection
    } catch { Write-Host "Connection failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
}
