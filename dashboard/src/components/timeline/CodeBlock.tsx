import { useEffect, useRef } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/themes/prism-tomorrow.css";

interface Props {
  code: string;
  language?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, language = "text", maxHeight }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lang = Prism.languages[language] ? language : "text";

  useEffect(() => {
    if (ref.current) Prism.highlightElement(ref.current);
  }, [code, lang]);

  return (
    <pre
      className="m-0 font-mono text-xs bg-base-300/60 rounded overflow-auto"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <code ref={ref} className={`language-${lang} !bg-transparent !text-inherit !p-3 block`}>
        {code}
      </code>
    </pre>
  );
}
