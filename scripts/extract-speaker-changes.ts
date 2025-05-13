import fs from 'fs'

export interface SpeakerChange {
  timestamp: number // in seconds
  speaker: string
}

/**
 * Extracts timestamps where the speaker changes in a VTT transcript
 * @param transcriptPath Path to the VTT file
 * @returns Array of speaker change objects with timestamps in seconds
 */
export async function extractSpeakerChanges(
  transcriptPath: string
): Promise<SpeakerChange[]> {
  // Read the transcript file
  const content = await fs.promises.readFile(
    transcriptPath,
    'utf-8'
  )
  const lines = content.split('\n')

  const speakerChanges: SpeakerChange[] = []
  let currentSpeaker = ''

  for (let i = 0; i < lines.length; i++) {
    // Look for timestamp lines (e.g., "00:00:00.000 --> 00:00:01.200")
    const timestampMatch = lines[i].match(
      /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/
    )

    if (timestampMatch) {
      // Get the start timestamp
      const startTime = timestampMatch[1]

      // Check if the next line contains a speaker tag
      if (i + 1 < lines.length) {
        const speakerLine = lines[i + 1]
        const speakerMatch =
          speakerLine.match(/<v ([^>]+)>/)

        if (speakerMatch) {
          const speaker = speakerMatch[1].trim()

          // If the speaker changed, record this timestamp
          if (speaker !== currentSpeaker) {
            const seconds = parseTimeToSeconds(startTime)
            speakerChanges.push({
              timestamp: seconds,
              speaker,
            })
            currentSpeaker = speaker
          }
        }
      }
    }
  }

  return speakerChanges
}

/**
 * Parse a time string in format HH:MM:SS.mmm to seconds
 */
function parseTimeToSeconds(timeStr: string): number {
  if (!timeStr) return 0

  // Try to match a time format like 00:10:30.123
  const match = timeStr.match(/(\d+):(\d+):(\d+)\.(\d+)/)
  if (match) {
    const hours = parseInt(match[1], 10)
    const minutes = parseInt(match[2], 10)
    const seconds = parseInt(match[3], 10)
    const milliseconds = parseInt(match[4], 10)

    if (
      !isNaN(hours) &&
      !isNaN(minutes) &&
      !isNaN(seconds) &&
      !isNaN(milliseconds)
    ) {
      return (
        hours * 3600 +
        minutes * 60 +
        seconds +
        milliseconds / 1000
      )
    }
  }

  return 0
}
