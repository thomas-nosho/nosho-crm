import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";

const ALLO_BASE = "https://api.withallo.com";

interface AlloContact {
  id: string;
  name: string | null;
  last_name: string | null;
  job_title: string | null;
  website: string | null;
  emails?: string[] | null;
  numbers?: string[] | null;
  is_archived?: boolean;
  updated_at?: string;
}

interface CrmContactRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email_jsonb: Array<{ email: string; type?: string }> | null;
  phone_jsonb: Array<{ number: string; type?: string }> | null;
  sales_id: number | null;
}

function alloFetch(apiKey: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", apiKey);
  headers.set("Content-Type", "application/json");
  return fetch(`${ALLO_BASE}${path}`, { ...init, headers });
}

/** Loose E.164 normalization: strip spaces, dashes, parens. */
function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()./]/g, "").trim();
}

function extractCrmNumbers(c: CrmContactRow): string[] {
  return (c.phone_jsonb ?? [])
    .map((p) => normalizePhone(p?.number ?? ""))
    .filter((n) => n.length >= 4);
}

function extractCrmEmails(c: CrmContactRow): string[] {
  return (c.email_jsonb ?? [])
    .map((e) => (e?.email ?? "").trim().toLowerCase())
    .filter((e) => e.length > 0);
}

async function testConnection(apiKey: string) {
  const res = await alloFetch(apiKey, "/v2/api/me");
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: body?.error?.message ?? body?.message ?? `HTTP ${res.status}`,
    };
  }
  const data = body?.data ?? {};
  return {
    ok: true,
    api_key_id: data.api_key_id ?? null,
    scopes: data.scopes ?? [],
    team: data.team ?? null,
    rate_limits: data.rate_limits ?? null,
  };
}

/** List all Allo contacts via pagination. Page is 0-indexed, max size 100. */
async function fetchAllAlloContacts(apiKey: string): Promise<AlloContact[]> {
  const all: AlloContact[] = [];
  let page = 0;
  // Safety cap to avoid runaway loops.
  for (let i = 0; i < 200; i++) {
    const res = await alloFetch(
      apiKey,
      `/v1/api/contacts?page=${page}&size=100`,
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Allo list failed (${res.status}): ${body}`);
    }
    const json = await res.json();
    const results: AlloContact[] = json?.data?.results ?? [];
    all.push(...results);
    const totalPages: number =
      json?.data?.metadata?.pagination?.total_pages ?? 0;
    page += 1;
    if (results.length === 0) break;
    if (page >= totalPages) break;
  }
  return all;
}

function buildCreatePayload(c: CrmContactRow) {
  const numbers = extractCrmNumbers(c);
  if (numbers.length === 0) return null;
  const emails = extractCrmEmails(c);
  return {
    name: c.first_name || null,
    last_name: c.last_name || null,
    job_title: c.title || null,
    numbers,
    emails: emails.length > 0 ? emails : undefined,
  };
}

function buildUpdatePayload(c: CrmContactRow) {
  const numbers = extractCrmNumbers(c);
  const emails = extractCrmEmails(c);
  return {
    name: c.first_name || null,
    last_name: c.last_name || null,
    job_title: c.title || null,
    numbers: numbers.length > 0 ? numbers : null,
    emails: emails.length > 0 ? emails : null,
  };
}

interface SyncCounters {
  pushed_created: number;
  pushed_updated: number;
  pushed_skipped: number;
  pulled_created: number;
  pulled_updated: number;
  pulled_skipped: number;
  errors: string[];
}

async function syncContacts(
  userId: string,
  salesId: number,
  apiKey: string,
): Promise<SyncCounters> {
  const counters: SyncCounters = {
    pushed_created: 0,
    pushed_updated: 0,
    pushed_skipped: 0,
    pulled_created: 0,
    pulled_updated: 0,
    pulled_skipped: 0,
    errors: [],
  };

  // ── Load CRM contacts + existing mappings ─────────────────────────
  const { data: crmContacts, error: crmErr } = await supabaseAdmin
    .from("contacts")
    .select(
      "id, first_name, last_name, title, email_jsonb, phone_jsonb, sales_id",
    )
    .returns<CrmContactRow[]>();
  if (crmErr) throw new Error(`Load CRM contacts failed: ${crmErr.message}`);

  const { data: mappingRows } = await supabaseAdmin
    .from("allo_contact_mappings")
    .select("contact_id, allo_contact_id")
    .eq("user_id", userId);

  const crmToAllo = new Map<number, string>();
  const alloToCrm = new Map<string, number>();
  for (const row of mappingRows ?? []) {
    crmToAllo.set(row.contact_id as number, row.allo_contact_id as string);
    alloToCrm.set(row.allo_contact_id as string, row.contact_id as number);
  }

  // ── Pull all Allo contacts (used both for pull and for phone matching) ──
  const alloContacts = await fetchAllAlloContacts(apiKey);

  // Index Allo contacts by normalized phone number for matching.
  const alloByPhone = new Map<string, AlloContact>();
  for (const a of alloContacts) {
    for (const n of a.numbers ?? []) {
      alloByPhone.set(normalizePhone(n), a);
    }
  }

  // ── Push CRM → Allo ───────────────────────────────────────────────
  for (const c of crmContacts ?? []) {
    const numbers = extractCrmNumbers(c);
    if (numbers.length === 0) {
      counters.pushed_skipped += 1;
      continue;
    }

    const existingAlloId = crmToAllo.get(c.id);
    if (existingAlloId) {
      // Update existing Allo contact.
      const payload = buildUpdatePayload(c);
      const res = await alloFetch(
        apiKey,
        `/v1/api/contacts/${existingAlloId}`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      if (res.ok) {
        counters.pushed_updated += 1;
        await supabaseAdmin
          .from("allo_contact_mappings")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("contact_id", c.id);
      } else {
        const body = await res.text().catch(() => "");
        counters.errors.push(
          `update ${c.id}: ${res.status} ${body.slice(0, 120)}`,
        );
        counters.pushed_skipped += 1;
      }
      continue;
    }

    // No mapping — try to match by phone first.
    const matched = numbers.map((n) => alloByPhone.get(n)).find(Boolean);
    if (matched) {
      await supabaseAdmin.from("allo_contact_mappings").upsert(
        {
          user_id: userId,
          contact_id: c.id,
          allo_contact_id: matched.id,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "user_id,contact_id" },
      );
      crmToAllo.set(c.id, matched.id);
      alloToCrm.set(matched.id, c.id);
      counters.pushed_skipped += 1;
      continue;
    }

    // Create in Allo.
    const payload = buildCreatePayload(c);
    if (!payload) {
      counters.pushed_skipped += 1;
      continue;
    }
    const res = await alloFetch(apiKey, "/v1/api/contacts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const body = await res.json();
      const created = body?.data;
      if (created?.id) {
        await supabaseAdmin.from("allo_contact_mappings").upsert(
          {
            user_id: userId,
            contact_id: c.id,
            allo_contact_id: created.id,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "user_id,contact_id" },
        );
        crmToAllo.set(c.id, created.id);
        alloToCrm.set(created.id, c.id);
        counters.pushed_created += 1;
      } else {
        counters.pushed_skipped += 1;
      }
    } else {
      const body = await res.text().catch(() => "");
      counters.errors.push(
        `create ${c.id}: ${res.status} ${body.slice(0, 120)}`,
      );
      counters.pushed_skipped += 1;
    }
  }

  // ── Pull Allo → CRM ───────────────────────────────────────────────
  // Index CRM contacts by phone number for matching.
  const crmByPhone = new Map<string, CrmContactRow>();
  for (const c of crmContacts ?? []) {
    for (const n of extractCrmNumbers(c)) crmByPhone.set(n, c);
  }

  for (const a of alloContacts) {
    if (a.is_archived) {
      counters.pulled_skipped += 1;
      continue;
    }
    const alloNumbers = (a.numbers ?? []).map(normalizePhone).filter(Boolean);
    if (alloNumbers.length === 0) {
      counters.pulled_skipped += 1;
      continue;
    }

    const mappedCrmId = alloToCrm.get(a.id);
    let crmRow: CrmContactRow | undefined;
    if (mappedCrmId !== undefined) {
      crmRow = (crmContacts ?? []).find((c) => c.id === mappedCrmId);
    } else {
      crmRow = alloNumbers.map((n) => crmByPhone.get(n)).find(Boolean);
    }

    if (crmRow) {
      // Merge phones/emails (union) and fill blank name/title fields.
      const existingPhones = crmRow.phone_jsonb ?? [];
      const existingPhoneSet = new Set(
        existingPhones.map((p) => normalizePhone(p.number)),
      );
      const newPhones = [
        ...existingPhones,
        ...alloNumbers
          .filter((n) => !existingPhoneSet.has(n))
          .map((n) => ({ number: n, type: "Work" as const })),
      ];

      const existingEmails = crmRow.email_jsonb ?? [];
      const existingEmailSet = new Set(
        existingEmails.map((e) => e.email.toLowerCase()),
      );
      const newEmails = [
        ...existingEmails,
        ...(a.emails ?? [])
          .map((e) => e.trim())
          .filter((e) => e && !existingEmailSet.has(e.toLowerCase()))
          .map((e) => ({ email: e, type: "Work" as const })),
      ];

      const patch: Record<string, unknown> = {};
      if (newPhones.length !== existingPhones.length)
        patch.phone_jsonb = newPhones;
      if (newEmails.length !== existingEmails.length)
        patch.email_jsonb = newEmails;
      if (!crmRow.first_name && a.name) patch.first_name = a.name;
      if (!crmRow.last_name && a.last_name) patch.last_name = a.last_name;
      if (!crmRow.title && a.job_title) patch.title = a.job_title;

      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin
          .from("contacts")
          .update(patch)
          .eq("id", crmRow.id);
        if (error) {
          counters.errors.push(`pull update ${crmRow.id}: ${error.message}`);
          counters.pulled_skipped += 1;
        } else {
          counters.pulled_updated += 1;
        }
      } else {
        counters.pulled_skipped += 1;
      }

      if (mappedCrmId === undefined) {
        await supabaseAdmin.from("allo_contact_mappings").upsert(
          {
            user_id: userId,
            contact_id: crmRow.id,
            allo_contact_id: a.id,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "user_id,contact_id" },
        );
      }
      continue;
    }

    // No CRM match — create new contact.
    const phoneJsonb = alloNumbers.map((n) => ({
      number: n,
      type: "Work" as const,
    }));
    const emailJsonb = (a.emails ?? [])
      .map((e) => e.trim())
      .filter((e) => e.length > 0)
      .map((e) => ({ email: e, type: "Work" as const }));

    const nowIso = new Date().toISOString();
    const { data: inserted, error } = await supabaseAdmin
      .from("contacts")
      .insert({
        first_name: a.name ?? "",
        last_name: a.last_name ?? "",
        title: a.job_title ?? "",
        email_jsonb: emailJsonb,
        phone_jsonb: phoneJsonb,
        sales_id: salesId,
        first_seen: nowIso,
        last_seen: nowIso,
        status: "cold",
        has_newsletter: false,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      counters.errors.push(
        `pull create ${a.id}: ${error?.message ?? "unknown"}`,
      );
      counters.pulled_skipped += 1;
      continue;
    }

    await supabaseAdmin.from("allo_contact_mappings").upsert(
      {
        user_id: userId,
        contact_id: inserted.id,
        allo_contact_id: a.id,
        last_synced_at: nowIso,
      },
      { onConflict: "user_id,contact_id" },
    );
    counters.pulled_created += 1;
  }

  // Cap error list size to avoid huge payloads.
  if (counters.errors.length > 20) {
    counters.errors = [
      ...counters.errors.slice(0, 20),
      `…${counters.errors.length - 20} more`,
    ];
  }

  return counters;
}

async function getSyncStatus(userId: string) {
  const { count } = await supabaseAdmin
    .from("allo_contact_mappings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const { data: latest } = await supabaseAdmin
    .from("allo_contact_mappings")
    .select("last_synced_at")
    .eq("user_id", userId)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    mapped_count: count ?? 0,
    last_synced_at: latest?.last_synced_at ?? null,
  };
}

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        if (req.method !== "POST") {
          return createErrorResponse(405, "Method Not Allowed");
        }

        const currentUserSale = await getUserSale(user!);
        if (!currentUserSale) {
          return createErrorResponse(401, "Unauthorized");
        }

        try {
          const { action, apiKey } = (await req.json()) as {
            action: string;
            apiKey?: string;
          };

          if (!apiKey && action !== "status") {
            return createErrorResponse(400, "Missing apiKey");
          }

          let result: unknown;

          switch (action) {
            case "test":
              result = await testConnection(apiKey!);
              break;
            case "sync":
              result = await syncContacts(
                user!.id,
                currentUserSale.id,
                apiKey!,
              );
              break;
            case "status":
              result = await getSyncStatus(user!.id);
              break;
            default:
              return createErrorResponse(400, `Unknown action: ${action}`);
          }

          return new Response(JSON.stringify({ data: result }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (e) {
          console.error("allo-sync error:", e);
          const message = e instanceof Error ? e.message : "Internal error";
          return createErrorResponse(500, message);
        }
      }),
    ),
  ),
);
