# /check-secrets

Validate that all required TataNano secrets are correctly stored in the macOS Keychain (Passwords app) on the Mac Mini host.

## Trigger

```
@TataNano /check-secrets
```

## What it does

Runs `validate-keychain.sh` on the Mac Mini **host** (not inside Docker) and reports:

- Which secrets are found, missing, or misconfigured
- A masked preview of each value (last 4 characters only)
- Exact fix commands for any missing entries

## Expected secrets

| # | Service Name                      | Account    |
|---|-----------------------------------|------------|
| 1 | `tatanano.anthropic.oauth-token`  | `tatanano` |
| 2 | `tatanano.telegram.bot-token`     | `tatanano` |
| 3 | `tatanano.telegram.bot-pool`      | `tatanano` |

## How to run

### Host script location

The script lives at `~/tatanano/validate-keychain.sh` on the Mac Mini host. To deploy it:

```bash
# On the Mac Mini host (Terminal.app)
mkdir -p ~/tatanano
cp validate-keychain.sh ~/tatanano/validate-keychain.sh
chmod +x ~/tatanano/validate-keychain.sh
```

### Option A: TataNano runs it automatically

TataNano runs inside Docker and **cannot access macOS Keychain directly**. To bridge this gap, TataNano uses a host-command mechanism:

1. The Docker container has a bind-mounted volume (e.g., `/host-shared`) shared with the Mac Mini host.
2. TataNano writes a request file to the shared volume.
3. A launchd agent on the host watches for request files, executes the script, and writes the output back.
4. TataNano reads the output and sends results to Telegram.

Alternatively, if the Mac Mini has SSH enabled (System Settings > General > Sharing > Remote Login):

```bash
# From inside the Docker container:
ssh host.docker.internal 'bash ~/tatanano/validate-keychain.sh'
```

This requires SSH key setup between the container and the host.

### Option B: Manual run via Terminal on the Mac Mini

If Bartek has terminal access on the host:

```bash
bash ~/tatanano/validate-keychain.sh
```

> **Note:** Docker Desktop's built-in terminal runs inside the Docker VM, not on the macOS host. It will NOT work for Keychain access. Use Terminal.app instead.

## Response format

TataNano should reply with a message like:

```
Keychain Secrets Check

  Claude / Anthropic OAuth Token
  Service: tatanano.anthropic.oauth-token
  FOUND  Value: ****...Ab1X

  Telegram Bot Token
  Service: tatanano.telegram.bot-token
  FOUND  Value: ****...xXxX

  Telegram Bot Pool
  Service: tatanano.telegram.bot-pool
  MISSING

  To fix, run on the Mac Mini host:
    security add-generic-password \
      -s "tatanano.telegram.bot-pool" \
      -a "tatanano" \
      -w "YOUR_SECRET_VALUE_HERE" \
      -U

Summary: 2 found, 1 missing, 0 warnings
```

## Security notes

- NEVER display full secret values -- only the last 4 characters
- The script is read-only; it does not modify the Keychain
- Safe to run multiple times (idempotent)
- The `-U` flag in fix commands means "update if exists" so re-running is safe
- The script exits with code 1 if any secrets are missing, 0 if all pass
