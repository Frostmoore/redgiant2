/**
 * Making pictures, videos and sounds (G25.3): three tools every agent has (image_generation,
 * video_generation, audio_generation), each done by the provider and model the person chose
 * among those able to, with that provider's key. Audio is three things: speech, music, sound
 * effects, each with its own choice.
 */
export const MEDIA_KINDS = ["image", "video", "speech", "music", "sound"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaModel {
  id: string;
  /** How people call it. */
  label: string;
}

export interface MediaProvider {
  id: string;
  /** The brand, the same in every language. */
  name: string;
  /** Where the key is made. */
  keyUrl: string;
  /** How a key starts, shown as an example. */
  keyExample: string;
  /** A chat provider whose key works here too (an OpenAI key is the same everywhere). */
  sharesKeyWith?: string;
  /** What it can make, newest models first. */
  models: Partial<Record<MediaKind, readonly MediaModel[]>>;
  /** Voices for speech, the first one the default. */
  voices?: readonly { id: string; label: string }[];
}

/** What the person chose for one kind. */
export interface MediaChoice {
  provider: string;
  model: string;
  /** Speech: the voice. */
  voice?: string;
}

const OPENAI_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
].map((v) => ({ id: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));

const GEMINI_VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Zephyr",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
].map((v) => ({ id: v, label: v }));

/**
 * Who makes what, checked against each provider's documentation on 2026-11-02. OpenAI's Sora
 * (video) closed on 2026-09-24; its voices close on 2027-01-06. Google's Imagen and Veo gave way
 * to Nano Banana and Gemini Omni. ElevenLabs' voices are read from the account, with the key.
 */
export const MEDIA_PROVIDERS: readonly MediaProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyExample: "sk-proj-…",
    sharesKeyWith: "openai",
    models: {
      image: [
        { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare" },
        { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst" },
        { id: "gpt-image-2", label: "GPT Image 2" },
      ],
      speech: [{ id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS (closes 2027-01-06)" }],
    },
    voices: OPENAI_VOICES,
  },
  {
    id: "google",
    name: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyExample: "AIza…",
    sharesKeyWith: "gemini",
    models: {
      image: [
        { id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1" },
        { id: "gemini-3-pro-image", label: "Gemini 3 Pro Image" },
        { id: "gemini-3.1-flash-lite-image", label: "Gemini 3.1 Flash Lite Image" },
      ],
      video: [{ id: "gemini-omni-1.1-flash", label: "Gemini Omni 1.1 Flash" }],
      speech: [
        { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS" },
        { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash Lite TTS" },
      ],
      music: [
        { id: "lyria-3.5", label: "Lyria 3.5" },
        { id: "lyria-3-clip-preview", label: "Lyria 3 Clip (30 s)" },
      ],
    },
    voices: GEMINI_VOICES,
  },
  {
    id: "xai",
    name: "xAI Grok",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    keyExample: "xai-…",
    sharesKeyWith: "xai",
    models: {
      image: [{ id: "grok-imagine-image-2.0", label: "Grok Imagine Image 2.0" }],
      video: [
        { id: "grok-imagine-video-1.5", label: "Grok Imagine Video 1.5" },
        { id: "grok-imagine-video-1.5-lite", label: "Grok Imagine Video 1.5 Lite" },
      ],
    },
  },
  {
    id: "bfl",
    name: "Black Forest Labs (FLUX)",
    keyUrl: "https://dashboard.bfl.ai",
    keyExample: "bfl_…",
    models: {
      image: [
        { id: "flux-2-pro", label: "FLUX.2 [pro]" },
        { id: "flux-2-max", label: "FLUX.2 [max]" },
        { id: "flux-2-flex", label: "FLUX.2 [flex]" },
        { id: "flux-2-klein-9b", label: "FLUX.2 [klein] 9B" },
      ],
    },
  },
  {
    id: "runway",
    name: "Runway",
    keyUrl: "https://dev.runway.com",
    keyExample: "key_…",
    models: {
      video: [
        { id: "gen4.5", label: "Gen-4.5" },
        { id: "veo3.1", label: "Veo 3.1 (through Runway)" },
        { id: "veo3.1_fast", label: "Veo 3.1 Fast (through Runway)" },
      ],
    },
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyExample: "sk_…",
    models: {
      speech: [
        { id: "eleven_v3", label: "Eleven v3" },
        { id: "eleven_multilingual_v2", label: "Eleven Multilingual v2" },
        { id: "eleven_flash_v2_5", label: "Eleven Flash v2.5" },
      ],
      music: [
        { id: "music_v2_5", label: "Eleven Music v2.5" },
        { id: "music_v2", label: "Eleven Music v2" },
      ],
      sound: [{ id: "eleven_text_to_sound_v3", label: "Sound Effects v3" }],
    },
  },
];

export const mediaProvider = (id: string) => MEDIA_PROVIDERS.find((p) => p.id === id);
