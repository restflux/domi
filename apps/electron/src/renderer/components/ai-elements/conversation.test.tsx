import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation, ConversationContent } from './conversation'

describe('Conversation scrollbar visibility', () => {
  test('Given a conversation When rendered Then the native scrollbar stays hidden', () => {
    const html = renderToStaticMarkup(
      <Conversation>
        <ConversationContent>消息</ConversationContent>
      </Conversation>,
    )

    expect(html).toContain('scrollbar-none')
    expect(html).not.toContain('scrollbar-transient')
  })
})
