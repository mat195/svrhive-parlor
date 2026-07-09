// Faithful live preview of a corpus /notes/ page — renders draft markdown inside an iframe
// that uses the REAL site's fonts + typography (Instrument Serif display, Inter body, the
// velvet palette + grain), wrapped in the same <article class="note"> the site uses. Only
// the rules global.css actually defines are included; everything else (tables, lists) falls
// to browser defaults exactly as it does on silkvelvetrecords.com — so this looks like the
// page, not a text approximation. CORS blocks fetching the live CSS cross-origin, so the
// essential rules are mirrored here (keep in sync if the site's base typography changes).

const SITE_CSS = `
:root{
  --velvet:#16101c; --underfelt:#201826; --cream:#efe6d8; --silk:#c9a86a;
  --ribbon:#7a3b4f; --ribbon-lift:#9a4f66; --static:#8d8496; --iris:#3f8f8c;
  --hairline:rgba(201,168,106,0.22); --edge:rgba(201,168,106,0.28);
  --display:'Instrument Serif',Georgia,'Times New Roman',serif;
  --body:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --measure:40rem;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--velvet);color:var(--cream);font-family:var(--body);line-height:1.62;-webkit-font-smoothing:antialiased;position:relative;}
/* velvet grain — the same soft-light weave the real site lays under everything */
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:0.9;mix-blend-mode:soft-light;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.62' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E");}
.wrap{position:relative;z-index:1;max-width:44rem;margin:0 auto;padding:2rem 1.5rem 4rem;}
a{color:var(--cream);text-decoration:none;border-bottom:1px solid var(--hairline);}
a:hover{color:var(--ribbon-lift);}
h1,h2,h3{font-family:var(--display);font-weight:400;line-height:1.02;letter-spacing:-0.005em;}
h1{font-size:clamp(2.6rem,7vw,4.2rem);margin:0 0 .3em;line-height:.98;}
h2{font-size:clamp(1.5rem,3.8vw,2.2rem);margin:2.4rem 0 .7rem;}
h3{font-size:1.28rem;margin:1.4rem 0 .4rem;}
p{margin:0 0 1rem;max-width:var(--measure);}
`;

const FONTS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

/** Full HTML document for the preview iframe srcDoc. `bodyHtml` = markdown already rendered to HTML. */
export function buildPreviewDoc(bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="${FONTS}" rel="stylesheet">` +
    `<style>${SITE_CSS}</style></head>` +
    `<body><main class="wrap"><article class="note">${bodyHtml}</article></main></body></html>`;
}
