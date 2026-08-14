export const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function validateImage(file: Pick<File, "type" | "size">): string | null {
  if (!SUPPORTED_TYPES.includes(file.type)) return "Choose a PNG, JPEG, or WebP image.";
  if (file.size > MAX_IMAGE_BYTES) return "The image must be 20 MB or smaller.";
  if (file.size === 0) return "The selected image is empty.";
  return null;
}

export function fileAsDataUrl(file: Blob): Promise<string> {
  const read = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
  if (file.size <= 9.5 * 1024 * 1024) return read(file);
  return createImageBitmap(file).then(async (bitmap) => {
    const maxSide = Math.max(bitmap.width, bitmap.height);
    const initialScale = Math.min(1, 4096 / maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * initialScale));
    canvas.height = Math.max(1, Math.round(bitmap.height * initialScale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image could not be prepared for 3D generation.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.92, 0.82, 0.72, 0.62, 0.52]) {
      const result = canvas.toDataURL("image/webp", quality);
      if (result.length * 0.75 <= 9.5 * 1024 * 1024) return result;
    }
    throw new Error("The image could not be compressed below the provider upload limit. Try a smaller image.");
  });
}
