import 'dotenv/config'
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  access,
} from 'fs/promises'
import { join, dirname } from 'path'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  processFiles,
  ContentProcessor,
} from './scripts/fileUtils'

const execAsync = promisify(exec)

interface Transcript {
  filename: string
  content: string
}

interface ProcessedTranscript {
  title: string
  description: string
  duration: number
}

// Default directories
const DEFAULT_INPUT_DIR = 'transcripts'
const DEFAULT_VIDEOS_DIR = 'videos'
const DEFAULT_OUTPUT_DIR = 'processed-transcripts'

async function getVideoDuration(
  videoPath: string
): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    )
    return parseFloat(stdout.trim())
  } catch (error) {
    console.error(
      `Error getting duration for ${videoPath}:`,
      error
    )
    return 0
  }
}

async function readVttFile(
  filepath: string
): Promise<string> {
  const content = await readFile(filepath, 'utf-8')
  return content
}

async function editResponse(
  processed: ProcessedTranscript
): Promise<ProcessedTranscript> {
  const prompt = `Edit to remove the following words from the title and description (including variations):
- ensure
- essential
- enhance
- utilize

Also, replace "Nuxt 3" with "Nuxt".

Input:
${JSON.stringify(processed, null, 2)}

Output should be in the same JSON format, with the same structure but with these words replaced.`

  const { text } = await generateText({
    model: openai.responses('gpt-4.1'),
    prompt,
  })

  // Extract JSON from the response if it's wrapped in code blocks
  const jsonMatch = text.match(
    /```(?:json)?\s*(\[[\s\S]*?\]|{[\s\S]*?})\s*```/
  )
  const jsonString = jsonMatch ? jsonMatch[1] : text

  try {
    const cleaned = JSON.parse(jsonString)
    // Handle both array and single object responses
    if (Array.isArray(cleaned)) {
      if (cleaned.length !== 1) {
        throw new Error(
          'Expected a single transcript result'
        )
      }
      return cleaned[0]
    }
    return cleaned
  } catch (error) {
    console.error(
      'Failed to parse cleaned JSON response:',
      error
    )
    console.error('Response text:', text)
    throw error
  }
}

async function processTranscript(
  transcript: Transcript
): Promise<ProcessedTranscript> {
  const prompt = await readFile(
    'prompts/lesson-meta.md',
    'utf-8'
  )

  const transcriptXml = `<transcript>\n${transcript.content}\n</transcript>`

  const { text } = await generateText({
    model: openai.responses('gpt-4.1'),
    prompt: `<transcripts>\n${transcriptXml}\n</transcripts>\n\n${prompt}`,
    tools: {
      web_search_preview: openai.tools.webSearchPreview({
        searchContextSize: 'high',
      }),
    },
  })

  // Extract JSON from the response if it's wrapped in code blocks
  const jsonMatch = text.match(
    /```(?:json)?\s*({[\s\S]*?})\s*```/
  )
  const jsonString = jsonMatch ? jsonMatch[1] : text

  try {
    const processed = JSON.parse(jsonString)
    if (
      typeof processed !== 'object' ||
      processed === null
    ) {
      throw new Error('Expected a JSON object')
    }

    return processed
  } catch (error) {
    console.error('Failed to parse JSON response:', error)
    console.error('Response text:', text)
    throw error
  }
}

async function getAllVttFiles(
  dir: string
): Promise<string[]> {
  const files = await readdir(dir)
  const vttFiles: string[] = []

  for (const file of files) {
    const fullPath = join(dir, file)
    const stat = await access(fullPath)
      .then(() => true)
      .catch(() => false)

    if (!stat) continue

    if (file.endsWith('.vtt')) {
      vttFiles.push(fullPath)
    } else {
      // Check if it's a directory
      try {
        const isDir = (await readdir(fullPath)).length > 0
        if (isDir) {
          const subFiles = await getAllVttFiles(fullPath)
          vttFiles.push(...subFiles)
        }
      } catch {
        // If we can't read it as a directory, skip it
        continue
      }
    }
  }

  return vttFiles
}

async function findVideoFile(
  basePath: string
): Promise<string | null> {
  const videoExtensions = [
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
  ]
  for (const ext of videoExtensions) {
    const videoPath = basePath.replace('.vtt', ext)
    try {
      await access(videoPath)
      return videoPath
    } catch {
      continue
    }
  }
  return null
}

async function main() {
  const transcriptProcessor: ContentProcessor<ProcessedTranscript> =
    {
      process: async (content, metadata) => {
        const transcript = {
          filename: metadata.filename,
          content: content.toString(),
        }

        const processed = await processTranscript(
          transcript
        )

        // Find the video file with the correct extension
        const baseVideoPath = metadata.inputPath.replace(
          metadata.inputPath.split('/')[0],
          DEFAULT_VIDEOS_DIR
        )

        const videoPath = await findVideoFile(baseVideoPath)
        if (!videoPath) {
          console.warn(
            `No video file found for ${metadata.filename}`
          )
          processed.duration = 0
        } else {
          processed.duration = await getVideoDuration(
            videoPath
          )
        }

        // Remove forbidden words
        return await editResponse(processed)
      },
    }

  try {
    await processFiles<ProcessedTranscript>(
      DEFAULT_INPUT_DIR,
      {
        outputDir: DEFAULT_OUTPUT_DIR,
        processor: transcriptProcessor,
        fileFilter: ['.vtt'],
        recursive: true,
        outputExtension: '.json',
        outputWriter: async (result, outputPath) => {
          await writeFile(
            outputPath,
            JSON.stringify(result, null, 2),
            'utf-8'
          )
        },
      }
    )
    console.log('Processing completed successfully!')
  } catch (error) {
    console.error('Error during processing:', error)
    process.exit(1)
  }
}

main().catch(console.error)
