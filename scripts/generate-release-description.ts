import {
  intro,
  select,
  multiselect,
  spinner,
  outro,
  isCancel,
} from '@clack/prompts'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import path from 'path'
import dotenv from 'dotenv'
import {
  findMatchingFiles,
  safeReadFile,
  safeWriteFile,
  ensureDirectoryExists,
  naturalSort,
} from '../fileUtils'

dotenv.config()

async function getTranscriptFiles() {
  const processedDir = path.join(__dirname, 'transcripts')

  return await findMatchingFiles(processedDir, {
    fileFilter: ['.vtt'],
    recursive: true,
  })
}

async function readTranscript(
  filePath: string
): Promise<string> {
  return (await safeReadFile(
    filePath,
    false,
    'utf-8'
  )) as string
}

async function generateReleaseDescription(
  transcripts: string[]
): Promise<string> {
  const s = spinner()
  s.start('Generating release description...')

  try {
    const templatePath = path.join(
      __dirname,
      'prompts',
      'release-description.md'
    )
    const template = (await safeReadFile(
      templatePath,
      false,
      'utf-8'
    )) as string

    // Sort transcripts using natural sort
    const sortedTranscripts = [...transcripts].sort(
      (a, b) => {
        const aFilename = a.split('\n')[0] // Get first line which should be filename
        const bFilename = b.split('\n')[0]
        return naturalSort(aFilename, bFilename)
      }
    )

    const prompt = template.replace(
      '{{ transcripts }}',
      sortedTranscripts.join('\n\n')
    )

    const { text } = await generateText({
      model: openai('gpt-4.1'),
      prompt,
      temperature: 0.7,
    })

    s.stop('Release description generated!')
    return text
  } catch (error) {
    s.stop('Failed to generate release description')
    throw error
  }
}

async function writeReleaseDescription(
  description: string
) {
  const outputDir = path.join(
    __dirname,
    'release-descriptions'
  )
  await ensureDirectoryExists(outputDir)

  const timestamp = new Date().toISOString().split('T')[0]
  const outputPath = path.join(
    outputDir,
    `release-${timestamp}.md`
  )

  await safeWriteFile(outputPath, description, 'utf-8')
  return outputPath
}

async function main() {
  intro('🎬 Release Description Generator')

  try {
    const transcriptFiles = await getTranscriptFiles()

    if (transcriptFiles.length === 0) {
      outro(
        'No transcript files found in the processed-transcripts directory.'
      )
      return
    }

    const selectedFiles = await multiselect({
      message:
        'Select transcripts to include in the release description:',
      options: transcriptFiles.map((file) => ({
        value: file,
        label: path.relative(
          path.join(__dirname, 'processed-transcripts'),
          file
        ),
      })),
    })

    if (isCancel(selectedFiles)) {
      outro('Operation cancelled')
      return
    }

    const transcripts = await Promise.all(
      (selectedFiles as string[]).map(readTranscript)
    )

    const releaseDescription =
      await generateReleaseDescription(transcripts)

    const outputPath = await writeReleaseDescription(
      releaseDescription
    )
    outro(
      `Release description has been written to: ${outputPath}`
    )
    const { exec } = await import('child_process')
    exec(`cursor ${outputPath}`)
  } catch (error) {
    outro('An error occurred: ' + (error as Error).message)
  }
}

main().catch(console.error)
