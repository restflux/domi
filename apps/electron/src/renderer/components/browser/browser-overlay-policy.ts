export interface RectangleEdges {
  left: number
  right: number
  top: number
  bottom: number
}

export function rectanglesOverlap(first: RectangleEdges, second: RectangleEdges): boolean {
  return second.left < first.right
    && second.right > first.left
    && second.top < first.bottom
    && second.bottom > first.top
}
