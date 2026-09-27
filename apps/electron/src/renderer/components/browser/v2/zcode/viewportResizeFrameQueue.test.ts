import { expect, test } from 'bun:test'
import { createViewportResizeFrameQueue } from './viewportResizeFrameQueue.ts'

test('Given many ZCode-style viewport drag events in one frame When committing Then Domi Main view receives only the latest size', () => {
  const observed: Array<{ width: number; height: number }> = []
  const frames = new Map<number, () => void>()
  let nextFrame = 0
  const queue = createViewportResizeFrameQueue((size) => observed.push(size), (callback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  }, (id) => { frames.delete(id) })
  for (let width = 391; width <= 1390; width += 1) queue.schedule({ width, height: 844 })
  expect(frames.size).toBe(1)
  expect(observed).toHaveLength(0)
  const scheduled = frames.get(nextFrame)
  frames.delete(nextFrame) // requestAnimationFrame 执行后由浏览器消费该任务。
  scheduled?.()
  expect(observed).toEqual([{ width: 1390, height: 844 }])
  queue.schedule({ width: 1391, height: 844 })
  queue.flush()
  expect(observed.at(-1)).toEqual({ width: 1391, height: 844 })
  expect(frames.size).toBe(0)
})

test('Given responsive view unmounts during a drag When cleaning up Then no stale Main layout update is published', () => {
  let publishCount = 0
  const frames = new Map<number, () => void>()
  const queue = createViewportResizeFrameQueue(() => { publishCount += 1 }, (callback) => { frames.set(1, callback); return 1 }, () => undefined)
  queue.schedule({ width: 400, height: 800 })
  queue.dispose()
  frames.get(1)?.()
  expect(publishCount).toBe(0)
})
