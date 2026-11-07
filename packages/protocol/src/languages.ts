/**
 * The languages the agents can speak to the person (G33.5): apart from the interface's (only
 * Italian and English are translated), any of the most spoken in the world. Each has a BCP-47
 * code, its own name (what the person recognises) and its name in English (what the agents'
 * instructions say) and in Italian (shown beside the native name in an Italian interface).
 */
export interface AgentLanguage {
  /** BCP-47 code ("es", "pt-BR", "zh-Hans"). */
  code: string;
  /** The name in the language itself ("Español"). */
  native: string;
  /** The name in English, as the instructions say it ("Spanish"). */
  en: string;
  /** The name in Italian ("Spagnolo"). */
  it: string;
  /** Among the most common, listed first. */
  common?: true;
}

/** The interface's languages: the only ones the pages, Telegram and the gateways are written in. */
export type UiLanguage = "it" | "en";

export const AGENT_LANGUAGES: readonly AgentLanguage[] = [
  // The most common first, in this order.
  { code: "it", native: "Italiano", en: "Italian", it: "Italiano", common: true },
  { code: "en", native: "English", en: "English", it: "Inglese", common: true },
  { code: "es", native: "Español", en: "Spanish", it: "Spagnolo", common: true },
  { code: "fr", native: "Français", en: "French", it: "Francese", common: true },
  { code: "de", native: "Deutsch", en: "German", it: "Tedesco", common: true },
  {
    code: "pt-BR",
    native: "Português (Brasil)",
    en: "Portuguese (Brazil)",
    it: "Portoghese (Brasile)",
    common: true,
  },
  {
    code: "zh-Hans",
    native: "中文（简体）",
    en: "Chinese (Simplified)",
    it: "Cinese (semplificato)",
    common: true,
  },
  { code: "hi", native: "हिन्दी", en: "Hindi", it: "Hindi", common: true },
  { code: "ar", native: "العربية", en: "Arabic", it: "Arabo", common: true },
  { code: "ru", native: "Русский", en: "Russian", it: "Russo", common: true },
  { code: "ja", native: "日本語", en: "Japanese", it: "Giapponese", common: true },
  // Then all the others.
  {
    code: "pt-PT",
    native: "Português (Portugal)",
    en: "Portuguese (Portugal)",
    it: "Portoghese (Portogallo)",
  },
  {
    code: "zh-Hant",
    native: "中文（繁體）",
    en: "Chinese (Traditional)",
    it: "Cinese (tradizionale)",
  },
  { code: "ko", native: "한국어", en: "Korean", it: "Coreano" },
  { code: "bn", native: "বাংলা", en: "Bengali", it: "Bengalese" },
  { code: "ur", native: "اردو", en: "Urdu", it: "Urdu" },
  { code: "fa", native: "فارسی", en: "Persian", it: "Persiano" },
  { code: "tr", native: "Türkçe", en: "Turkish", it: "Turco" },
  { code: "nl", native: "Nederlands", en: "Dutch", it: "Olandese" },
  { code: "pl", native: "Polski", en: "Polish", it: "Polacco" },
  { code: "uk", native: "Українська", en: "Ukrainian", it: "Ucraino" },
  { code: "sv", native: "Svenska", en: "Swedish", it: "Svedese" },
  { code: "nb", native: "Norsk (bokmål)", en: "Norwegian (Bokmål)", it: "Norvegese (bokmål)" },
  { code: "da", native: "Dansk", en: "Danish", it: "Danese" },
  { code: "fi", native: "Suomi", en: "Finnish", it: "Finlandese" },
  { code: "is", native: "Íslenska", en: "Icelandic", it: "Islandese" },
  { code: "el", native: "Ελληνικά", en: "Greek", it: "Greco" },
  { code: "he", native: "עברית", en: "Hebrew", it: "Ebraico" },
  { code: "cs", native: "Čeština", en: "Czech", it: "Ceco" },
  { code: "sk", native: "Slovenčina", en: "Slovak", it: "Slovacco" },
  { code: "hu", native: "Magyar", en: "Hungarian", it: "Ungherese" },
  { code: "ro", native: "Română", en: "Romanian", it: "Rumeno" },
  { code: "bg", native: "Български", en: "Bulgarian", it: "Bulgaro" },
  { code: "hr", native: "Hrvatski", en: "Croatian", it: "Croato" },
  { code: "sr", native: "Srpski", en: "Serbian", it: "Serbo" },
  { code: "bs", native: "Bosanski", en: "Bosnian", it: "Bosniaco" },
  { code: "sl", native: "Slovenščina", en: "Slovenian", it: "Sloveno" },
  { code: "mk", native: "Македонски", en: "Macedonian", it: "Macedone" },
  { code: "sq", native: "Shqip", en: "Albanian", it: "Albanese" },
  { code: "lt", native: "Lietuvių", en: "Lithuanian", it: "Lituano" },
  { code: "lv", native: "Latviešu", en: "Latvian", it: "Lettone" },
  { code: "et", native: "Eesti", en: "Estonian", it: "Estone" },
  { code: "be", native: "Беларуская", en: "Belarusian", it: "Bielorusso" },
  { code: "ka", native: "ქართული", en: "Georgian", it: "Georgiano" },
  { code: "hy", native: "Հայերեն", en: "Armenian", it: "Armeno" },
  { code: "az", native: "Azərbaycanca", en: "Azerbaijani", it: "Azero" },
  { code: "kk", native: "Қазақ тілі", en: "Kazakh", it: "Kazako" },
  { code: "uz", native: "Oʻzbekcha", en: "Uzbek", it: "Uzbeco" },
  { code: "ca", native: "Català", en: "Catalan", it: "Catalano" },
  { code: "gl", native: "Galego", en: "Galician", it: "Galiziano" },
  { code: "eu", native: "Euskara", en: "Basque", it: "Basco" },
  { code: "ga", native: "Gaeilge", en: "Irish", it: "Irlandese" },
  { code: "cy", native: "Cymraeg", en: "Welsh", it: "Gallese" },
  { code: "id", native: "Bahasa Indonesia", en: "Indonesian", it: "Indonesiano" },
  { code: "ms", native: "Bahasa Melayu", en: "Malay", it: "Malese" },
  { code: "vi", native: "Tiếng Việt", en: "Vietnamese", it: "Vietnamita" },
  { code: "th", native: "ไทย", en: "Thai", it: "Thailandese" },
  { code: "fil", native: "Filipino", en: "Filipino", it: "Filippino" },
  { code: "my", native: "မြန်မာ", en: "Burmese", it: "Birmano" },
  { code: "km", native: "ខ្មែរ", en: "Khmer", it: "Khmer" },
  { code: "ta", native: "தமிழ்", en: "Tamil", it: "Tamil" },
  { code: "te", native: "తెలుగు", en: "Telugu", it: "Telugu" },
  { code: "mr", native: "मराठी", en: "Marathi", it: "Marathi" },
  { code: "gu", native: "ગુજરાતી", en: "Gujarati", it: "Gujarati" },
  { code: "kn", native: "ಕನ್ನಡ", en: "Kannada", it: "Kannada" },
  { code: "ml", native: "മലയാളം", en: "Malayalam", it: "Malayalam" },
  { code: "pa", native: "ਪੰਜਾਬੀ", en: "Punjabi", it: "Punjabi" },
  { code: "ne", native: "नेपाली", en: "Nepali", it: "Nepalese" },
  { code: "si", native: "සිංහල", en: "Sinhala", it: "Singalese" },
  { code: "ps", native: "پښتو", en: "Pashto", it: "Pashto" },
  { code: "sw", native: "Kiswahili", en: "Swahili", it: "Swahili" },
  { code: "am", native: "አማርኛ", en: "Amharic", it: "Amarico" },
  { code: "ha", native: "Hausa", en: "Hausa", it: "Hausa" },
  { code: "yo", native: "Yorùbá", en: "Yoruba", it: "Yoruba" },
  { code: "zu", native: "isiZulu", en: "Zulu", it: "Zulu" },
  { code: "af", native: "Afrikaans", en: "Afrikaans", it: "Afrikaans" },
];

const BY_CODE = new Map(AGENT_LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** The language with that code (case does not matter), or undefined. */
export function agentLanguage(code: string | null | undefined): AgentLanguage | undefined {
  return code ? BY_CODE.get(code.toLowerCase()) : undefined;
}

/**
 * The language automatic texts (Telegram, the gateways, alerts) are written in: the agents' own
 * when the interface has it translated ("it", "en", "en-…"), otherwise the interface's.
 */
export function textLanguage(agents: string | null | undefined, ui: UiLanguage): UiLanguage {
  const base = agents?.split("-")[0]?.toLowerCase();
  return base === "it" || base === "en" ? base : ui;
}

/**
 * The line every agent's instructions end with (in English, as all instructions): reply to the
 * person in that language. Empty for an unknown code.
 */
export function replyLanguageLine(code: string | null | undefined): string {
  const l = agentLanguage(code);
  return l
    ? `## Language\nReply to the person in ${l.en} (${l.native}), whatever language these instructions are written in, unless they ask you for another.`
    : "";
}
