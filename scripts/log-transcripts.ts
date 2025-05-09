import 'dotenv/config'
import {
  findMatchingFiles,
  safeReadFile,
} from '../fileUtils'

const DEFAULT_INPUT_DIR = 'processed-transcripts'

interface ProcessedTranscript {
  title: string
  description: string
  duration: number
}

async function main() {
  try {
    // Get directory from command line argument or use default
    const inputDir = process.argv[2] || DEFAULT_INPUT_DIR
    console.log(`Reading transcripts from: ${inputDir}`)

    const jsonFiles = await findMatchingFiles(inputDir, {
      fileFilter: ['.json'],
      recursive: true,
    })

    for (const filepath of jsonFiles) {
      const content = await safeReadFile(
        filepath,
        false,
        'utf-8'
      )
      const transcript: ProcessedTranscript = JSON.parse(
        content.toString()
      )

      // Print filename
      console.log('\n' + '='.repeat(80))
      console.log(`File: ${filepath}`)
      console.log('='.repeat(80))

      // Print metadata
      console.log('\nTitle:')
      console.log('-'.repeat(40))
      console.log(transcript.title)
      console.log('\nDescription:')
      console.log('-'.repeat(40))
      console.log(transcript.description)
      console.log('\nDuration:')
      console.log('-'.repeat(40))
      console.log(
        `${Math.round(transcript.duration)} seconds`
      )

      // Add spacing between transcripts
      console.log('\n' + '='.repeat(80) + '\n')
    }
  } catch (error) {
    console.error('Error processing transcripts:', error)
  }
}

main().catch(console.error)
