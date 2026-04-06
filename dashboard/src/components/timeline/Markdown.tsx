import { useMemo } from "react";
import { renderMarkdown } from "../../timeline/markdown";

interface Props {
  source: string;
  className?: string;
}

export function Markdown({ source, className = "" }: Props) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={`ll-prose ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
