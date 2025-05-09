import ffmpeg from 'fluent-ffmpeg'
import {
  processFiles,
  ContentProcessor,
} from './scripts/fileUtils'

// Default directories
const DEFAULT_INPUT_DIR = 'videos'
const DEFAULT_OUTPUT_DIR = 'audio'

// Supported video extensions
const VIDEO_EXTENSIONS = [
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wmv',
  '.flv',
  '.webm',
]

// Supported audio output format
const AUDIO_EXTENSION = '.mp3'

async function convertVideoToAudio(
  inputPath: string,
  outputPath: string,
  bitrate: string = '192k'
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioBitrate(bitrate)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const [
    inputDir = DEFAULT_INPUT_DIR,
    outputDir = DEFAULT_OUTPUT_DIR,
    bitrate = '192k',
  ] = args

  const videoProcessor: ContentProcessor<void> = {
    process: async (_, metadata) => {
      await convertVideoToAudio(
        metadata.inputPath,
        metadata.outputPath,
        bitrate
      )
    },
  }

  try {
    await processFiles<void>(inputDir, {
      outputDir,
      processor: videoProcessor,
      fileFilter: VIDEO_EXTENSIONS,
      recursive: true,
      outputExtension: AUDIO_EXTENSION,
      skipContent: true,
    })
    console.log('Conversion completed successfully!')
  } catch (error) {
    console.error('Error during conversion:', error)
    process.exit(1)
  }
}

main()
