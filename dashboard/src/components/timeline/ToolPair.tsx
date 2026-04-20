import { useMemo, useState } from "react";
import clsx from "clsx";
import DOMPurify from "dompurify";
import AnsiToHtml from "ansi-to-html";
import type { ToolPair as ToolPairType } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { CodeBlock } from "./CodeBlock";
import {
  renderToolSummary,
  getArgsLang,
  formatToolName,
} from "../../timeline/toolRenderers";
import { summarizeResult, formatBytes } from "../../timeline/resultPreview";
import { classifyTool, FAMILY_VISUAL, iconForTool } from "../../timeline/toolFamily";

interface Props {
  pair: ToolPairType;
  isNew?: boolean;
}

const RESULT_TRUNCATE_CHARS = 8000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[\d;]*m/;
const ansiConverter = new AnsiToHtml({ fg: "#c9d1d9", bg: "transparent", escapeXML: true });

function stringifyResultContent(content: unknown): { text: string; isJson: boolean } {
  if (content == null) return { text: "", isJson: false };
  if (typeof content === "string") return { text: content, isJson: false };
  if (Array.isArray(content)) {
    const allText = content.every(
      (c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string",
    );
    if (allText) {
      return {
        text: content.map((c) => (c as Record<string, string>).text).join("\n"),
        isJson: false,
      };
    }
  }
  try {
    return { text: JSON.stringify(content, null, 2), isJson: true };
  } catch {
    return { text: String(content), isJson: false };
  }
}

export function ToolPair({ pair, isNew }: Props) {
  const [argsExpanded, setArgsExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const input = (pair.use.content as { input?: Record<string, unknown> })?.input ?? {};
  const resultContent = (pair.result?.content as { content?: unknown })?.content;
  const isError = (pair.result?.content as { is_error?: boolean })?.is_error === true;
  const { text: resultText, isJson } = stringifyResultContent(resultContent);
  const argsJson = JSON.stringify(input, null, 2);
  const summary = summarizeResult(resultContent);
  const toolLabel = formatToolName(pair.toolName);
  const family = classifyTool(pair.toolName);
  const vis = FAMILY_VISUAL[family];
  const Icon = iconForTool(pair.toolName, family);

  return (
    <MessageCard
      isNew={isNew}
      timestamp={pair.timestamp}
      dense
      title={
        <>
          <RowIcon Icon={Icon} color={vis.color} bg={vis.bg} />
          <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/80 shrink-0 font-mono">
            {toolLabel.prefix ? `${toolLabel.prefix}.${toolLabel.label}` : toolLabel.label}
          </span>
          <span className="text-base-content/25 shrink-0">-</span>
          {renderToolSummary(pair.toolName, input)}
        </>
      }
      headerRight={
        <div className="flex items-center gap-1.5 shrink-0">
          {pair.result == null && (
            <span className="badge badge-xs badge-warning animate-pulse">running</span>
          )}
          {isError && <span className="badge badge-xs badge-error">error</span>}
          <button
            onClick={() => setArgsExpanded(!argsExpanded)}
            className="text-2xs text-base-content/45 hover:text-base-content font-mono"
            title="Toggle full args"
          >
            {argsExpanded ? "- args" : "+ args"}
          </button>
        </div>
      }
    >
      {argsExpanded && (
        <div className="mb-2">
          <CodeBlock code={argsJson} language={getArgsLang(pair.toolName)} maxHeight="24rem" />
        </div>
      )}
      {pair.result && (
        <div>
          <button
            type="button"
            disabled={summary.kind === "empty"}
            onClick={() => summary.kind !== "empty" && setResultExpanded(!resultExpanded)}
            className={clsx(
              "w-full flex items-center gap-2 text-left min-w-0",
              summary.kind !== "empty" && "cursor-pointer hover:text-base-content",
            )}
          >
            <span
              className={clsx(
                "text-2xs uppercase tracking-wider font-semibold shrink-0",
                isError ? "text-error" : "text-base-content/55",
              )}
            >
              {isError ? "Error" : "Result"}
            </span>
            {summary.kind === "empty" ? (
              <span className="text-2xs text-base-content/40 italic">(empty)</span>
            ) : (
              <>
                <span className="text-base-content/25 shrink-0">-</span>
                {!resultExpanded && (() => {
                  const preview =
                    summary.kind === "text" ? summary.preview :
                    summary.kind === "json" ? summary.preview :
                    summary.kind === "array" ? `[${summary.length}] ${summary.preview ? "- " + summary.preview : ""}` :
                    "";
                  const hasAnsi = typeof preview === "string" && ANSI_RE.test(preview);
                  return hasAnsi ? (
                    <span
                      className="text-xs font-mono truncate flex-1"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(ansiConverter.toHtml(preview), { ADD_ATTR: ["style"] }) }}
                    />
                  ) : (
                    <span
                      className={clsx(
                        "text-xs font-mono truncate flex-1",
                        summary.kind === "json" ? "text-base-content/60" : "text-base-content/75",
                      )}
                    >
                      {preview}
                    </span>
                  );
                })()}
                <span className="ml-auto text-2xs text-base-content/40 font-mono shrink-0 flex items-center gap-2">
                  {summary.kind === "text" && summary.lines && summary.lines > 1 && (
                    <span>{summary.lines.toLocaleString()} lines</span>
                  )}
                  {summary.kind === "array" && (
                    <span>{summary.length.toLocaleString()} items</span>
                  )}
                  <span>{formatBytes(summary.bytes)}</span>
                  <span>{resultExpanded ? "-" : "+"}</span>
                </span>
              </>
            )}
          </button>
          {resultExpanded && resultText && (
            <div className="mt-2">
              <CodeBlock
                code={
                  resultText.length > RESULT_TRUNCATE_CHARS
                    ? resultText.slice(0, RESULT_TRUNCATE_CHARS) +
                      `\n\n... (${(resultText.length - RESULT_TRUNCATE_CHARS).toLocaleString()} more chars)`
                    : resultText
                }
                language={isJson ? "json" : "text"}
                maxHeight="32rem"
              />
            </div>
          )}
        </div>
      )}
    </MessageCard>
  );
}
