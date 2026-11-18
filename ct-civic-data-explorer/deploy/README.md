# Deploy to Google Cloud

Use PowerShell 7 with `gcloud`, `tar`, and Node.js 22 or later. Start in `ct-civic-data-explorer/`, or set `$App` to its absolute path if your checkout is in WSL. Staging and production each run on a Compute Engine VM with MySQL and Caddy. Caddy provides public HTTPS, and IAP provides SSH access.

## 1. Provision the project

Choose a globally unique project ID and a billing account you can use. For an existing billing-enabled project, start at `gcloud services enable`.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$App = (Get-Location).Path
$Project = 'your-project-id'
$BillingAccount = 'your-billing-account-id'
$Region = 'us-central1'
$Zone = 'us-central1-a'

gcloud auth login
gcloud projects create $Project --name='CT Data Explorer'
gcloud billing projects link $Project "--billing-account=$BillingAccount"
gcloud services enable compute.googleapis.com iap.googleapis.com iam.googleapis.com `
  apikeys.googleapis.com generativelanguage.googleapis.com "--project=$Project"

gcloud compute networks create ctde-hosting --subnet-mode=custom "--project=$Project"
gcloud compute networks subnets create ctde-central --network=ctde-hosting `
  "--region=$Region" --range=10.27.0.0/24 "--project=$Project"
gcloud compute firewall-rules create ctde-web --network=ctde-hosting `
  '--allow=tcp:80,tcp:443' --source-ranges=0.0.0.0/0 --target-tags=ctde-web "--project=$Project"
gcloud compute firewall-rules create ctde-iap --network=ctde-hosting `
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=ctde-web "--project=$Project"
```

## 2. Create the VMs and Gemini keys

```powershell
foreach ($Environment in 'staging', 'production') {
  $Instance = "ctde-$Environment"
  gcloud compute addresses create $Instance --network-tier=STANDARD `
    "--region=$Region" "--project=$Project"
  $Ip = gcloud compute addresses describe $Instance "--region=$Region" `
    "--project=$Project" '--format=value(address)'

  gcloud compute instances create $Instance "--project=$Project" "--zone=$Zone" `
    --machine-type=e2-micro --subnet=ctde-central "--address=$Ip" --network-tier=STANDARD `
    --no-service-account --no-scopes --tags=ctde-web --metadata=block-project-ssh-keys=TRUE `
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud `
    --boot-disk-type=pd-standard --boot-disk-size=15GB `
    "--metadata-from-file=startup-script=$(Join-Path $App 'deploy/startup.sh')"

  gcloud iam service-accounts create "$Instance-gemini" "--project=$Project"
  gcloud beta services api-keys create "--project=$Project" "--key-id=$Instance-app" `
    "--display-name=CT Data Explorer $Environment Gemini" `
    "--service-account=$Instance-gemini@$Project.iam.gserviceaccount.com" `
    --api-target=service=generativelanguage.googleapis.com "--allowed-ips=$Ip" `
    --quiet --verbosity=error *> $null
}
```

Wait for [startup.sh](startup.sh) to install Docker. Read each VM’s Ed25519 SSH fingerprint from its Compute Engine serial output. Windows releases pass it as `-HostKey`. On systems using OpenSSH, verify the host key and add it to `known_hosts` before deploying.

A [Gemini spend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) applies to the Gemini API across all keys in the project, including any local key created there.

## 3. Release and verify

The [release script](release.ps1) packages the current checkout, uploads it through IAP, builds the app, runs migrations, and checks HTTPS and database health.

```powershell
& (Join-Path $App 'deploy/release.ps1') -Environment staging -Project $Project -Zone $Zone `
  -HostKey 'SHA256:STAGING_FINGERPRINT' -AdminEmail you@example.org
```

Use `-AdminEmail` on the first release to create the admin and load the four starter datasets. Retrieve `/opt/ctde/admin-invite.txt` with `sudo` over a private IAP SSH session and open the one-time setup link. For subsequent releases, omit `-AdminEmail`. MySQL and Caddy volumes persist across releases. Back up MySQL before applying new migrations.

Pass `-GeminiKeyId` for a key with a custom or rotated ID. The default is `ctde-<environment>-app`.

```powershell
$env:CTDE_SMOKE_ORIGIN = 'https://STAGING_IP'
$env:CTDE_SMOKE_GUEST_ONLY = '1'
node (Join-Path $App 'scripts/smoke-deployment.js')
```

After staging passes, repeat the release with `-Environment production` and the production fingerprint, then run the smoke test against the production IP. For authenticated tests, clear `CTDE_SMOKE_GUEST_ONLY` and provide `CTDE_SMOKE_EMAIL` and `CTDE_SMOKE_PASSWORD` through your environment.
