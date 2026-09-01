import type { WeChatMessageItem } from '@domi/shared'

export function buildWeChatGeneratedImageItem(
  encryptQueryParam: string,
  aesKey: string,
  encryptedFileSize: number,
): WeChatMessageItem {
  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: encryptQueryParam,
        aes_key: aesKey,
        encrypt_type: 1,
      },
      mid_size: encryptedFileSize,
    },
  }
}

export function buildDingTalkGeneratedImagePayload(mediaId: string, filename: string): Record<string, unknown> {
  const label = filename || '生成图片'
  return {
    msgtype: 'markdown',
    markdown: {
      title: label,
      text: `![${label}](${mediaId})`,
    },
  }
}

export function buildFeishuGeneratedImagePayload(imageKey: string): {
  content: string
  msg_type: 'image'
} {
  return {
    content: JSON.stringify({ image_key: imageKey }),
    msg_type: 'image',
  }
}
