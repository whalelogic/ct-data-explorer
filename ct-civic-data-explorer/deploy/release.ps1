param(
    [Parameter(Mandatory)] [ValidateSet('staging', 'production')] [string]$Environment,
    [Parameter(Mandatory)] [string]$Project,
    [string]$Zone = 'us-central1-a',
    [string]$AdminEmail = '',
    [string]$HostKey = '',
    [string]$GeminiKeyId = ''
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$repository = Split-Path -Parent $app
$profiles = 'sample-data/Housing and Town Profiles/Housing and Town Profiles/Town Profiles'
$samples = @(
    'sample-data/acs2024_sample.csv',
    "$profiles/FINAL Town Profiles 2026 - Industry Jobs.xlsx",
    "$profiles/FINAL Town Profiles 2026 - Key Employers.xlsx",
    "$profiles/FINAL Town Profiles 2026 - Population Within 45 Minutes.xlsx"
)
$instance = "ctde-$Environment"
if (!$GeminiKeyId) { $GeminiKeyId = "$instance-app" }
$cloudArgs = @("--project=$Project", "--zone=$Zone", '--tunnel-through-iap', '--quiet',
    '--strict-host-key-checking=yes', '--ssh-key-expire-after=2h')
$sshArgs = @()
$scpArgs = @()
if ($HostKey) {
    # The Windows SDK uses PuTTY. Pin the key supplied by the Compute Engine serial log.
    $sshArgs += @('--ssh-flag=-batch', '--ssh-flag=-hostkey', "--ssh-flag=$HostKey")
    $scpArgs += @("--scp-flag=-hostkey", "--scp-flag=$HostKey")
}

function Require-Success([string]$Operation) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed (exit $LASTEXITCODE)"
    }
}

if ($AdminEmail -and $AdminEmail -notmatch '^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+$') {
    throw 'AdminEmail must be an email address.'
}

$ip = gcloud compute instances describe $instance "--project=$Project" "--zone=$Zone" '--format=value(networkInterfaces[0].accessConfigs[0].natIP)'
Require-Success 'Reading the instance address'
if ($ip -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw 'The instance needs a static IPv4 address.'
}

$id = [Guid]::NewGuid().ToString('N')
$scratch = Join-Path ([IO.Path]::GetTempPath()) "ctde-$id"
$archive = Join-Path $scratch "$id.tar.gz"
$secret = Join-Path $scratch "$id.key"
$remote = ".ctde-uploads/$id"
try {
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        New-Item -Path $scratch -ItemType Directory | Out-Null
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $scratch -AclObject $acl
    } else {
        mkdir -m 700 $scratch
        Require-Success 'Creating a private transfer directory'
    }

    tar -czf $archive -C $app Dockerfile .dockerignore package.json package-lock.json src public migrations scripts deploy -C $repository @samples
    Require-Success 'Packaging the app'

    $key = gcloud services api-keys get-key-string $GeminiKeyId "--project=$Project" '--format=value(keyString)' --verbosity=error
    Require-Success 'Getting the Gemini key'
    if ($key -notmatch '^[a-zA-Z0-9_.-]+$') {
        throw 'No Gemini API key was returned.'
    }
    [IO.File]::WriteAllText($secret, "$key`n")

    gcloud compute ssh $instance @cloudArgs '--command=sudo test -e /opt/ctde/.host-ready && install -d -m 700 .ctde-uploads' @sshArgs
    Require-Success 'Checking the deployment host'
    gcloud compute scp $archive $secret "${instance}:.ctde-uploads/" @cloudArgs @scpArgs
    Require-Success 'Uploading the release through IAP'

    $run = "set -e; umask 077; trap 'rm -f $remote.tar.gz $remote.sh $remote.key' EXIT; tar -xOzf $remote.tar.gz deploy/release.sh > $remote.sh; sudo bash $remote.sh $remote.tar.gz $Environment $ip '$AdminEmail' < $remote.key"
    gcloud compute ssh $instance @cloudArgs "--command=$run" @sshArgs
    Require-Success 'Releasing the app'
} finally {
    Remove-Variable key -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $secret -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $archive -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -ErrorAction SilentlyContinue
}

for ($attempt = 0; $attempt -lt 36; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "https://$ip/healthz" -TimeoutSec 5
        if ($health.status -eq 'ok') {
            Write-Output "$Environment is operational at https://$ip"
            exit 0
        }
    } catch {
        Start-Sleep -Seconds 5
    }
}
throw "Public HTTPS health check failed for https://$ip/healthz."
