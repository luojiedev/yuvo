import assert from "node:assert/strict";
import test from "node:test";
import {
  maxImageSizeBytes,
  validateImageCandidates,
} from "../lib/image-attachments.ts";

test("accepts up to three local image attachments", () => {
  assert.equal(validateImageCandidates([], [
    { type: "image/jpeg", size: 1024 },
    { type: "image/png", size: 2048 },
    { type: "image/heic", size: 4096 },
  ]), null);
});

const unsupportedMessage = "仅支持 JPEG、PNG、WebP、GIF、HEIC、HEIF 或 AVIF 图片";

test("rejects image formats the attachment API cannot store", () => {
  for (const type of ["image/bmp", "image/tiff", "image/svg+xml", "image/x-icon"]) {
    assert.equal(validateImageCandidates([], [{ type, size: 1024 }]), unsupportedMessage, type);
  }
  assert.equal(validateImageCandidates([], [{ type: "IMAGE/JPEG", size: 1024 }]), null);
});

test("rejects non-images, oversized files, and more than three images", () => {
  assert.equal(validateImageCandidates([], [{ type: "application/pdf", size: 1024 }]), unsupportedMessage);
  assert.equal(validateImageCandidates([], [{ type: "image/jpeg", size: maxImageSizeBytes + 1 }]), "请选择单张不超过 12MB 的图片");
  assert.equal(validateImageCandidates([{ type: "image/jpeg", size: 1 }], [
    { type: "image/jpeg", size: 1 },
    { type: "image/jpeg", size: 1 },
    { type: "image/jpeg", size: 1 },
  ]), "每笔账单最多添加 3 张图片");
});
