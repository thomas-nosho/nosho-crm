import {
  buildDraftSummaryWithAttachments,
  formatAssistMessageWithAttachments,
  type AssistAttachment,
} from "./useAssistChat";

const attachments: AssistAttachment[] = [
  {
    url: "https://example.test/storage/signed/screenshot.png",
    name: "screenshot.png",
    type: "image/png",
    size: 1234,
  },
];

describe("useAssistChat attachment formatting", () => {
  it("adds image URLs to the message forwarded to the assist workflow", () => {
    expect(
      formatAssistMessageWithAttachments("Voici le bug", attachments),
    ).toContain(
      "screenshot.png: https://example.test/storage/signed/screenshot.png",
    );
  });

  it("adds image markdown to the submitted draft summary", () => {
    expect(buildDraftSummaryWithAttachments("Résumé", attachments)).toContain(
      "![screenshot.png](https://example.test/storage/signed/screenshot.png)",
    );
  });
});
