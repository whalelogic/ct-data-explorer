# Google Cloud deployment

Staging and production run on separate Ubuntu Compute Engine `e2-micro` VMs in `us-central1-a`. Each VM has a 15 GB standard persistent disk, a static IPv4 address, MySQL and Caddy volumes, and a root-only `/opt/ctde/runtime.env`. The hosts accept web traffic on ports 80 and 443 and accept SSH only through IAP. MySQL and Node use private Docker networks. Caddy manages Let's Encrypt certificates for the static addresses.

## Provision a new project

Use a billing-enabled Google Cloud project. Allow the Compute Engine, IAP, API Keys, and Generative Language APIs. Create a custom VPC with a regional subnet and allow TCP 80/443 from the internet and TCP 22 from `35.235.240.0/20` on the VM tag. Reserve two Standard-tier regional IPv4 addresses and create `ctde-staging` and `ctde-production` using their respective addresses. Use Ubuntu 24.04 with [startup.sh](startup.sh) as the startup script, block project-wide SSH keys, and leave the instances without a service account.

For each environment, create a dedicated service account for Gemini with no other workload roles. Run the following in PowerShell after setting `$Project`, `$Environment`, and `$Ip` to the project, environment name, and corresponding static address.

```powershell
$instance = "ctde-$Environment"
$null = gcloud beta services api-keys create "--project=$Project" "--key-id=$instance-app" `
  "--display-name=CT Data Explorer $Environment Gemini" `
  "--service-account=$instance-gemini@$Project.iam.gserviceaccount.com" `
  --api-target=service=generativelanguage.googleapis.com "--allowed-ips=$Ip" `
  --quiet --verbosity=error 2>&1
if ($LASTEXITCODE) { throw 'Gemini API key creation failed.' }
```

## Release

Run [release.ps1](release.ps1) with the authenticated Google Cloud CLI, PowerShell, and `tar`. On Windows, supply the VM's SSH fingerprint from the Compute Engine serial output as `-HostKey`. On other platforms, verify the VM's public host key out of band and add it to OpenSSH's known hosts before deploying.

```powershell
./deploy/release.ps1 -Environment staging -Project YOUR_PROJECT -AdminEmail admin@example.org -HostKey 'SHA256:YOUR_STAGING_HOST_FINGERPRINT'
./deploy/release.ps1 -Environment production -Project YOUR_PROJECT -AdminEmail admin@example.org -HostKey 'SHA256:YOUR_PRODUCTION_HOST_FINGERPRINT'
```

The script builds the app, applies migrations, starts the services, and verifies public HTTPS and database health. `-AdminEmail` bootstraps the first administrator and loads the public ACS sample on a new environment. Retrieve `/opt/ctde/admin-invite.txt` with `sudo` in a private IAP SSH session to set the administrator's password. The initial link expires after seven days. Use `scripts/reset-password.js` in the app container to issue a new one.

Run `node scripts/smoke-deployment.js` with `CTDE_SMOKE_ORIGIN`, `CTDE_SMOKE_PASSWORD`, and `CTDE_SMOKE_EMAIL` set to verify authenticated reporting and grounded Gemini chat. Keep passwords and setup links out of command history.

The existing database and Caddy volumes persist across releases. Back up the database before migrations. Add any alternate provider credentials to the host's protected environment file and redeploy, then select the provider in AI settings.
