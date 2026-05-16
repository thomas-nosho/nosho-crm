import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { AuthMiddleware } from "../_shared/authentication.ts";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_MODEL = "mistral-large-latest";

type LabeledValue = { value: string; label: string };

interface RequestBody {
  name?: string;
  sectors?: LabeledValue[];
  types?: LabeledValue[];
}

interface MistralEnrichment {
  name?: string;
  website?: string;
  linkedin_url?: string;
  phone_number?: string;
  description?: string;
  sector?: string;
  type?: string;
  size?: 1 | 10 | 50 | 250 | 500;
  address?: string;
  city?: string;
  zipcode?: string;
  country?: string;
  not_found?: boolean;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const apiKey = Deno.env.get("MISTRAL_API_KEY");
  if (!apiKey) {
    console.error("[enrich-mistral-company] MISTRAL_API_KEY not set");
    return jsonResponse(500, { error: "MISTRAL_API_KEY not configured" });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch (e) {
    console.error("[enrich-mistral-company] Invalid JSON body:", e);
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return jsonResponse(400, { error: "name is required" });
  }

  const sectors = Array.isArray(body.sectors) ? body.sectors : [];
  const types = Array.isArray(body.types) ? body.types : [];

  const sectorList = sectors.length
    ? sectors.map((s) => `- "${s.value}" (${s.label})`).join("\n")
    : "(aucune liste fournie — laisser vide)";
  const typeList = types.length
    ? types.map((t) => `- "${t.value}" (${t.label})`).join("\n")
    : "(aucune liste fournie — laisser vide)";

  const systemPrompt = `Tu es un assistant qui enrichit les fiches société d'un CRM français spécialisé dans la santé.
À partir d'un nom d'entreprise, tu retournes les informations publiques que tu connais sous forme JSON strict.
N'invente jamais d'information : si tu n'es pas sûr d'un champ, omets-le complètement.
Si l'entreprise est inconnue, retourne {"not_found": true}.

Schéma JSON attendu :
{
  "name": string (nom officiel),
  "website": string (URL complète https://…),
  "linkedin_url": string (URL LinkedIn de l'entreprise),
  "phone_number": string (numéro de téléphone format international),
  "description": string (1-2 phrases en français décrivant l'activité),
  "sector": string (UNE des valeurs ci-dessous, choisis la plus pertinente),
  "type": string (UNE des valeurs ci-dessous),
  "size": number (UN des codes 1, 10, 50, 250, 500),
  "address": string (rue uniquement),
  "city": string,
  "zipcode": string,
  "country": string,
  "not_found": boolean
}

Codes "size" :
- 1 → 1 employé
- 10 → 2-9 employés
- 50 → 10-49 employés
- 250 → 50-249 employés
- 500 → 250+ employés

Valeurs autorisées pour "sector" (utilise EXACTEMENT la valeur entre guillemets) :
${sectorList}

Valeurs autorisées pour "type" (utilise EXACTEMENT la valeur entre guillemets) :
${typeList}

Réponds UNIQUEMENT avec le JSON, sans texte additionnel.`;

  const userPrompt = `Nom de l'entreprise : "${name}"`;

  let mistralRes: Response;
  try {
    mistralRes = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    console.error("[enrich-mistral-company] fetch failed:", e);
    return jsonResponse(502, { error: "Failed to reach Mistral API" });
  }

  if (!mistralRes.ok) {
    const text = await mistralRes.text();
    console.error(
      `[enrich-mistral-company] Mistral ${mistralRes.status}: ${text}`,
    );
    return jsonResponse(502, {
      error: `Mistral error ${mistralRes.status}`,
      detail: text.slice(0, 500),
    });
  }

  let raw: unknown;
  try {
    raw = await mistralRes.json();
  } catch (e) {
    console.error("[enrich-mistral-company] invalid Mistral JSON:", e);
    return jsonResponse(502, { error: "Invalid Mistral response" });
  }

  const content =
    (raw as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";

  let parsed: MistralEnrichment;
  try {
    parsed = JSON.parse(content) as MistralEnrichment;
  } catch (e) {
    console.error("[enrich-mistral-company] JSON.parse failed:", e, content);
    return jsonResponse(502, { error: "Mistral returned invalid JSON" });
  }

  const result = sanitize(parsed, sectors, types);
  console.log(
    `[enrich-mistral-company] "${name}" → ${Object.keys(result).length} fields, not_found=${result.not_found ?? false}`,
  );
  return jsonResponse(200, result);
}

function sanitize(
  raw: MistralEnrichment,
  sectors: LabeledValue[],
  types: LabeledValue[],
): MistralEnrichment {
  const out: MistralEnrichment = {};

  if (raw.not_found === true) return { not_found: true };

  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  out.name = str(raw.name);
  out.website = str(raw.website);
  out.linkedin_url = str(raw.linkedin_url);
  out.phone_number = str(raw.phone_number);
  out.description = str(raw.description);
  out.address = str(raw.address);
  out.city = str(raw.city);
  out.zipcode = str(raw.zipcode);
  out.country = str(raw.country);

  const sector = str(raw.sector);
  if (sector && sectors.some((s) => s.value === sector)) out.sector = sector;

  const type = str(raw.type);
  if (type && types.some((t) => t.value === type)) out.type = type;

  if (
    raw.size === 1 ||
    raw.size === 10 ||
    raw.size === 50 ||
    raw.size === 250 ||
    raw.size === 500
  ) {
    out.size = raw.size;
  }

  // Strip undefined keys for cleaner JSON over the wire.
  for (const k of Object.keys(out) as (keyof MistralEnrichment)[]) {
    if (out[k] === undefined) delete out[k];
  }

  return out;
}

Deno.serve((req) =>
  OptionsMiddleware(req, (req) => AuthMiddleware(req, handler)),
);
