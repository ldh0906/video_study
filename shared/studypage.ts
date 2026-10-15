import type { AnchorUnit } from "./anchor";

export interface KitBundle {
  css: string;
  scripts: string[];
}

/**
 * The document an interactive study page runs as: the model's body HTML plus
 * the Lens Kit and KaTeX inlined (a sandboxed, opaque-origin frame may not
 * load anything over the network). The CSP lets the page reach nothing at all.
 */
export function studyPageDocument(opts: { body: string; kit: KitBundle; dark: boolean; unit: AnchorUnit; lang?: string }) {
  const { body, kit, dark, unit } = opts;
  const csp = ["default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval'", "style-src 'unsafe-inline'", "font-src data:", "img-src data: blob:", "connect-src 'none'", "form-action 'none'"].join("; ");
  return `<!doctype html>
<html lang="${opts.lang ?? "ko"}" class="${dark ? "dark" : ""}" data-unit="${unit}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${kit.css}</style>
${kit.scripts.map((s) => `<script>${s}</script>`).join("\n")}
</head>
<body>
${body}
</body>
</html>`;
}
