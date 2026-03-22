---
# SPIKE: Auth-recovery — is it wired up or broken?

## Status
Not started. Pass to dev team via /dev in the development group.

## Question
NanoClaw has credential-proxy.ts and credential-refresh.ts with Keychain reading and per-request token loading. But auth crashes still happen. Why?

## Investigate

1. Is checkAuthHealth() actually called at the right moment?
   Trace the full call path from 401 → recovery in index.ts.

2. Is credential-refresh.ts properly wired into the proxy,
   or is it dead code that nobody calls?

3. Did earlier automation attempts to pull secrets from the
   macOS Passwords app break the Keychain path? Look for any
   code that reads from Passwords/Keychain and may have
   overwritten or corrupted the token in .env or Keychain.

4. What does scopes/auth-recovery.md say vs what the code
   actually does — are the two listed showstoppers still real,
   or already fixed?

5. How does OpenClaw handle auth without crashing — what is different?

## Output expected
A short ADR:
- What is broken (with file + line references)
- What is already working correctly
- The minimal fix needed
- Confidence: will this fix the auth crashes?
---
