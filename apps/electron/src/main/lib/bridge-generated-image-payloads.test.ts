import { describe, expect, test } from 'bun:test'
import {
  buildDingTalkGeneratedImagePayload,
  buildFeishuGeneratedImagePayload,
  buildWeChatGeneratedImageItem,
} from './bridge-generated-image-payloads'

describe('bridge-generated-image-payloads', () => {
  test('构造微信 IMAGE 消息项', () => {
    expect(buildWeChatGeneratedImageItem('encrypted-param', 'aes-key', 1234)).toEqual({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'encrypted-param',
          aes_key: 'aes-key',
          encrypt_type: 1,
        },
        mid_size: 1234,
      },
    })
  })

  test('构造钉钉 mediaId markdown 图片消息', () => {
    expect(buildDingTalkGeneratedImagePayload('media-id', 'result.png')).toEqual({
      msgtype: 'markdown',
      markdown: {
        title: 'result.png',
        text: '![result.png](media-id)',
      },
    })
  })

  test('构造飞书 image_key 消息', () => {
    expect(buildFeishuGeneratedImagePayload('img-key')).toEqual({
      content: '{"image_key":"img-key"}',
      msg_type: 'image',
    })
  })
})
