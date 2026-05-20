import {
  buildReflectionBlock,
  type ReflectionCardText,
} from "@ai-documenter/canvas";

/**
 * What students see in Canvas. Built using the same `buildReflectionBlock`
 * helper the install path uses — single source of truth, no drift.
 *
 * The marker comments are stripped from the preview since they don't render
 * visually but muddy the DOM.
 */
export function CardPreview({
  appBaseUrl,
  iframeToken = "preview-token-abc",
  text,
}: {
  appBaseUrl: string;
  iframeToken?: string;
  text?: Partial<ReflectionCardText>;
}) {
  const raw = buildReflectionBlock({
    appBaseUrl,
    iframeToken,
    promptVersion: 1,
    text,
  });
  const html = raw
    .replace(/<!--\s*ehs-ai-reflect:begin[^>]*-->\s*/i, "")
    .replace(/\s*<!--\s*ehs-ai-reflect:end\s*-->/i, "");

  return (
    <div className="rounded border border-light-blue/40 bg-paper p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-cool-gray">
        Preview — what students see in Canvas
      </div>
      <div
        className="max-w-2xl"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
