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
  /**
   * How to say «you» to one person informally, as RedGiant's pages do (p3.5.3: God used the
   * Italian «voi»), for languages that tell a familiar form from a plural or formal one.
   */
  address?: string;
}

/** The interface's languages: the only ones the pages, Telegram and the gateways are written in. */
export type UiLanguage = "it" | "en";

export const AGENT_LANGUAGES: readonly AgentLanguage[] = [
  // The most common first, in this order.
  { code: "it", native: "Italiano", en: "Italian", it: "Italiano", common: true, address: "tu" },
  { code: "en", native: "English", en: "English", it: "Inglese", common: true },
  { code: "es", native: "Español", en: "Spanish", it: "Spagnolo", common: true, address: "tú" },
  { code: "fr", native: "Français", en: "French", it: "Francese", common: true, address: "tu" },
  { code: "de", native: "Deutsch", en: "German", it: "Tedesco", common: true, address: "du" },
  {
    code: "pt-BR",
    native: "Português (Brasil)",
    en: "Portuguese (Brazil)",
    it: "Portoghese (Brasile)",
    common: true,
    address: "você",
  },
  {
    code: "zh-Hans",
    native: "中文（简体）",
    en: "Chinese (Simplified)",
    it: "Cinese (semplificato)",
    common: true,
    address: "你",
  },
  { code: "hi", native: "हिन्दी", en: "Hindi", it: "Hindi", common: true, address: "तुम" },
  { code: "ar", native: "العربية", en: "Arabic", it: "Arabo", common: true },
  { code: "ru", native: "Русский", en: "Russian", it: "Russo", common: true, address: "ты" },
  { code: "ja", native: "日本語", en: "Japanese", it: "Giapponese", common: true },
  // Then all the others.
  {
    code: "pt-PT",
    native: "Português (Portugal)",
    en: "Portuguese (Portugal)",
    it: "Portoghese (Portogallo)",
    address: "tu",
  },
  {
    code: "zh-Hant",
    native: "中文（繁體）",
    en: "Chinese (Traditional)",
    it: "Cinese (tradizionale)",
    address: "你",
  },
  { code: "ko", native: "한국어", en: "Korean", it: "Coreano" },
  { code: "bn", native: "বাংলা", en: "Bengali", it: "Bengalese", address: "তুমি" },
  { code: "ur", native: "اردو", en: "Urdu", it: "Urdu", address: "تم" },
  { code: "fa", native: "فارسی", en: "Persian", it: "Persiano", address: "تو" },
  { code: "tr", native: "Türkçe", en: "Turkish", it: "Turco", address: "sen" },
  { code: "nl", native: "Nederlands", en: "Dutch", it: "Olandese", address: "je" },
  { code: "pl", native: "Polski", en: "Polish", it: "Polacco", address: "ty" },
  { code: "uk", native: "Українська", en: "Ukrainian", it: "Ucraino", address: "ти" },
  { code: "sv", native: "Svenska", en: "Swedish", it: "Svedese", address: "du" },
  {
    code: "nb",
    native: "Norsk (bokmål)",
    en: "Norwegian (Bokmål)",
    it: "Norvegese (bokmål)",
    address: "du",
  },
  { code: "da", native: "Dansk", en: "Danish", it: "Danese", address: "du" },
  { code: "fi", native: "Suomi", en: "Finnish", it: "Finlandese", address: "sinä" },
  { code: "is", native: "Íslenska", en: "Icelandic", it: "Islandese", address: "þú" },
  { code: "el", native: "Ελληνικά", en: "Greek", it: "Greco", address: "εσύ" },
  { code: "he", native: "עברית", en: "Hebrew", it: "Ebraico" },
  { code: "cs", native: "Čeština", en: "Czech", it: "Ceco", address: "ty" },
  { code: "sk", native: "Slovenčina", en: "Slovak", it: "Slovacco", address: "ty" },
  { code: "hu", native: "Magyar", en: "Hungarian", it: "Ungherese", address: "te" },
  { code: "ro", native: "Română", en: "Romanian", it: "Rumeno", address: "tu" },
  { code: "bg", native: "Български", en: "Bulgarian", it: "Bulgaro", address: "ти" },
  { code: "hr", native: "Hrvatski", en: "Croatian", it: "Croato", address: "ti" },
  { code: "sr", native: "Srpski", en: "Serbian", it: "Serbo", address: "ti" },
  { code: "bs", native: "Bosanski", en: "Bosnian", it: "Bosniaco", address: "ti" },
  { code: "sl", native: "Slovenščina", en: "Slovenian", it: "Sloveno", address: "ti" },
  { code: "mk", native: "Македонски", en: "Macedonian", it: "Macedone", address: "ти" },
  { code: "sq", native: "Shqip", en: "Albanian", it: "Albanese", address: "ti" },
  { code: "lt", native: "Lietuvių", en: "Lithuanian", it: "Lituano", address: "tu" },
  { code: "lv", native: "Latviešu", en: "Latvian", it: "Lettone", address: "tu" },
  { code: "et", native: "Eesti", en: "Estonian", it: "Estone", address: "sina" },
  { code: "be", native: "Беларуская", en: "Belarusian", it: "Bielorusso", address: "ты" },
  { code: "ka", native: "ქართული", en: "Georgian", it: "Georgiano", address: "შენ" },
  { code: "hy", native: "Հայերեն", en: "Armenian", it: "Armeno", address: "դու" },
  { code: "az", native: "Azərbaycanca", en: "Azerbaijani", it: "Azero", address: "sən" },
  { code: "kk", native: "Қазақ тілі", en: "Kazakh", it: "Kazako", address: "сен" },
  { code: "uz", native: "Oʻzbekcha", en: "Uzbek", it: "Uzbeco", address: "sen" },
  { code: "ca", native: "Català", en: "Catalan", it: "Catalano", address: "tu" },
  { code: "gl", native: "Galego", en: "Galician", it: "Galiziano", address: "ti" },
  { code: "eu", native: "Euskara", en: "Basque", it: "Basco" },
  { code: "ga", native: "Gaeilge", en: "Irish", it: "Irlandese" },
  { code: "cy", native: "Cymraeg", en: "Welsh", it: "Gallese", address: "ti" },
  { code: "id", native: "Bahasa Indonesia", en: "Indonesian", it: "Indonesiano", address: "kamu" },
  { code: "ms", native: "Bahasa Melayu", en: "Malay", it: "Malese" },
  { code: "vi", native: "Tiếng Việt", en: "Vietnamese", it: "Vietnamita" },
  { code: "th", native: "ไทย", en: "Thai", it: "Thailandese" },
  { code: "fil", native: "Filipino", en: "Filipino", it: "Filippino" },
  { code: "my", native: "မြန်မာ", en: "Burmese", it: "Birmano" },
  { code: "km", native: "ខ្មែរ", en: "Khmer", it: "Khmer" },
  { code: "ta", native: "தமிழ்", en: "Tamil", it: "Tamil" },
  { code: "te", native: "తెలుగు", en: "Telugu", it: "Telugu" },
  { code: "mr", native: "मराठी", en: "Marathi", it: "Marathi", address: "तू" },
  { code: "gu", native: "ગુજરાતી", en: "Gujarati", it: "Gujarati", address: "તું" },
  { code: "kn", native: "ಕನ್ನಡ", en: "Kannada", it: "Kannada" },
  { code: "ml", native: "മലയാളം", en: "Malayalam", it: "Malayalam" },
  { code: "pa", native: "ਪੰਜਾਬੀ", en: "Punjabi", it: "Punjabi", address: "ਤੂੰ" },
  { code: "ne", native: "नेपाली", en: "Nepali", it: "Nepalese", address: "तिमी" },
  { code: "si", native: "සිංහල", en: "Sinhala", it: "Singalese" },
  { code: "ps", native: "پښتو", en: "Pashto", it: "Pashto" },
  { code: "sw", native: "Kiswahili", en: "Swahili", it: "Swahili" },
  { code: "am", native: "አማርኛ", en: "Amharic", it: "Amarico" },
  { code: "ha", native: "Hausa", en: "Hausa", it: "Hausa" },
  { code: "yo", native: "Yorùbá", en: "Yoruba", it: "Yoruba" },
  { code: "zu", native: "isiZulu", en: "Zulu", it: "Zulu" },
  { code: "af", native: "Afrikaans", en: "Afrikaans", it: "Afrikaans", address: "jy" },
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
 * person in that language and, where the language has more than one, with its familiar «you».
 * Empty for an unknown code. Part of the fixed prompt: new conversations only.
 */
export function replyLanguageLine(code: string | null | undefined): string {
  const l = agentLanguage(code);
  if (!l) return "";
  const line = `## Language\nReply to the person in ${l.en} (${l.native}), whatever language these instructions are written in, unless they ask you for another.`;
  return l.address
    ? `${line} Speak to them as one person, informally, as RedGiant's pages do: «${l.address}», never a plural or formal form of address.`
    : line;
}
