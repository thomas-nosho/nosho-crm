import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";
import {
  getValidGoogleAccessToken,
  googleFetch,
} from "../_shared/googleAuth.ts";

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

interface GooglePerson {
  resourceName: string;
  etag: string;
  names?: Array<{
    displayName: string;
    givenName?: string;
    familyName?: string;
  }>;
  emailAddresses?: Array<{ value: string; type?: string }>;
  phoneNumbers?: Array<{ value: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  photos?: Array<{ url: string }>;
}

async function syncContacts(userId: string, salesId: number) {
  // Fetch Google Contacts
  const params = new URLSearchParams({
    personFields: "names,emailAddresses,phoneNumbers,organizations,photos",
    pageSize: "100",
    sortOrder: "LAST_MODIFIED_DESCENDING",
  });

  let allContacts: GooglePerson[] = [];
  let nextPageToken: string | undefined;

  // Paginate through all contacts (max 500 for now)
  for (let page = 0; page < 5; page++) {
    const url = `${PEOPLE_API_BASE}/people/me/connections?${params}${
      nextPageToken ? `&pageToken=${nextPageToken}` : ""
    }`;

    const response = await googleFetch(userId, url);
    if (!response.ok) {
      const errorBody = await response.text();
      console.error("People API error:", response.status, errorBody);
      throw new Error(`People API error: ${response.status}`);
    }

    const data = await response.json();
    const connections: GooglePerson[] = data.connections ?? [];
    allContacts = [...allContacts, ...connections];

    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  // Filter contacts that have at least one email
  const contactsWithEmail = allContacts.filter((c) => c.emailAddresses?.length);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const googleContact of contactsWithEmail) {
    const emails =
      googleContact.emailAddresses?.map((e) => e.value.toLowerCase()) ?? [];
    const name = googleContact.names?.[0];
    const org = googleContact.organizations?.[0];

    // Try to find existing CRM contact by email
    const { data: existingContacts } = await supabaseAdmin
      .from("contacts")
      .select("id, email_jsonb")
      .or(
        emails
          .map((email) => `email_jsonb.cs.[{"email":"${email}"}]`)
          .join(","),
      )
      .limit(1);

    if (existingContacts && existingContacts.length > 0) {
      // Contact already exists in CRM, skip (don't overwrite CRM data)
      skipped++;
      continue;
    }

    // Create new contact in CRM
    const emailJsonb =
      googleContact.emailAddresses?.map((e) => ({
        email: e.value,
        type: e.type === "home" ? "Home" : "Work",
      })) ?? [];

    const phoneJsonb =
      googleContact.phoneNumbers?.map((p) => ({
        number: p.value,
        type: p.type === "home" ? "Home" : "Work",
      })) ?? [];

    const { error } = await supabaseAdmin.from("contacts").insert({
      first_name: name?.givenName ?? name?.displayName ?? "Inconnu",
      last_name: name?.familyName ?? "",
      title: org?.title ?? "",
      email_jsonb: emailJsonb,
      phone_jsonb: phoneJsonb,
      sales_id: salesId,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      status: "cold",
      has_newsletter: false,
    });

    if (error) {
      console.error("Error creating contact:", error);
      skipped++;
    } else {
      created++;
    }
  }

  return {
    total: contactsWithEmail.length,
    created,
    updated,
    skipped,
  };
}

async function exportToGoogle(userId: string, salesId: number) {
  // Verify the user has the contacts write scope
  const { data: tokenRow } = await supabaseAdmin
    .from("google_oauth_tokens")
    .select("scopes")
    .eq("user_id", userId)
    .single();

  const hasWriteScope = tokenRow?.scopes?.includes(
    "https://www.googleapis.com/auth/contacts",
  );
  if (!hasWriteScope) {
    throw new Error("GOOGLE_CONTACTS_WRITE_REQUIRED");
  }

  // Fetch all existing Google contact emails to avoid duplicates
  const existingEmails = new Set<string>();
  let nextPageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      personFields: "emailAddresses",
      pageSize: "1000",
    });
    if (nextPageToken) params.set("pageToken", nextPageToken);
    const res = await googleFetch(
      userId,
      `${PEOPLE_API_BASE}/people/me/connections?${params}`,
    );
    if (!res.ok) break;
    const data = await res.json();
    for (const person of data.connections ?? []) {
      for (const e of person.emailAddresses ?? []) {
        existingEmails.add(e.value.toLowerCase());
      }
    }
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  // Fetch all CRM contacts for this sales user that have at least one email
  const { data: crmContacts } = await supabaseAdmin
    .from("contacts")
    .select("first_name, last_name, title, email_jsonb, phone_jsonb")
    .eq("sales_id", salesId)
    .not("email_jsonb", "is", null);

  let created = 0;
  let skipped = 0;

  const accessToken = await getValidGoogleAccessToken(userId);

  for (const contact of crmContacts ?? []) {
    const emails: Array<{ email: string; type?: string }> =
      contact.email_jsonb ?? [];
    if (emails.length === 0) {
      skipped++;
      continue;
    }

    // Skip if any of the contact's emails already exist in Google
    const alreadyInGoogle = emails.some((e) =>
      existingEmails.has(e.email.toLowerCase()),
    );
    if (alreadyInGoogle) {
      skipped++;
      continue;
    }

    const body: Record<string, unknown> = {
      names: [
        {
          givenName: contact.first_name ?? "",
          familyName: contact.last_name ?? "",
        },
      ],
      emailAddresses: emails.map((e) => ({
        value: e.email,
        type: e.type?.toLowerCase() === "home" ? "home" : "work",
      })),
    };

    const phones: Array<{ number: string; type?: string }> =
      contact.phone_jsonb ?? [];
    if (phones.length > 0) {
      body.phoneNumbers = phones.map((p) => ({
        value: p.number,
        type: p.type?.toLowerCase() === "home" ? "home" : "work",
      }));
    }

    if (contact.title) {
      body.organizations = [{ title: contact.title }];
    }

    const res = await fetch(
      `${PEOPLE_API_BASE}/people:createContact?personFields=names`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (res.ok) {
      created++;
      // Mark new emails as existing to prevent duplicates within this batch
      for (const e of emails) {
        existingEmails.add(e.email.toLowerCase());
      }
    } else {
      console.error(
        "Failed to create Google contact:",
        res.status,
        await res.text(),
      );
      skipped++;
    }
  }

  return { total: (crmContacts ?? []).length, created, skipped };
}

async function getSyncStatus(userId: string) {
  const { data: prefs } = await supabaseAdmin
    .from("connector_preferences")
    .select("preferences, updated_at")
    .eq("user_id", userId)
    .eq("connector_type", "google")
    .single();

  return {
    lastSyncAt: (prefs?.preferences as any)?.lastSyncAt ?? null,
  };
}

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        if (req.method !== "POST") {
          return createErrorResponse(405, "Method Not Allowed");
        }

        const currentUserSale = await getUserSale(user);
        if (!currentUserSale) {
          return createErrorResponse(401, "Unauthorized");
        }

        try {
          const { action } = await req.json();

          let result: unknown;

          switch (action) {
            case "sync":
              result = await syncContacts(user!.id, currentUserSale.id);

              // Update last sync timestamp
              await supabaseAdmin
                .from("connector_preferences")
                .update({
                  preferences: {
                    ...((
                      await supabaseAdmin
                        .from("connector_preferences")
                        .select("preferences")
                        .eq("user_id", user!.id)
                        .eq("connector_type", "google")
                        .single()
                    ).data?.preferences as any),
                    lastSyncAt: new Date().toISOString(),
                  },
                  updated_at: new Date().toISOString(),
                })
                .eq("user_id", user!.id)
                .eq("connector_type", "google");
              break;

            case "export-to-google":
              result = await exportToGoogle(user!.id, currentUserSale.id);
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
          console.error("google-contacts-sync error:", e);
          const message = e instanceof Error ? e.message : "Internal error";
          if (
            message === "GOOGLE_NOT_CONNECTED" ||
            message === "GOOGLE_TOKEN_EXPIRED" ||
            message === "GOOGLE_CONTACTS_WRITE_REQUIRED"
          ) {
            return createErrorResponse(401, message);
          }
          return createErrorResponse(500, message);
        }
      }),
    ),
  ),
);
