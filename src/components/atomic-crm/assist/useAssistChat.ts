import { useCallback, useRef, useState } from "react";
import { getSupabaseClient } from "../providers/supabase/supabase";
import { ATTACHMENTS_BUCKET } from "../providers/commons/attachments";

// Long enough for the team to triage the ticket; short enough that a
// leaked URL eventually expires.
const ASSIST_ATTACHMENT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type AssistMode = "feedback" | "crm-action";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AssistDraft = {
  type: "bug" | "feature" | "question";
  title: string;
  summary: string;
  ready: true;
};

type AssistChatResponse = {
  reply: string;
  draft: AssistDraft | null;
};

type CrmAgentResponse = {
  reply: string;
};

type SubmitResponse = {
  ok: boolean;
  issueUrl?: string;
  issueNumber?: number;
};

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `nosho-${crypto.randomUUID()}`;
  }
  return `nosho-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function uploadAssistImages(files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const client = getSupabaseClient();
  const urls: string[] = [];
  for (const file of files) {
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
    const path = `assist/${crypto.randomUUID()}${ext}`;
    const { error: upErr } = await client.storage
      .from(ATTACHMENTS_BUCKET)
      .upload(path, file, { contentType: file.type });
    if (upErr) throw new Error(`Upload échoué : ${upErr.message}`);
    const { data: signed, error: signErr } = await client.storage
      .from(ATTACHMENTS_BUCKET)
      .createSignedUrl(path, ASSIST_ATTACHMENT_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      throw new Error(`Signature d'URL échouée : ${signErr?.message ?? ""}`);
    }
    urls.push(signed.signedUrl);
  }
  return urls;
}

async function sendCrmAction(
  message: string,
  sessionId: string,
): Promise<CrmAgentResponse> {
  const webhookUrl = import.meta.env.VITE_N8N_CRM_AGENT_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error(
      "Mode Action CRM non configuré (VITE_N8N_CRM_AGENT_WEBHOOK_URL)",
    );
  }
  const { data: sessionData } = await getSupabaseClient().auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) throw new Error("Session expirée — reconnecte-toi");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agent CRM ${res.status} : ${text.slice(0, 200)}`);
  }
  return (await res.json()) as CrmAgentResponse;
}

export function useAssistChat(mode: AssistMode = "feedback") {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<AssistDraft | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(generateSessionId());

  const reset = useCallback(() => {
    setMessages([]);
    setDraft(null);
    setError(null);
    setIsSending(false);
    setIsSubmitting(false);
    // Fresh sessionId — n8n memory is keyed on this, so a new one starts a
    // clean conversation.
    sessionIdRef.current = generateSessionId();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      setError(null);
      const userMessage: ChatMessage = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMessage]);
      setIsSending(true);

      try {
        let reply = "";
        let nextDraft: AssistDraft | null = null;

        if (mode === "crm-action") {
          const data = await sendCrmAction(trimmed, sessionIdRef.current);
          reply = data.reply ?? "";
        } else {
          const { data, error: invokeError } =
            await getSupabaseClient().functions.invoke<AssistChatResponse>(
              "assist-chat",
              {
                body: {
                  sessionId: sessionIdRef.current,
                  message: trimmed,
                  context: {
                    currentRoute:
                      typeof window !== "undefined"
                        ? window.location.pathname + window.location.hash
                        : "",
                  },
                },
              },
            );
          if (invokeError) throw invokeError;
          if (!data) throw new Error("Réponse vide de l'assistant");
          reply = data.reply ?? "";
          nextDraft = data.draft ?? null;
        }

        if (reply) {
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: reply,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }
        if (nextDraft) setDraft(nextDraft);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsSending(false);
      }
    },
    [isSending, mode],
  );

  const submitDraft = useCallback(
    async (images?: File[]): Promise<SubmitResponse | null> => {
      if (!draft || isSubmitting) return null;
      setError(null);
      setIsSubmitting(true);
      try {
        const attachmentUrls = await uploadAssistImages(images ?? []);
        const summary = attachmentUrls.length
          ? `${draft.summary}\n\n---\n**Captures d'écran :**\n\n${attachmentUrls
              .map((url, i) => `![Capture ${i + 1}](${url})`)
              .join("\n\n")}`
          : draft.summary;

        const { data, error: invokeError } =
          await getSupabaseClient().functions.invoke<SubmitResponse>(
            "assist-submit",
            {
              body: {
                sessionId: sessionIdRef.current,
                draft: { ...draft, summary },
                currentRoute:
                  typeof window !== "undefined"
                    ? window.location.pathname + window.location.hash
                    : "",
                userAgent:
                  typeof navigator !== "undefined" ? navigator.userAgent : "",
                transcript: messages,
              },
            },
          );
        if (invokeError) throw invokeError;
        return data ?? null;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setIsSubmitting(false);
      }
    },
    [draft, messages, isSubmitting],
  );

  return {
    messages,
    draft,
    isSending,
    isSubmitting,
    error,
    sendMessage,
    submitDraft,
    reset,
  };
}
