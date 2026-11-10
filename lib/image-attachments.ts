export const maxImagesPerTransaction = 3;
export const maxImageSizeBytes = 12 * 1024 * 1024;
export const maxTransactionImagesSizeBytes = 25 * 1024 * 1024;

// 服务端 /attachments 接口只接收这些类型，客户端必须在选择阶段就拦截其余格式。
export const supportedImageTypes: ReadonlySet<string> = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ImageCandidate {
  type: string;
  size: number;
}

export function validateImageCandidates(existing: ImageCandidate[], candidates: ImageCandidate[]): string | null {
  if (existing.length + candidates.length > maxImagesPerTransaction) return "每笔账单最多添加 3 张图片";
  if (candidates.some((file) => !supportedImageTypes.has(file.type.toLowerCase()))) {
    return "仅支持 JPEG、PNG、WebP、GIF、HEIC、HEIF 或 AVIF 图片";
  }
  if (candidates.some((file) => file.size > maxImageSizeBytes)) {
    return "请选择单张不超过 12MB 的图片";
  }
  if ([...existing, ...candidates].reduce((total, file) => total + file.size, 0) > maxTransactionImagesSizeBytes) {
    return "本笔账单的图片总大小不能超过 25MB";
  }
  return null;
}
