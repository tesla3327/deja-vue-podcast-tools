import { generateText, generateObject } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'
import { extractSpeakerChanges } from './extract-speaker-changes'
import type { SpeakerChange } from './extract-speaker-changes'
import { format } from 'path'

export type { SpeakerChange }

export interface Chapter {
  title: string
  content: string
  startTime?: number // in seconds
  endTime?: number // in seconds
  number?: number
}

/**
 * Splits a transcript into logical chapters based on content
 */
export async function splitTranscriptIntoChapters(
  transcript: string,
  maxChapters: number = 5
): Promise<Chapter[]> {
  const prompt = `Split the following transcript into logical chapters or sections. Identify natural breaking points where the topic changes or new concepts are introduced.

<transcript>
${transcript}
</transcript>

<output>
[
  {
    "title": "Chapter Title",
    "number": 1
  }
]
</output>

Create at most ${maxChapters} chapters. Each chapter should have a descriptive title that summarizes the main topic.`

  const { text } = await generateText({
    model: openai.responses('gpt-4.1'),
    prompt,
    temperature: 0.3,
    maxTokens: 2000,
  })

  // Extract JSON from the response if it's wrapped in code blocks
  const jsonMatch = text.match(
    /```(?:json)?\s*(\[[\s\S]*?\])\s*```/
  )
  const jsonString = jsonMatch ? jsonMatch[1] : text

  try {
    const chapters = JSON.parse(jsonString) as Chapter[]
    return chapters
  } catch (error) {
    console.error('Failed to parse chapter results:', error)
    console.error('Response text:', text)
    return []
  }
}

/**
 * Finds the approximate timestamps for each chapter in a transcript
 */
export async function findChapterTimestamps(
  chapter: Chapter,
  fullTranscript: string,
  previousChapter?: Chapter,
  speakerChanges?: SpeakerChange[]
): Promise<Chapter> {
  // First chapter always starts at 00:00:00
  if (!previousChapter) {
    return {
      ...chapter,
      startTime: 0, // 00:00:00 in seconds
    }
  }

  // For subsequent chapters, set minimum start time to be previous chapter + 30 seconds
  // if not otherwise determined
  const previousStartTime = previousChapter.startTime || 0
  const minimumStartTime = previousStartTime + 60 // Minimum 60-second increment

  // If we have speaker changes, find a suitable change point
  let potentialBreakpoints: SpeakerChange[] =
    speakerChanges || []
  if (speakerChanges && speakerChanges.length > 0) {
    // Find speaker changes that happen after the previous chapter start
    potentialBreakpoints = speakerChanges.filter(
      (change) =>
        change.timestamp > previousStartTime &&
        change.timestamp >= minimumStartTime
    )
  }

  // Reformat all the timestamps
  const formattedPotentialBreakpoints =
    potentialBreakpoints.map((change) => ({
      ...change,
      timestamp: formatSecondsToTimeString(
        change.timestamp
      ),
    }))

  const prompt = `
<full_transcript>
${fullTranscript}
</full_transcript>

<previous_chapter_info>
Previous chapter title: "${previousChapter.title}"
</previous_chapter_info>

<potential_breakpoints>
${formattedPotentialBreakpoints
  .map((change) => change.timestamp)
  .join('\n')}
</potential_breakpoints>


<instructions>
1. Search the transcript carefully and think through where the topic shifts to "${
    chapter.title
  }"
2. Look for clear transitions, introductions of new concepts
3. The timestamp MUST be chosen from one of the <potential_breakpoints>
4. Return the timestamp in HH:MM:SS format (e.g., "00:10:00" for 10 minutes)

Your task is to analyze the transcript and provide the exact timestamp where this specific topic begins from the <potential_breakpoints>.
</instructions>
`

  try {
    const result = await generateObject<{
      reasoning: string
      startTime: string
    }>({
      model: openai.responses('gpt-4.1'),
      prompt,
      schema: z.object({
        reasoning: z.string(),
        startTime: z.string(),
      }),
    })

    // Parse the timestamp string into seconds
    let startTime = parseTimeToSeconds(
      result.object.startTime
    )

    // Sanity check: ensure the timestamp is after the previous chapter
    if (!startTime || startTime <= previousStartTime) {
      console.warn(
        `Invalid timestamp ${result.object.startTime} for "${chapter.title}", using minimum time`
      )
      startTime = minimumStartTime
    }

    // Log successful parsing for debugging
    console.log(
      `Timestamp for "${
        chapter.title
      }": start=${formatSecondsToTimeString(
        startTime
      )} (${startTime}s)`
    )

    return {
      ...chapter,
      startTime,
    }
  } catch (error) {
    console.error('Failed to generate timestamp:', error)
    // Default to minimum start time in case of error
    return {
      ...chapter,
      startTime: minimumStartTime,
    }
  }
}

/**
 * Format seconds to HH:MM:SS time string
 */
function formatSecondsToTimeString(
  seconds: number
): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

/**
 * Parse a time string in format HH:MM:SS to seconds
 */
function parseTimeToSeconds(
  timeStr: string
): number | undefined {
  if (!timeStr) return undefined

  // Try to match a time format like 00:10:30 or 1:30:45
  const match = timeStr.match(/(\d+):(\d+):(\d+)/)
  if (match) {
    const hours = parseInt(match[1], 10)
    const minutes = parseInt(match[2], 10)
    const seconds = parseInt(match[3], 10)

    if (
      !isNaN(hours) &&
      !isNaN(minutes) &&
      !isNaN(seconds)
    ) {
      return hours * 3600 + minutes * 60 + seconds
    }
  }

  // If the above didn't match, try to extract any numbers that might represent time
  const numbers = timeStr.match(/\d+/g)
  if (numbers && numbers.length > 0) {
    const num = parseInt(numbers[0], 10)
    if (!isNaN(num)) {
      return num
    }
  }

  return undefined
}

/**
 * Process a transcript to extract chapters with timestamps
 */
export async function processTranscriptChapters(
  transcript: string,
  transcriptPath?: string,
  maxChapters: number = 5
): Promise<Chapter[]> {
  // Step 1: Split transcript into chapters
  const chapters = await splitTranscriptIntoChapters(
    transcript,
    maxChapters
  )

  // Step 2: Extract speaker changes if transcript path is provided
  let speakerChanges: SpeakerChange[] = []
  if (transcriptPath) {
    try {
      speakerChanges = await extractSpeakerChanges(
        transcriptPath
      )
      console.log(
        `Extracted ${speakerChanges.length} speaker changes from transcript.`
      )

      // Log the extracted speaker changes for review
      speakerChanges.forEach((change) => {
        console.log(
          `Speaker change at ${formatSecondsToTimeString(
            change.timestamp
          )}: ${change.speaker}`
        )
      })
    } catch (error) {
      console.error(
        'Failed to extract speaker changes:',
        error
      )
    }
  }

  // Step 3: Find timestamps for each chapter sequentially
  const chaptersWithTimestamps: Chapter[] = []

  for (let i = 0; i < chapters.length; i++) {
    const previousChapter =
      i > 0 ? chaptersWithTimestamps[i - 1] : undefined
    const chapterWithTimestamp =
      await findChapterTimestamps(
        chapters[i],
        transcript,
        previousChapter,
        speakerChanges
      )
    chaptersWithTimestamps.push(chapterWithTimestamp)
  }

  return chaptersWithTimestamps
}
