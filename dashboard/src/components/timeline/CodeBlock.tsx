import { useEffect, useMemo, useRef } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/themes/prism-tomorrow.css";
import AnsiToHtml from "ansi-to-html";

const ansiConverter = new AnsiToHtml({
  fg: "#c9d1d9",
  bg: "transparent",
  newline: true,
  escapeXML: true,
});

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[\d;]*m/;

interface Props {
  code: string;
  language?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, language = "text", maxHeight }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lang = Prism.languages[language] ? language : "text";
  const hasAnsi = useMemo(() => ANSI_RE.test(code), [code]);

  useEffect(() => {
    if (ref.current && !hasAnsi) Prism.highlightElement(ref.current);
  }, [code, lang, hasAnsi]);

  const ansiHtml = useMemo(
    () => (hasAnsi ? ansiConverter.toHtml(code) : ""),
    [code, hasAnsi],
  );

  return (
    <pre
      className="m-0 font-mono text-xs bg-base-300/60 rounded overflow-auto"
      style={maxHeight ? { maxHeight } : undefined}
    >
      {hasAnsi ? (
        <code
          className="!bg-transparent !text-inherit !p-3 block whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: ansiHtml }}
        />
      ) : (
        <code ref={ref} className={`language-${lang} !bg-transparent !text-inherit !p-3 block`}>
          {code}
        </code>
      )}
    </pre>
  );
}
