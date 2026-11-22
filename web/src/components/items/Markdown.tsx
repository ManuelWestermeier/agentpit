import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// react-markdown does not render raw HTML (no rehype-raw), so model output cannot inject markup.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
