import type { ImagePart } from "@redgiant/protocol";

/** The photos sent with a message: thumbnails that open full size in a new tab. */
export function Images({ images }: { images: readonly ImagePart[] }) {
  if (images.length === 0) return null;
  return (
    <div class="msg-images">
      {images.map((im, i) => {
        const src = `data:${im.mediaType};base64,${im.data}`;
        return (
          <a key={`${i}:${im.name ?? ""}`} href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={im.name ?? ""} loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}
