#!/usr/bin/env bash
# Export all CRM contacts with at least one phone number to a CSV file
# at the Google Contacts import format.
#
# Why: Allo's API is gated behind paid plans, but Allo has a native two-way
# Google Contacts sync. So we route through Google: CSV → Google Contacts
# → Allo CRM (via the integration toggle in Allo's mobile app).
#
# Output is written to .context/allo-import-logs/google-contacts-export-<ts>.csv
# Each row has up to 3 phones (Mobile/Work/Home) and 2 emails (Work/Home).
# Every row carries the "Nosho CRM" Google Contacts label so the user can
# filter/remove the imported contacts later.
#
# Required env (Doppler nosho-crm/prd):
#   SUPABASE_ACCESS_TOKEN
#   SUPABASE_PROJECT_ID
#
# Usage:
#   doppler run --project nosho-crm --config prd -- ./scripts/export-contacts-to-google-csv.sh [--limit N]

set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?'SUPABASE_ACCESS_TOKEN is required'}"
: "${SUPABASE_PROJECT_ID:?'SUPABASE_PROJECT_ID is required'}"

LIMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

SB_API="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/database/query"
OUT_DIR="$(dirname "$0")/../.context/allo-import-logs"
mkdir -p "$OUT_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_DIR/google-contacts-export-$TS.csv"

run_sql() {
  curl -sf -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "$(jq -n --arg q "$1" '{query: $q}')" \
    "$SB_API"
}

echo "[1/2] Fetching contacts..." >&2
SQL=$(cat <<'EOF'
select
  c.id,
  coalesce(nullif(trim(c.first_name), ''), '') as first_name,
  coalesce(nullif(trim(c.last_name), ''), '')  as last_name,
  coalesce(nullif(trim(c.title), ''), '')      as title,
  coalesce(nullif(trim(co.name), ''), '')      as company_name,
  c.phone_jsonb,
  c.email_jsonb
from public.contacts c
left join public.companies co on co.id = c.company_id
where jsonb_array_length(coalesce(c.phone_jsonb, '[]'::jsonb)) > 0
order by c.id
EOF
)
if [[ -n "$LIMIT" ]]; then
  SQL="$SQL limit $LIMIT"
fi

CONTACTS=$(run_sql "$SQL")
TOTAL=$(echo "$CONTACTS" | jq 'length')
echo "  → $TOTAL contacts" >&2

# Google Contacts CSV format. Field order matches Google's own export so the
# import wizard auto-maps everything.
HEADER='Name,Given Name,Family Name,Organization 1 - Name,Organization 1 - Title,E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Type,E-mail 2 - Value,Phone 1 - Type,Phone 1 - Value,Phone 2 - Type,Phone 2 - Value,Phone 3 - Type,Phone 3 - Value,Notes,Labels'

echo "[2/2] Writing CSV → $OUT" >&2
echo "$HEADER" > "$OUT"

# Use jq to emit CSV. jq's @csv handles RFC 4180 quoting/escaping correctly.
# Phones: take up to 3 from phone_jsonb (Mobile→Work→Home priority).
# Emails: take up to 2.
echo "$CONTACTS" | jq -r '
  # Normalize a French phone number to E.164.
  # Strip non-digits (preserve leading +). 0XXXXXXXXX → +33XXXXXXXXX. 33... → +33...
  def to_e164:
    if . == null or . == "" then ""
    else
      ([scan("[0-9+]") ] | join("")) as $s
      | if ($s | startswith("+")) then $s
        elif ($s | test("^0[1-9][0-9]{8}$")) then "+33" + ($s[1:])
        elif ($s | test("^33[1-9][0-9]{8}$")) then "+" + $s
        elif ($s | test("^[1-9][0-9]{8}$")) then "+33" + $s
        else $s   # leave as-is if format unknown — Google still imports it
        end
    end;
  def phone_at(idx):
    (.phone_jsonb // []) as $p
    | if ($p | length) > idx
        then [($p[idx].type // "Mobile"), (($p[idx].number // "") | to_e164)]
        else ["",""]
      end;
  def email_at(idx):
    (.email_jsonb // []) as $e
    | if ($e | length) > idx
        then [($e[idx].type // "Work"), ($e[idx].email // "")]
        else ["",""]
      end;
  .[]
  | (.first_name | tostring) as $fn
  | (.last_name  | tostring) as $ln
  | (if ($fn|length)>0 and ($ln|length)>0 then "\($fn) \($ln)"
       elif ($fn|length)>0 then $fn
       elif ($ln|length)>0 then $ln
       else "Contact CRM #\(.id)" end) as $display
  | (phone_at(0)) as $p1 | (phone_at(1)) as $p2 | (phone_at(2)) as $p3
  | (email_at(0)) as $e1 | (email_at(1)) as $e2
  | [
      $display,
      $fn,
      $ln,
      .company_name,
      .title,
      $e1[0], $e1[1],
      $e2[0], $e2[1],
      $p1[0], $p1[1],
      $p2[0], $p2[1],
      $p3[0], $p3[1],
      "Imported from Nosho CRM (id=\(.id))",
      "* myContacts ::: Nosho CRM"
    ]
  | @csv
' >> "$OUT"

ROWS=$(($(wc -l < "$OUT") - 1))
echo "" >&2
echo "✓ Exported $ROWS contacts → $OUT" >&2
echo "" >&2
echo "Next steps:" >&2
echo "  1. Open https://contacts.google.com/ (signed in as thomas@nosho.io)" >&2
echo "  2. Left sidebar → Import" >&2
echo "  3. Upload $OUT" >&2
echo "  4. After import, all 236 land under label 'Nosho CRM'" >&2
echo "  5. In Allo mobile app: Settings → Contacts → toggle Google Contacts ON" >&2
echo "  6. Allo will sync within 1–5 minutes" >&2
