// The services' own logos (2026-11-07, the person: «i vari servizi devono avere le loro vere
// icone»), from simple-icons (CC0): SVG paths drawn inline in the brand's colour, nothing loaded
// from outside. Only the icons named here are bundled. A colour too close to the page's background
// is mixed towards white (dark theme) or black (light theme) until it reads. Services without a
// logo in simple-icons (removed there at their owners' request: OpenAI, Slack, Microsoft,
// Salesforce, Canva…) keep the generic drawn icon.
import type { JSX } from "preact";
import {
  type SimpleIcon,
  siAirtable,
  siAnthropic,
  siApple,
  siAsana,
  siAtlassian,
  siBinance,
  siBitwarden,
  siBrave,
  siClaude,
  siClickup,
  siCloudflare,
  siCoinbase,
  siDeepseek,
  siDiscord,
  siDropbox,
  siFacebook,
  siGithub,
  siGitlab,
  siGmail,
  siGoogle,
  siGooglecalendar,
  siGoogledrive,
  siGooglegemini,
  siGooglemaps,
  siHomeassistant,
  siHubspot,
  siHuggingface,
  siIcloud,
  siInstagram,
  siIntercom,
  siLinear,
  siMistralai,
  siN26,
  siNeon,
  siNetflix,
  siNotion,
  siOllama,
  siOpenrouter,
  siPaypal,
  siPerplexity,
  siPostgresql,
  siProtonmail,
  siRevolut,
  siSearxng,
  siSentry,
  siShopify,
  siSignal,
  siSpotify,
  siSquare,
  siStripe,
  siSupabase,
  siTelegram,
  siTodoist,
  siTrello,
  siWhatsapp,
  siWise,
  siWordpress,
  siX,
  siZapier,
} from "simple-icons";

/** Our ids (catalog entries, chat platforms, model and search providers) to their logos. */
const BRANDS: Record<string, SimpleIcon> = {
  // the extensions' catalog
  airtable: siAirtable,
  asana: siAsana,
  atlassian: siAtlassian,
  clickup: siClickup,
  cloudflare: siCloudflare,
  dropbox: siDropbox,
  github: siGithub,
  gitlab: siGitlab,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  "google-drive": siGoogledrive,
  "google-maps": siGooglemaps,
  "home-assistant": siHomeassistant,
  hubspot: siHubspot,
  "hugging-face": siHuggingface,
  intercom: siIntercom,
  linear: siLinear,
  neon: siNeon,
  notion: siNotion,
  paypal: siPaypal,
  perplexity: siPerplexity,
  postgres: siPostgresql,
  sentry: siSentry,
  "shopify-dev": siShopify,
  square: siSquare,
  stripe: siStripe,
  supabase: siSupabase,
  todoist: siTodoist,
  trello: siTrello,
  wordpress: siWordpress,
  zapier: siZapier,
  // chats on other apps
  telegram: siTelegram,
  whatsapp: siWhatsapp,
  discord: siDiscord,
  signal: siSignal,
  // model providers and ways to connect a model
  anthropic: siAnthropic,
  claude: siClaude,
  gemini: siGooglegemini,
  mistral: siMistralai,
  deepseek: siDeepseek,
  openrouter: siOpenrouter,
  ollama: siOllama,
  huggingface: siHuggingface,
  // web search
  searxng: siSearxng,
  brave: siBrave,
  // the keychain's services (G33.4)
  apple: siApple,
  binance: siBinance,
  bitwarden: siBitwarden,
  coinbase: siCoinbase,
  facebook: siFacebook,
  google: siGoogle,
  icloud: siIcloud,
  instagram: siInstagram,
  n26: siN26,
  netflix: siNetflix,
  proton: siProtonmail,
  revolut: siRevolut,
  spotify: siSpotify,
  wise: siWise,
  x: siX,
};

/** A service's name or address to one of the logos above ("Revolut Business" → revolut). */
export function brandFor(service: string, url = ""): string | undefined {
  const words = `${service} ${url}`.toLowerCase();
  return Object.keys(BRANDS).find((id) =>
    id.length <= 2
      ? new RegExp(`(^|[\\s./])${id}(\\.com)?($|[\\s/])`).test(words)
      : words.includes(id),
  );
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb =>
  [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const lum = ([r, g, b]: Rgb) => {
  const c = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** The brand's colour, mixed towards `to` until it stands 3:1 against `bg` (WCAG, graphics). */
function readable(brand: string, bg: Rgb, to: Rgb): string {
  const c = rgb(brand);
  for (let k = 0; k <= 1.0001; k += 0.05) {
    const m = c.map((v, i) => v + ((to[i] ?? 0) - v) * k) as Rgb;
    if (contrast(m, bg) >= 3) return hex(m);
  }
  return hex(to);
}
// The panels' colours of the two themes (styles.css: --panel-2, where icons sit on tiles).
const LIGHT_BG: Rgb = [238, 240, 244];
const DARK_BG: Rgb = [37, 41, 50];
const fills = new Map<string, { light: string; dark: string }>();
const fillOf = (i: SimpleIcon) => {
  let f = fills.get(i.slug);
  if (!f) {
    f = {
      light: readable(i.hex, LIGHT_BG, [0, 0, 0]),
      dark: readable(i.hex, DARK_BG, [255, 255, 255]),
    };
    fills.set(i.slug, f);
  }
  return f;
};

export const hasBrand = (id: string): boolean => id in BRANDS;

/** The service's logo, or nothing when there is none. */
export function BrandIcon({ id, size = 22 }: { id: string; size?: number }): JSX.Element | null {
  const i = BRANDS[id];
  if (!i) return null;
  const f = fillOf(i);
  return (
    <svg
      class="brand-ico"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ "--b-l": f.light, "--b-d": f.dark }}
    >
      <path d={i.path} />
    </svg>
  );
}

/** The logo when there is one, otherwise the drawn icon given. */
export const brandOr = (id: string, fallback: JSX.Element, size?: number): JSX.Element =>
  hasBrand(id) ? <BrandIcon id={id} {...(size !== undefined && { size })} /> : fallback;
