import { ofetch } from 'ofetch'
import 'dotenv/config'
import {
  processFiles,
  ContentProcessor,
} from './scripts/fileUtils'
import ffmpeg from 'fluent-ffmpeg'
import { join } from 'path'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'

// Default directories
const DEFAULT_INPUT_DIR = 'audio'
const DEFAULT_OUTPUT_DIR = 'transcripts'

// Supported audio extensions
const AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac',
]

// Output formats
const OUTPUT_EXTENSIONS = {
  vtt: '.vtt',
  json: '.json',
}

// Default system prompt
const DEFAULT_SYSTEM_PROMPT =
  'This is a transcript about Vue.js and Nuxt.js, not Next.js. The content may include technical terms related to Vue, Nuxt, JavaScript, and web development.'

// Constants for audio processing
const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB in bytes
const SEGMENT_DURATION = 10 * 60 * 1000 // 10 minutes in milliseconds
const SEGMENT_OVERLAP = 20 * 1000 // 10 seconds in milliseconds

interface Word {
  word: string
  start: number
  end: number
}

interface TranscriptionResponse {
  text: string
  words: Word[]
  segments: {
    id: number
    start: number
    end: number
    text: string
  }[]
}

async function splitAudioFile(
  audioBuffer: Buffer
): Promise<string[]> {
  const tempDir = join(tmpdir(), 'audio-segments')
  await mkdir(tempDir, { recursive: true })

  const inputPath = join(tempDir, 'input.mp3')
  const outputPath = join(tempDir, 'segment-%d.mp3')

  // Write the input buffer to a temporary file
  await writeFile(inputPath, audioBuffer)

  return new Promise((resolve, reject) => {
    const segments: string[] = []
    let segmentIndex = 0
    let currentTime = 0

    // First, get the total duration of the audio file
    ffmpeg.ffprobe(inputPath, async (err, metadata) => {
      if (err) {
        await rm(inputPath, { force: true })
        reject(err)
        return
      }

      const duration = metadata.format.duration || 0

      // Create segments with overlap
      while (currentTime < duration) {
        const segmentPath = outputPath.replace(
          '%d',
          segmentIndex.toString()
        )
        segments.push(segmentPath)

        // Calculate start time with overlap
        const startTime = Math.max(
          0,
          currentTime - SEGMENT_OVERLAP / 1000
        )

        // Create the segment
        await new Promise<void>(
          (resolveSegment, rejectSegment) => {
            ffmpeg(inputPath)
              .setStartTime(startTime)
              .setDuration(SEGMENT_DURATION / 1000)
              .output(segmentPath)
              .on('end', () => resolveSegment())
              .on('error', (err) => rejectSegment(err))
              .run()
          }
        )

        currentTime += SEGMENT_DURATION / 1000
        segmentIndex++
      }

      // Clean up the input file
      await rm(inputPath)
      resolve(segments)
    })
  })
}

async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
  model: string = 'whisper-1',
  language: string = 'en',
  format: 'vtt' | 'json' = 'vtt',
  prompt: string = DEFAULT_SYSTEM_PROMPT
): Promise<string> {
  // If file is small enough, process it directly
  if (audioBuffer.length <= MAX_FILE_SIZE) {
    return await transcribeAudioSegment(
      audioBuffer,
      apiKey,
      model,
      language,
      format,
      prompt
    )
  }

  // Split the audio file into segments
  console.log('Splitting large audio file into segments...')
  const segments = await splitAudioFile(audioBuffer)

  // Transcribe each segment
  const transcriptions: string[] = []
  let previousTranscription = ''

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const segmentBuffer = await readFile(segment)

    // For subsequent segments, append part of the previous transcription to help with context
    let segmentPrompt = prompt
    if (i > 0 && previousTranscription) {
      // Get the last portion of the previous transcription to provide context
      const previousText =
        format === 'json'
          ? JSON.parse(previousTranscription).text
          : extractTextFromVTT(previousTranscription)

      // Only use the last part of the text to stay within token limits
      const contextText = previousText
        .split(' ')
        .slice(-50)
        .join(' ')
      segmentPrompt = `${prompt} Previous context: ${contextText}`
    }

    const transcription = await transcribeAudioSegment(
      segmentBuffer,
      apiKey,
      model,
      language,
      format,
      segmentPrompt
    )

    previousTranscription = transcription
    transcriptions.push(transcription)
  }

  // Combine transcriptions
  if (format === 'vtt') {
    return combineVTTTranscriptions(transcriptions)
  } else {
    return combineJSONTranscriptions(transcriptions)
  }
}

// Helper to extract text from VTT format
function extractTextFromVTT(vtt: string): string {
  const lines = vtt.split('\n')
  let text = ''

  for (let i = 0; i < lines.length; i++) {
    // Skip headers, timestamps, and empty lines
    if (
      !lines[i].includes('-->') &&
      !lines[i].match(/^WEBVTT/) &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^\d\d:/)
    ) {
      text += ' ' + lines[i].trim()
    }
  }

  return text.trim()
}

async function transcribeAudioSegment(
  audioBuffer: Buffer,
  apiKey: string,
  model: string,
  language: string,
  format: 'vtt' | 'json',
  prompt: string
): Promise<string> {
  const formData = new FormData()
  formData.append(
    'file',
    new Blob([audioBuffer], { type: 'audio/mpeg' }),
    'audio.mp3'
  )
  formData.append('model', model)
  formData.append('language', language)

  // Add prompt if provided
  if (prompt) {
    formData.append('prompt', prompt)
  }

  if (format === 'vtt') {
    formData.append('response_format', 'vtt')
  } else {
    formData.append('response_format', 'verbose_json')
    formData.append('timestamp_granularities[]', 'word')
  }

  try {
    console.log(
      `Transcribing audio segment (${(
        audioBuffer.length /
        1024 /
        1024
      ).toFixed(2)}MB)...`
    )

    if (format === 'vtt') {
      const response = await ofetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        }
      )
      return response
    } else {
      const response = await ofetch<TranscriptionResponse>(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: formData,
        }
      )
      return JSON.stringify(response, null, 2)
    }
  } catch (error: any) {
    console.error('Transcription error details:', {
      status: error.status,
      statusText: error.statusText,
      data: error.data,
      message: error.message,
    })

    if (error.status === 400) {
      throw new Error(
        `Bad Request: ${
          error.data?.error?.message || error.message
        }`
      )
    } else if (error.status === 401) {
      throw new Error(
        'Authentication failed. Please check your API key.'
      )
    } else if (error.status === 429) {
      throw new Error(
        'Rate limit exceeded. Please try again later.'
      )
    } else {
      throw new Error(
        `Transcription failed: ${error.message}`
      )
    }
  }
}

function parseVTTTimestamp(timestamp: string): number {
  const [hours, minutes, seconds] = timestamp
    .split(':')
    .map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

function formatVTTTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${remainingSeconds
    .toFixed(3)
    .padStart(6, '0')}`
}

function combineVTTTranscriptions(
  transcriptions: string[]
): string {
  let combined = ''
  let timeOffset = 0

  for (let i = 0; i < transcriptions.length; i++) {
    const transcription = transcriptions[i]
    const lines = transcription.split('\n')

    // Keep the WEBVTT header only for the first segment
    if (i === 0) {
      combined += lines[0] + '\n\n'
      lines.shift() // Remove WEBVTT header
      lines.shift() // Remove empty line after header
    }

    // Process each cue
    let currentCue = ''
    for (const line of lines) {
      if (line.trim() === '') {
        if (currentCue) {
          // Parse and adjust timestamps in the cue
          const timestampMatch = currentCue.match(
            /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/
          )
          if (timestampMatch) {
            const startTime =
              parseVTTTimestamp(timestampMatch[1]) +
              timeOffset
            const endTime =
              parseVTTTimestamp(timestampMatch[2]) +
              timeOffset

            // Only include the cue if it's not in the overlap region (except for the first segment)
            if (
              i === 0 ||
              startTime >=
                timeOffset + SEGMENT_OVERLAP / 1000
            ) {
              const adjustedCue = currentCue.replace(
                timestampMatch[0],
                `${formatVTTTimestamp(
                  startTime
                )} --> ${formatVTTTimestamp(endTime)}`
              )
              combined += adjustedCue.trim() + '\n\n'
            }
          }
          currentCue = ''
        }
      } else {
        currentCue += line + '\n'
      }
    }

    // Update time offset for next segment
    timeOffset +=
      SEGMENT_DURATION / 1000 - SEGMENT_OVERLAP / 1000
  }

  return combined.trim()
}

function combineJSONTranscriptions(
  transcriptions: string[]
): string {
  const combined: TranscriptionResponse = {
    text: '',
    words: [],
    segments: [],
  }

  let timeOffset = 0
  for (const transcription of transcriptions) {
    const data = JSON.parse(
      transcription
    ) as TranscriptionResponse

    // Combine text
    combined.text += data.text + ' '

    // Combine words with adjusted timestamps
    combined.words.push(
      ...data.words.map((word) => ({
        ...word,
        start: word.start + timeOffset,
        end: word.end + timeOffset,
      }))
    )

    // Combine segments with adjusted timestamps
    combined.segments.push(
      ...data.segments.map((segment) => ({
        ...segment,
        start: segment.start + timeOffset,
        end: segment.end + timeOffset,
      }))
    )

    // Update time offset for next segment
    timeOffset = data.segments[data.segments.length - 1].end
  }

  return JSON.stringify(combined, null, 2)
}

async function main() {
  const args = process.argv.slice(2)
  const [
    inputDir = DEFAULT_INPUT_DIR,
    outputDir = DEFAULT_OUTPUT_DIR,
    model = 'whisper-1',
    language = 'en',
    format = 'vtt',
    prompt = DEFAULT_SYSTEM_PROMPT,
  ] = args

  // Validate format
  if (format !== 'vtt' && format !== 'json') {
    console.error(
      'Error: format must be either "vtt" or "json"'
    )
    process.exit(1)
  }

  // Get API key from environment variable
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(
      'Error: OPENAI_API_KEY environment variable is not set'
    )
    process.exit(1)
  }

  console.log(`Using system prompt: "${prompt}"`)

  const audioProcessor: ContentProcessor<string> = {
    process: async (content, metadata) => {
      return await transcribeAudio(
        content as Buffer,
        apiKey,
        model,
        language,
        format as 'vtt' | 'json',
        prompt
      )
    },
  }

  try {
    await processFiles<string>(inputDir, {
      outputDir,
      processor: audioProcessor,
      fileFilter: AUDIO_EXTENSIONS,
      readAsBuffer: true,
      recursive: true,
      outputExtension:
        OUTPUT_EXTENSIONS[
          format as keyof typeof OUTPUT_EXTENSIONS
        ],
    })
    console.log('Transcription completed successfully!')
  } catch (error) {
    console.error('Error during transcription:', error)
    process.exit(1)
  }
}

main()
