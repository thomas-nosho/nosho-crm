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
  attachments?: AssistAttachment[];
};

export type AssistDraft = {
  type: "bug" | "feature" | "question";
  title: string;
  summary: string;
  ready: true;
};

export type AssistAttachment = {
  url: string;
  name: string;
  type: string;
  size: number;
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

export function formatAssistMessageWithAttachments(
  message: string,
  attachments: AssistAttachment[],
): string {
  if (attachments.length === 0) return message;
  const attachmentList = attachments
    .map((attachment, index) => {
      const name = attachment.name || `Capture ${index + 1}`;
      return `- ${name}: ${attachment.url}`;
    })
    .join("\n");
  return `${message}\n\nImages jointes :\n${attachmentList}`;
}

export function buildDraftSummaryWithAttachments(
  summary: string,
  attachments: AssistAttachment[],
): string {
  if (attachments.length === 0) return summary;
  return `${summary}\n\n---\n**Captures d'écran :**\n\n${attachments
    .map((attachment, i) => {
      const title = attachment.name || `Capture ${i + 1}`;
      return `![${title}](${attachment.url})`;
    })
    .join("\n\n")}`;
}

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `nosho-${crypto.randomUUID()}`;
  }
  return `nosho-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function uploadAssistImages(files: File[]): Promise<AssistAttachment[]> {
  if (files.length === 0) return [];
  const client = getSupabaseClient();
  const attachments: AssistAttachment[] = [];
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
    attachments.push({
      url: signed.signedUrl,
      name: file.name,
      type: file.type,
      size: file.size,
    });
  }
  return attachments;
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
    async (text: string, images?: File[]): Promise<boolean> => {
      const trimmed = text.trim();
      const imageFiles = images ?? [];
      if ((!trimmed && imageFiles.length === 0) || isSending) return false;

      setError(null);
      setIsSending(true);

      try {
        const attachments = await uploadAssistImages(imageFiles);
        const userContent = trimmed || "Capture d'écran jointe.";
        const userMessage: ChatMessage = {
          role: "user",
          content: userContent,
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        setMessages((prev) => [...prev, userMessage]);

        let reply = "";
        let nextDraft: AssistDraft | null = null;

        if (mode === "crm-action") {
          const data = await sendCrmAction(userContent, sessionIdRef.current);
          reply = data.reply ?? "";
        } else {
          const webhookMessage = formatAssistMessageWithAttachments(
            userContent,
            attachments,
          );
          const { data, error: invokeError } =
            await getSupabaseClient().functions.invoke<AssistChatResponse>(
              "assist-chat",
              {
                body: {
                  sessionId: sessionIdRef.current,
                  message: webhookMessage,
                  attachments,
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
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
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
        const newAttachments = await uploadAssistImages(images ?? []);
        const transcriptAttachments = messages.flatMap(
          (message) => message.attachments ?? [],
        );
        const attachments = [...transcriptAttachments, ...newAttachments];
        const summary = buildDraftSummaryWithAttachments(
          draft.summary,
          attachments,
        );

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
                attachments,
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
