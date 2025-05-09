import fs from 'fs'
import path from 'path'

interface TranscriptData {
  title: string
  description: string
  duration: number
}

interface FolderStats {
  totalDuration: number
  lessonCount: number
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${remainingSeconds}s`
}

function analyzeFolder(
  folderPath: string,
  level: number = 0
): FolderStats {
  const stats: FolderStats = {
    totalDuration: 0,
    lessonCount: 0,
  }
  const files = fs.readdirSync(folderPath)

  // Create indentation for tree view
  const indent = '  '.repeat(level)

  // Sort files to ensure consistent order
  files.sort()

  // Check if this is a chapter folder (contains "Chapter" in the name)
  const isChapter = folderPath.includes('Chapter')

  // If this is a chapter, try to get the first lesson as a summary
  let chapterSummary: string | null = null
  if (isChapter) {
    const jsonFiles = files.filter((f) =>
      f.endsWith('.json')
    )
    if (jsonFiles.length > 0) {
      const firstLessonPath = path.join(
        folderPath,
        jsonFiles[0]
      )
      const content = fs.readFileSync(
        firstLessonPath,
        'utf-8'
      )
      const data: TranscriptData = JSON.parse(content)
      chapterSummary = data.description
    }
  }

  files.forEach((file) => {
    const fullPath = path.join(folderPath, file)
    const stat = fs.statSync(fullPath)

    if (stat.isDirectory()) {
      // Print folder name
      console.log(`${indent}└─ ${file}/`)

      // If this is a chapter and we have a summary, print it
      if (isChapter && chapterSummary) {
        console.log(
          `${indent}   Summary: ${chapterSummary}\n`
        )
      }

      // Recursively analyze subfolders
      const subStats = analyzeFolder(fullPath, level + 1)
      stats.totalDuration += subStats.totalDuration
      stats.lessonCount += subStats.lessonCount

      // Print folder summary
      console.log(
        `${indent}   Total: ${formatDuration(
          subStats.totalDuration
        )} (${subStats.lessonCount} lessons)`
      )
    } else if (file.endsWith('.json')) {
      // Read and analyze transcript file
      const content = fs.readFileSync(fullPath, 'utf-8')
      const data: TranscriptData = JSON.parse(content)

      stats.totalDuration += data.duration
      stats.lessonCount++

      // Print lesson info
      console.log(`${indent}├─ ${data.title}`)
      console.log(
        `${indent}│  Duration: ${formatDuration(
          data.duration
        )}`
      )
    }
  })

  return stats
}

// Start analysis from the processed-transcripts directory
const transcriptsPath = path.join(
  process.cwd(),
  'processed-transcripts'
)
console.log(
  'Video Duration Analysis\n======================\n'
)

const stats = analyzeFolder(transcriptsPath)
console.log('\nOverall Statistics')
console.log('=================')
console.log(
  `Total Duration: ${formatDuration(stats.totalDuration)}`
)
console.log(`Total Lessons: ${stats.lessonCount}`)
