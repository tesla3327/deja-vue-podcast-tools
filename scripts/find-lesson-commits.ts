import { execSync } from 'child_process'
import { chdir } from 'process'
import { existsSync } from 'fs'

const OWNER = 'MasteringNuxt'
const REPO = 'mastering-nuxt-full-stack-unleashed'

function findLessonCommits(directory: string) {
  try {
    // Check if directory exists
    if (!existsSync(directory)) {
      console.error(
        `Directory "${directory}" does not exist`
      )
      process.exit(1)
    }

    // Change to the specified directory
    chdir(directory)

    // Get all commits with their messages
    const gitLog = execSync(
      'git log --pretty=format:"%H %s"',
      { encoding: 'utf-8' }
    )

    // Split into lines and filter for commits with "Lesson" in the message
    const commits = gitLog.split('\n')
    const lessonCommits = commits.filter((commit) =>
      commit.includes('Lesson')
    )

    // Format and log each commit
    lessonCommits.forEach((commit) => {
      const [hash, ...messageParts] = commit.split(' ')
      const message = messageParts.join(' ')
      const url = `https://github.com/${OWNER}/${REPO}/commit/${hash}`
      console.log(`${url} - ${message}`)
    })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('not a git repository')) {
        console.error(
          `Directory "${directory}" is not a git repository`
        )
      } else {
        console.error(
          'Error fetching commits:',
          error.message
        )
      }
    } else {
      console.error('Error fetching commits:', error)
    }
    process.exit(1)
  }
}

// Get directory from command line argument or use current directory
const directory = process.argv[2] || '.'
findLessonCommits(directory)
