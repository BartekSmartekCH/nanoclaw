#!/bin/bash
# =============================================================================
# ARCHIVED — 2026-03-21
# =============================================================================
# This script was part of a staging proposal to standardise Keychain secrets
# under a "tatanano.{service}.{type}" naming convention. The convention was
# never adopted. Production code (credential-refresh.ts) reads the OAuth
# token from the "Claude Code-credentials" Keychain entry instead.
#
# The expected secrets listed below (tatanano.anthropic.oauth-token, etc.)
# do NOT exist in production Keychain and are NOT used by any running code.
#
# Kept here for historical context alongside KEYCHAIN-CONVENTION.html.
# Do NOT wire this into launchd, cron, or any startup flow.
# =============================================================================
#
# Original description:
# TataNano Keychain Convention Validator — checks that all required secrets
# exist in macOS Keychain (Passwords app) with the correct naming convention.
# MUST run on the Mac Mini HOST (not inside Docker).
# Safe to run multiple times. Never prints full secret values.
# =============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------

ACCOUNT="tatanano"

# Expected secrets: "service_name|human_label"
EXPECTED_SECRETS=(
  "tatanano.anthropic.oauth-token|Claude / Anthropic OAuth Token"
  "tatanano.telegram.bot-token|Telegram Bot Token"
  "tatanano.telegram.bot-pool|Telegram Bot Pool"
)

# --- Helpers -----------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass_count=0
fail_count=0
warn_count=0

header() {
  echo ""
  echo -e "${BOLD}=============================================${RESET}"
  echo -e "${BOLD}  TataNano Keychain Convention Validator${RESET}"
  echo -e "${BOLD}=============================================${RESET}"
  echo ""
}

mask_value() {
  # Show only last 4 characters, mask the rest
  local val="$1"
  local len=${#val}
  if [ "$len" -le 4 ]; then
    echo "****"
  else
    local masked_len=$((len - 4))
    local last4="${val: -4}"
    printf '%*s' "$masked_len" '' | tr ' ' '*'
    echo "$last4"
  fi
}

# --- Pre-flight checks -------------------------------------------------------

preflight() {
  # Verify we're on macOS
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo -e "${RED}ERROR: This script must run on macOS (the host), not inside Docker.${RESET}"
    echo ""
    echo "How to run this on the Mac Mini host:"
    echo "  1. Open Terminal.app on the Mac Mini (Spotlight: Cmd+Space -> Terminal)"
    echo "  2. Run: bash ~/tatanano/validate-keychain.sh"
    exit 1
  fi

  # Verify the 'security' command exists
  if ! command -v security &>/dev/null; then
    echo -e "${RED}ERROR: 'security' command not found. This should be available on macOS.${RESET}"
    exit 1
  fi
}

# --- Core validation ----------------------------------------------------------

check_secret() {
  local service_name="$1"
  local label="$2"

  echo -e "${CYAN}Checking:${RESET} ${BOLD}${label}${RESET}"
  echo -e "  Service: ${service_name}"
  echo -e "  Account: ${ACCOUNT}"

  # Validate naming convention: must match tatanano.{service}.{type}
  if [[ ! "$service_name" =~ ^tatanano\.[a-z]+\.[a-z-]+$ ]]; then
    echo -e "  ${YELLOW}WARNING: Service name does not match convention tatanano.{service}.{type}${RESET}"
    warn_count=$((warn_count + 1))
  fi

  # Try to find the entry in Keychain using 'security find-generic-password'
  local raw_output
  local security_exit=0
  raw_output=$(security find-generic-password \
    -s "$service_name" \
    -a "$ACCOUNT" \
    -w \
    2>/dev/null) || security_exit=$?

  if [ "$security_exit" -eq 0 ]; then
    # Secret found -- check if empty first
    if [ -z "$raw_output" ]; then
      echo -e "  ${YELLOW}WARNING: Entry exists but password is EMPTY${RESET}"
      warn_count=$((warn_count + 1))
      echo ""
      return
    fi

    local masked
    masked=$(mask_value "$raw_output")
    echo -e "  ${GREEN}FOUND${RESET}  Value: ${masked}"
    pass_count=$((pass_count + 1))
  else
    # Could be missing OR Keychain is locked
    echo -e "  ${RED}MISSING${RESET}"
    echo -e "  ${YELLOW}(If Keychain is locked, unlock it first: security unlock-keychain ~/Library/Keychains/login.keychain-db)${RESET}"
    fail_count=$((fail_count + 1))

    # Provide the exact fix command
    echo ""
    echo -e "  ${BOLD}To fix, run this command on the Mac Mini host:${RESET}"
    echo ""
    echo "    security add-generic-password \\"
    echo "      -s \"${service_name}\" \\"
    echo "      -a \"${ACCOUNT}\" \\"
    echo "      -w \"YOUR_SECRET_VALUE_HERE\" \\"
    echo "      -U"
    echo ""
    echo "  Or add it via the Passwords app:"
    echo "    Website:  ${service_name}"
    echo "    Username: ${ACCOUNT}"
    echo "    Password: <your secret>"
  fi

  echo ""
}

# --- Summary ------------------------------------------------------------------

summary() {
  echo -e "${BOLD}---------------------------------------------${RESET}"
  echo -e "${BOLD}  Summary${RESET}"
  echo -e "${BOLD}---------------------------------------------${RESET}"
  echo -e "  ${GREEN}Found:${RESET}   ${pass_count}"
  echo -e "  ${RED}Missing:${RESET} ${fail_count}"
  echo -e "  ${YELLOW}Warnings:${RESET} ${warn_count}"
  echo ""

  if [ "$fail_count" -eq 0 ] && [ "$warn_count" -eq 0 ]; then
    echo -e "  ${GREEN}All secrets are correctly configured!${RESET}"
  elif [ "$fail_count" -gt 0 ]; then
    echo -e "  ${RED}Some secrets are missing. See fix commands above.${RESET}"
  else
    echo -e "  ${YELLOW}Secrets found but with warnings. Review above.${RESET}"
  fi
  echo ""

  # Return non-zero if any secrets are missing
  [ "$fail_count" -eq 0 ]
}

# --- Main ---------------------------------------------------------------------

main() {
  header
  preflight

  for entry in "${EXPECTED_SECRETS[@]}"; do
    IFS='|' read -r service_name label <<< "$entry"
    check_secret "$service_name" "$label"
  done

  summary
}

main "$@"
