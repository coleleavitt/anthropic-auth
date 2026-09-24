export interface SurrogateModel {
  version: number
  featurizer: {
    window: number
    dim: number
    ngram: [number, number]
    hash: string
    topK: number
  }
  threshold: number
  bias: number
  weights: number[]
  meta?: Record<string, unknown>
}
