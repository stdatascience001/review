import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn, copyToClipboard } from '@/lib/utils';

/** Pulls the script URL and any extra data-* attributes out of the generated snippet. */
const parseSnippet = (embedScript: string) => {
  const src = embedScript.match(/src="([^"]+)"/)?.[1] ?? '';
  const apiUrl = embedScript.match(/data-api-url="([^"]+)"/)?.[1];
  return { src, apiUrl };
};

const guides = (embedScript: string, siteId: string) => {
  const { src, apiUrl } = parseSnippet(embedScript);
  const apiAttr = apiUrl ? `\n  data-api-url="${apiUrl}"` : '';
  const apiJsx = apiUrl ? `\n        data-api-url="${apiUrl}"` : '';
  const apiDataset = apiUrl ? `\n    s.dataset.apiUrl = '${apiUrl}';` : '';
  return [
    {
      key: 'html',
      label: 'HTML',
      steps: ['Open your site template (or every page).', 'Paste the snippet just before </body>.', 'Publish, then reload the page: the Review button appears bottom-right.'],
      file: 'index.html',
      code: `<!-- … your page … -->\n${embedScript}\n</body>`,
    },
    {
      key: 'wordpress',
      label: 'WordPress',
      steps: [
        'Easiest: install a header/footer plugin (e.g. "WPCode") and paste the snippet into the Footer box.',
        'Or add this to your child theme\'s functions.php (survives theme updates):',
      ],
      file: 'functions.php',
      code: `add_action('wp_footer', function () {\n  ?>\n  ${embedScript}\n  <?php\n});`,
    },
    {
      key: 'react',
      label: 'React',
      steps: ['Add the script once, in your root component (e.g. App.tsx). Works with Vite, CRA and React Router.'],
      file: 'App.tsx',
      code: `import { useEffect } from 'react';\n\nexport default function App() {\n  useEffect(() => {\n    if (document.querySelector('script[data-site-id="${siteId}"]')) return;\n    const s = document.createElement('script');\n    s.src = '${src}';\n    s.async = true;\n    s.dataset.siteId = '${siteId}';${apiDataset}\n    document.body.appendChild(s);\n  }, []);\n\n  return <>{/* your app */}</>;\n}`,
    },
    {
      key: 'next',
      label: 'Next.js',
      steps: ['Add next/script to your root layout (App Router) or _app.tsx (Pages Router). Route changes are detected automatically.'],
      file: 'app/layout.tsx',
      code: `import Script from 'next/script';\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script\n          src="${src}"\n          data-site-id="${siteId}"${apiJsx}\n          strategy="lazyOnload"\n        />\n      </body>\n    </html>\n  );\n}`,
    },
    {
      key: 'astro',
      label: 'Astro',
      steps: ['Add the tag to your base layout. is:inline keeps Astro from bundling it.'],
      file: 'src/layouts/Layout.astro',
      code: `<html lang="en">\n  <body>\n    <slot />\n    <script\n      is:inline\n      async\n      src="${src}"\n      data-site-id="${siteId}"${apiAttr}\n    ></script>\n  </body>\n</html>`,
    },
    {
      key: 'other',
      label: 'Other / GTM',
      steps: [
        'Any site builder (Webflow, Shopify, Wix, Squarespace…): paste the snippet into the "custom code → footer" setting.',
        'Google Tag Manager: create a Custom HTML tag with the snippet, trigger "All Pages".',
        'Single-page apps (Vue, Angular, Svelte…): add it once to index.html. Page changes are tracked automatically.',
      ],
      file: 'snippet',
      code: embedScript,
    },
  ];
};

export const InstallGuide = ({ embedScript, siteId }: { embedScript: string; siteId: string }) => {
  const list = guides(embedScript, siteId);
  const [active, setActive] = useState(list[0]!.key);
  const [copied, setCopied] = useState(false);
  const g = list.find((x) => x.key === active)!;

  return (
    <div className="mt-6" data-testid="install-guide">
      <h3 className="mb-2 text-sm font-semibold">Installation guide</h3>
      <div role="tablist" aria-label="Platform" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
        {list.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={active === x.key}
            onClick={() => {
              setActive(x.key);
              setCopied(false);
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition',
              active === x.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-600">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="mt-3 overflow-hidden rounded-lg bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-700 px-3 py-1.5">
          <span className="font-mono text-xs text-slate-400">{g.file}</span>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-slate-300 hover:text-white"
            onClick={async () => {
              if (await copyToClipboard(g.code)) {
                setCopied(true);
                toast.success(`${g.label} snippet copied`);
              }
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-100" data-testid="install-code">
          {g.code}
        </pre>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        The widget only runs on this website's domain and the allowed domains in Settings. The Site ID is public; reviewers still sign in to see or add
        anything.
      </p>
    </div>
  );
};
