import { describe, expect, test } from 'bun:test'
import { createDeltaBatchCoalescer } from './pi-streaming-control'

describe('Pi delta batch coalescer', () => {
  test('preserves every ordered delta in one flush and stops after dispose', () => {
    const emitted: string[][] = []
    const coalescer = createDeltaBatchCoalescer<string>((values) => emitted.push(values), 50)

    coalescer.schedule('first')
    coalescer.schedule('second')
    coalescer.schedule('third')
    coalescer.flush()
    expect(emitted).toEqual([['first', 'second', 'third']])

    coalescer.schedule('discarded')
    coalescer.dispose()
    coalescer.flush()
    expect(emitted).toEqual([['first', 'second', 'third']])
  })
})
