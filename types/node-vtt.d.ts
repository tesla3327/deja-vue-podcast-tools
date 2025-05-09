declare module 'node-vtt' {
  interface Caption {
    start: number
    end: number
    text: string
  }

  interface ParsedVTT {
    captions: Caption[]
  }

  export function parse(content: string): ParsedVTT
}
