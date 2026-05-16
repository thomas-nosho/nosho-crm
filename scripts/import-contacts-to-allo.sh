#!/usr/bin/env bash
# One-shot push: every CRM contact with a phone number is created in Allo's
# CRM (POST /v2/api/crm/people) and the returned allo person id is recorded
# in public.allo_contact_links so the call.completed webhook can match the
# pivot directly instead of falling back to phone-number matching.
#
# Idempotent: Allo's `allow_duplicate_number=false` causes a 4xx duplicate
# error when the same number already exists; we recover by searching for
# the existing person and linking it locally. Re-running the script is safe.
#
# Required env (injected via Doppler nosho-crm/prd):
#   SUPABASE_ACCESS_TOKEN  — Management API bearer
#   SUPABASE_PROJECT_ID    — vrnjdsxdkqmdfdcydlas
#   ALLO_API_KEY           — ak_live_xxx with CRM_WRITE scope
#
# Usage:
#   doppler run --project nosho-crm --config prd -- ./scripts/import-contacts-to-allo.sh [--dry-run] [--limit N]

set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?'SUPABASE_ACCESS_TOKEN is required'}"
: "${SUPABASE_PROJECT_ID:?'SUPABASE_PROJECT_ID is required'}"
: "${ALLO_API_KEY:?'ALLO_API_KEY is required'}"

DRY_RUN=0
LIMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --limit)   LIMIT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

SB_API="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/database/query"
ALLO_API="https://api.withallo.com/v2/api/crm/people"
ALLO_AUTH="Authorization: Api-Key ${ALLO_API_KEY}"

LOG_DIR="$(dirname "$0")/../.context/allo-import-logs"
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
ERR_LOG="$LOG_DIR/errors-$TS.jsonl"
OK_LOG="$LOG_DIR/ok-$TS.jsonl"

# ---------- helpers ----------

run_sql() {
  curl -sf -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "$(jq -n --arg q "$1" '{query: $q}')" \
    "$SB_API"
}

# Normalize a French phone number to E.164.
# Accepts: "06 44 64 11 51", "0644641151", "+33644641151", "33 6 44 64 11 51", etc.
# Rejects (echoes "" + returns 1): less than 9 digits or unrecognized country code.
normalize_phone_fr() {
  local raw="$1"
  # Strip everything but digits and leading +
  local stripped
  stripped=$(echo "$raw" | tr -cd '0-9+')
  if [[ "$stripped" =~ ^\+ ]]; then
    # already E.164-ish, just keep it
    echo "$stripped"
    return 0
  fi
  # Drop leading 0 (FR national prefix), prepend +33
  if [[ "$stripped" =~ ^0[1-9][0-9]{8}$ ]]; then
    echo "+33${stripped:1}"
    return 0
  fi
  # 33 + 9 digits without leading +
  if [[ "$stripped" =~ ^33[1-9][0-9]{8}$ ]]; then
    echo "+${stripped}"
    return 0
  fi
  # 9 digits, assume FR mobile/fixed without leading 0
  if [[ "$stripped" =~ ^[1-9][0-9]{8}$ ]]; then
    echo "+33${stripped}"
    return 0
  fi
  echo ""
  return 1
}

# ---------- 1. Pull contacts to import ----------

echo "[1/3] Fetching contacts with phone..." >&2
SQL=$(cat <<'EOF'
select
  c.id,
  coalesce(nullif(trim(c.first_name), ''), '') as first_name,
  coalesce(nullif(trim(c.last_name), ''), '')  as last_name,
  coalesce(nullif(trim(c.title), ''), '')      as title,
  c.phone_jsonb,
  c.email_jsonb
from public.contacts c
where jsonb_array_length(coalesce(c.phone_jsonb, '[]'::jsonb)) > 0
  and not exists (
    select 1 from public.allo_contact_links acl where acl.contact_id = c.id
  )
order by c.id
EOF
)
if [[ -n "$LIMIT" ]]; then
  SQL="$SQL limit $LIMIT"
fi

CONTACTS=$(run_sql "$SQL")
TOTAL=$(echo "$CONTACTS" | jq 'length')
echo "  → $TOTAL contacts to process" >&2

if [[ "$TOTAL" -eq 0 ]]; then
  echo "Nothing to do." >&2
  exit 0
fi

# ---------- 2. Loop, throttled ----------

CREATED=0
LINKED_EXISTING=0
SKIPPED_NO_PHONE=0
ERRORS=0

# 4 req/s: sleep 0.25s between requests
THROTTLE_MS=250

# Iterate
while IFS= read -r row; do
  CONTACT_ID=$(echo "$row" | jq -r '.id')
  FIRST=$(echo "$row" | jq -r '.first_name')
  LAST=$(echo "$row" | jq -r '.last_name')
  TITLE=$(echo "$row" | jq -r '.title')
  PHONES_RAW=$(echo "$row" | jq -r '.phone_jsonb // [] | map(.number // "") | join("\n")')
  EMAILS_RAW=$(echo "$row" | jq -r '.email_jsonb // [] | map(.email // "") | join("\n")')

  # Normalize phones, dedupe, drop empties
  declare -a NUMBERS=()
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    norm=$(normalize_phone_fr "$p" || true)
    if [[ -n "$norm" ]] && ! printf '%s\n' "${NUMBERS[@]:-}" | grep -qx "$norm"; then
      NUMBERS+=("$norm")
    fi
  done <<< "$PHONES_RAW"

  if [[ ${#NUMBERS[@]} -eq 0 ]]; then
    SKIPPED_NO_PHONE=$((SKIPPED_NO_PHONE + 1))
    echo "{\"contact_id\":$CONTACT_ID,\"reason\":\"no_valid_phone\",\"raw\":$(echo "$row" | jq -c .phone_jsonb)}" >> "$ERR_LOG"
    continue
  fi

  # Build emails array (filter out empties)
  declare -a EMAILS=()
  while IFS= read -r e; do
    [[ -z "$e" ]] && continue
    EMAILS+=("$e")
  done <<< "$EMAILS_RAW"

  # Build POST body. Allo requires `name` OR `last_name`.
  # Use first_name as `name`, fall back to a placeholder if both empty (rare).
  if [[ -z "$FIRST" && -z "$LAST" ]]; then
    LAST="Contact CRM #$CONTACT_ID"
  fi

  BODY=$(jq -n \
    --arg name "$FIRST" \
    --arg last_name "$LAST" \
    --arg job_title "$TITLE" \
    --argjson numbers "$(printf '%s\n' "${NUMBERS[@]}" | jq -R . | jq -s .)" \
    --argjson emails "$(printf '%s\n' "${EMAILS[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')" \
    '{
      name: (if ($name | length) > 0 then $name else null end),
      last_name: (if ($last_name | length) > 0 then $last_name else null end),
      job_title: (if ($job_title | length) > 0 then $job_title else null end),
      numbers: $numbers,
      emails: (if ($emails | length) > 0 then $emails else null end),
      allow_duplicate_number: false
    } | with_entries(select(.value != null))')

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY] contact $CONTACT_ID → $(echo "$BODY" | jq -c .)" >&2
    continue
  fi

  # POST to Allo
  HTTP_CODE=$(curl -sS -o /tmp/allo-resp.json -w "%{http_code}" \
    -X POST "$ALLO_API" \
    -H "$ALLO_AUTH" \
    -H "Content-Type: application/json" \
    --data-binary "$BODY" || echo "000")

  if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    ALLO_ID=$(jq -r '.data.id' < /tmp/allo-resp.json)
    if [[ "$ALLO_ID" != "null" && -n "$ALLO_ID" ]]; then
      # Link in CRM
      run_sql "insert into public.allo_contact_links (contact_id, allo_contact_id) values ($CONTACT_ID, '$ALLO_ID') on conflict do nothing;" > /dev/null
      CREATED=$((CREATED + 1))
      echo "{\"contact_id\":$CONTACT_ID,\"allo_id\":\"$ALLO_ID\",\"action\":\"created\"}" >> "$OK_LOG"
      printf "."
    else
      ERRORS=$((ERRORS + 1))
      echo "{\"contact_id\":$CONTACT_ID,\"http\":$HTTP_CODE,\"reason\":\"missing_id_in_response\",\"resp\":$(cat /tmp/allo-resp.json | jq -c .)}" >> "$ERR_LOG"
    fi
  elif [[ "$HTTP_CODE" == "409" || "$HTTP_CODE" == "422" ]]; then
    # Likely duplicate. Try to recover: search by phone and link.
    FIRST_NUM="${NUMBERS[0]}"
    SEARCH_BODY=$(jq -n --arg q "$FIRST_NUM" '{query: $q, page: 1, per_page: 5}')
    SEARCH_HTTP=$(curl -sS -o /tmp/allo-search.json -w "%{http_code}" \
      -X POST "https://api.withallo.com/v2/api/crm/people/search" \
      -H "$ALLO_AUTH" \
      -H "Content-Type: application/json" \
      --data-binary "$SEARCH_BODY" || echo "000")
    if [[ "$SEARCH_HTTP" =~ ^2[0-9][0-9]$ ]]; then
      EXISTING_ID=$(jq -r '.data[0].id // empty' < /tmp/allo-search.json)
      if [[ -n "$EXISTING_ID" ]]; then
        run_sql "insert into public.allo_contact_links (contact_id, allo_contact_id) values ($CONTACT_ID, '$EXISTING_ID') on conflict do nothing;" > /dev/null
        LINKED_EXISTING=$((LINKED_EXISTING + 1))
        echo "{\"contact_id\":$CONTACT_ID,\"allo_id\":\"$EXISTING_ID\",\"action\":\"linked_existing\"}" >> "$OK_LOG"
        printf "~"
      else
        ERRORS=$((ERRORS + 1))
        echo "{\"contact_id\":$CONTACT_ID,\"http\":$HTTP_CODE,\"reason\":\"dedup_no_match\",\"resp\":$(cat /tmp/allo-resp.json | jq -c .)}" >> "$ERR_LOG"
      fi
    else
      ERRORS=$((ERRORS + 1))
      echo "{\"contact_id\":$CONTACT_ID,\"http\":$HTTP_CODE,\"search_http\":$SEARCH_HTTP,\"reason\":\"search_failed\"}" >> "$ERR_LOG"
    fi
  else
    ERRORS=$((ERRORS + 1))
    echo "{\"contact_id\":$CONTACT_ID,\"http\":$HTTP_CODE,\"reason\":\"unexpected_response\",\"resp\":$(cat /tmp/allo-resp.json | jq -Rsc .)}" >> "$ERR_LOG"
    printf "x"
  fi

  # Throttle
  sleep "$(awk "BEGIN {print $THROTTLE_MS / 1000}")"
done < <(echo "$CONTACTS" | jq -c '.[]')

echo "" >&2

# ---------- 3. Report ----------

echo "[3/3] Report:" >&2
echo "  Created (new in Allo)         : $CREATED" >&2
echo "  Linked (already existed Allo) : $LINKED_EXISTING" >&2
echo "  Skipped (no valid phone)      : $SKIPPED_NO_PHONE" >&2
echo "  Errors                        : $ERRORS" >&2
echo "  OK log                        : $OK_LOG" >&2
echo "  Error log                     : $ERR_LOG" >&2
echo "" >&2
echo "  Total processed: $((CREATED + LINKED_EXISTING + SKIPPED_NO_PHONE + ERRORS)) / $TOTAL" >&2
