#!/usr/bin/env node
import dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs/promises'
import { consola } from 'consola'
import {
  intro,
  outro,
  text,
  select,
  confirm,
  spinner,
  isCancel,
  multiselect,
} from '@clack/prompts'
import {
  processTranscriptChapters,
  splitTranscriptIntoChapters,
  findChapterTimestamps,
  Chapter,
} from './transcript-chapters'

// Extend the Chapter type to include formattedTime
interface ChapterWithFormattedTime extends Chapter {
  formattedTime?: string
}

dotenv.config()

// Define allowed file extensions
const ALLOWED_EXTENSIONS = ['.txt', '.vtt', '.srt']

/**
 * Main function that runs the CLI
 */
async function main() {
  try {
    // Introduction
    intro('Transcript Chapter Generator')

    const filePath = await getTranscriptFilePath()
    if (isCancel(filePath)) {
      handleCancel()
    }

    const maxChapters = await getMaxChapters()
    if (isCancel(maxChapters)) {
      handleCancel()
    }

    const transcript = await readTranscriptFile(
      String(filePath)
    )

    const initialChapters = await generateInitialChapters(
      transcript,
      maxChapters
    )

    const selectedChapters = await selectChapters(
      initialChapters
    )
    if (isCancel(selectedChapters)) {
      handleCancel()
    }

    const chaptersWithTimestamps =
      await processSelectedChapters(
        selectedChapters,
        transcript
      )

    const chaptersWithFormattedTime =
      addFormattedTimeToChapters(chaptersWithTimestamps)

    displayProcessedChapters(chaptersWithFormattedTime)

    await handleChapterSaving(
      chaptersWithFormattedTime,
      String(filePath)
    )
  } catch (error: unknown) {
    consola.fatal(
      `Unexpected error: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    )
    process.exit(1)
  }
}

/**
 * Prompt user for transcript file path
 */
async function getTranscriptFilePath() {
  return text({
    message: 'Enter path to transcript file:',
    placeholder: 'path/to/transcript.txt',
    validate: (value) => {
      if (!value) return 'Please enter a file path'

      try {
        // This will be handled outside in an async context
        fs.access(value)
        const ext = path.extname(value).toLowerCase()
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
          return `File must be one of these formats: ${ALLOWED_EXTENSIONS.join(
            ', '
          )}`
        }
      } catch (e) {
        return 'File does not exist or is not accessible'
      }

      return undefined
    },
  })
}

/**
 * Prompt user for maximum number of chapters
 */
async function getMaxChapters() {
  const maxChaptersStr = await text({
    message: 'Maximum number of chapters:',
    placeholder: '15',
    validate: (value) => {
      const num = parseInt(value)
      if (isNaN(num) || num < 1 || num > 20) {
        return 'Please enter a number between 1 and 20'
      }
      return undefined
    },
  })

  if (isCancel(maxChaptersStr)) {
    handleCancel()
  }

  return parseInt(String(maxChaptersStr))
}

/**
 * Read the transcript file contents
 */
async function readTranscriptFile(
  filePath: string
): Promise<string> {
  const loadingSpinner = spinner()
  loadingSpinner.start('Reading transcript file')

  try {
    const transcript = await fs.readFile(filePath, 'utf-8')
    loadingSpinner.stop('Transcript loaded successfully')
    return transcript
  } catch (error: unknown) {
    loadingSpinner.stop('Failed to read transcript file')
    consola.error(
      `Error reading file: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    )
    process.exit(1)
  }
}

/**
 * Generate initial chapters from transcript
 */
async function generateInitialChapters(
  transcript: string,
  maxChapters: number
): Promise<Chapter[]> {
  const loadingSpinner = spinner()
  loadingSpinner.start(
    'Finding chapter topics in transcript'
  )

  try {
    const initialChapters =
      await splitTranscriptIntoChapters(
        transcript,
        maxChapters
      )
    loadingSpinner.stop()

    consola.success(
      `Generated ${initialChapters.length} initial chapters:`
    )

    initialChapters.forEach((chapter, index) => {
      consola.info(`${index + 1}. ${chapter.title}`)
    })

    return initialChapters
  } catch (error: unknown) {
    loadingSpinner.stop('Failed to generate chapters')
    consola.error(
      `Error generating chapters: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    )
    process.exit(1)
  }
}

/**
 * Allow user to select which chapters to keep
 */
async function selectChapters(
  initialChapters: Chapter[]
): Promise<Chapter[]> {
  const chapterChoices = initialChapters.map(
    (chapter, index) => ({
      value: index,
      label: `${index + 1}. ${chapter.title}`,
    })
  )

  // Ask if user wants to keep all chapters or select specific ones
  const selectionMode = await select({
    message: 'How would you like to select chapters?',
    options: [
      { value: 'all', label: 'Keep all chapters' },
      {
        value: 'select',
        label: 'Select specific chapters',
      },
    ],
  })

  if (isCancel(selectionMode)) {
    handleCancel()
  }

  let selectedChapterIndices: number[]

  if (selectionMode === 'all') {
    // Use all chapters
    selectedChapterIndices = initialChapters.map(
      (_, index) => index
    )
    consola.info('Keeping all chapters')
  } else {
    // Let user select specific chapters
    const multiSelection = await multiselect({
      message: 'Select chapters to keep:',
      options: chapterChoices,
      required: true,
    })

    if (isCancel(multiSelection)) {
      handleCancel()
    }

    selectedChapterIndices = multiSelection as number[]
  }

  // Return only selected chapters
  return selectedChapterIndices.map(
    (index) => initialChapters[index]
  )
}

/**
 * Process selected chapters to find timestamps
 */
async function processSelectedChapters(
  selectedChapters: Chapter[],
  transcript: string
): Promise<Chapter[]> {
  const loadingSpinner = spinner()
  loadingSpinner.start('Processing selected chapters')

  try {
    // Find timestamps for each selected chapter sequentially
    const chaptersWithTimestamps: Chapter[] = []
    for (let i = 0; i < selectedChapters.length; i++) {
      const previousChapter =
        i > 0 ? chaptersWithTimestamps[i - 1] : undefined
      loadingSpinner.message(
        `Processing chapter ${i + 1} of ${
          selectedChapters.length
        }...`
      )
      const chapterWithTimestamp =
        await findChapterTimestamps(
          selectedChapters[i],
          transcript,
          previousChapter
        )
      chaptersWithTimestamps.push(chapterWithTimestamp)
    }

    loadingSpinner.stop('Chapters processed successfully')
    return chaptersWithTimestamps
  } catch (error: unknown) {
    loadingSpinner.stop('Failed to process chapters')
    consola.error(
      `Error processing chapters: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    )
    process.exit(1)
  }
}

/**
 * Add formatted time to each chapter
 */
function addFormattedTimeToChapters(
  chapters: Chapter[]
): ChapterWithFormattedTime[] {
  return chapters.map((chapter) => ({
    ...chapter,
    formattedTime:
      chapter.startTime !== undefined
        ? formatTime(chapter.startTime)
        : 'Unknown',
  }))
}

/**
 * Display processed chapters with timestamps
 */
function displayProcessedChapters(
  chapters: ChapterWithFormattedTime[]
): void {
  consola.success(`Processed ${chapters.length} chapters:`)

  chapters.forEach((chapter, index) => {
    consola.info(
      `${index + 1}. ${chapter.title} (Start: ${
        chapter.formattedTime
      })`
    )
  })
}

/**
 * Handle saving chapters to a file
 */
async function handleChapterSaving(
  chapters: ChapterWithFormattedTime[],
  originalFilePath: string
): Promise<void> {
  const shouldSave = await confirm({
    message: 'Save chapters to a JSON file?',
  })

  if (isCancel(shouldSave)) {
    handleCancel()
  }

  if (shouldSave === true) {
    await saveChaptersToFile(chapters, originalFilePath)
  }
}

/**
 * Save chapters to a JSON file
 */
async function saveChaptersToFile(
  chapters: ChapterWithFormattedTime[],
  originalFilePath: string
): Promise<void> {
  // Get output path
  const defaultOutputPath = path.join(
    path.dirname(originalFilePath),
    `${path.basename(
      originalFilePath,
      path.extname(originalFilePath)
    )}-chapters.json`
  )

  const outputPath = await text({
    message: 'Output file path:',
    placeholder: defaultOutputPath,
    initialValue: defaultOutputPath,
  })

  if (isCancel(outputPath)) {
    handleCancel()
  }

  if (outputPath) {
    // Save chapters to file
    const loadingSpinner = spinner()
    loadingSpinner.start('Saving chapters to file')
    try {
      await fs.writeFile(
        String(outputPath),
        JSON.stringify(chapters, null, 2),
        'utf-8'
      )
      loadingSpinner.stop('Chapters saved successfully')
      consola.success(`Chapters saved to ${outputPath}`)
    } catch (error: unknown) {
      loadingSpinner.stop('Failed to save chapters')
      consola.error(
        `Error saving file: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      )
    }
  }
}

/**
 * Handle cancellation of an operation
 */
function handleCancel(): never {
  consola.warn('Operation cancelled')
  process.exit(0)
}

/**
 * Format seconds to HH:MM:SS format
 */
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
  ].join(':')
}

// Run the main function
main().catch((error: unknown) => {
  consola.fatal(
    error instanceof Error ? error.message : String(error)
  )
  process.exit(1)
})
