import 'dotenv/config'
import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import {
  findMatchingFiles,
  safeReadFile,
  safeWriteFile,
} from '../fileUtils'

type LinkExtractorConfig = {
  numQueries?: number
  searchContextSize?: 'low' | 'medium' | 'high'
  numLinks?: number
}

type RelevantLink = {
  description: string
  url: string
}

/**
 * Cleans a URL by removing query parameters
 */
function cleanUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.origin + urlObj.pathname
  } catch {
    return url
  }
}

/**
 * Extracts relevant links from a transcript by generating search queries
 * and using the OpenAI Responses API to find information.
 */
export async function extractRelevantLinks(
  transcript: string,
  config: LinkExtractorConfig = {}
) {
  const {
    numQueries = 15,
    searchContextSize = 'medium',
    numLinks = 15,
  } = config

  // Generate search queries based on the transcript
  const queries = await generateSearchQueries(
    transcript,
    numQueries
  )
  console.log(`Generated ${queries.length} search queries`)

  // Run web searches in parallel
  const searchPromises = queries.map((query) =>
    runWebSearch(query, transcript, searchContextSize)
  )

  // Wait for all searches to complete
  const searchResults = await Promise.all(searchPromises)

  // Process results to extract unique, relevant links
  const relevantLinks = await processSearchResults(
    searchResults,
    transcript,
    numLinks
  )

  return relevantLinks
}

/**
 * Generates search queries based on the transcript content
 */
async function generateSearchQueries(
  transcript: string,
  numQueries: number
): Promise<string[]> {
  const result = await generateText({
    model: openai('gpt-4.1'),
    prompt: `
<transcript>
${transcript}
</transcript>

I have a transcript from a video or podcast. Please generate ${numQueries} search queries
to find relevant links about things mentioned in the transcript. These could be people,
tools, websites, projects, or other resources mentioned either directly or indirectly.

Format your response as a JSON array of strings, each representing a search query.
    `,
    temperature: 0.7,
  })

  // Clean the response text by removing markdown code block markers
  const cleanedText = result.text
    .replace(/```json\s*|\s*```/g, '')
    .trim()

  try {
    return JSON.parse(cleanedText)
  } catch (error) {
    console.error('Failed to parse queries:', error)
    return []
  }
}

/**
 * Runs a web search for a given query using OpenAI Responses API
 */
async function runWebSearch(
  query: string,
  transcript: string,
  searchContextSize: 'low' | 'medium' | 'high'
): Promise<{
  query: string
  result: string
  sources: any[]
}> {
  try {
    console.log(`Searching: "${query}"`)

    const result = await generateText({
      model: openai.responses('gpt-4.1'),
      prompt: `
      <transcript>
      ${transcript}
      </transcript>

      <search_query>
      ${query}
      </search_query>

      Based on the <search_query>, find relevant information. Return the most relevant 3 links that relates to the content in the <transcript>.
      `,
      tools: {
        web_search_preview: openai.tools.webSearchPreview({
          searchContextSize,
        }),
      },
      // Force tool usage
      toolChoice: {
        type: 'tool',
        toolName: 'web_search_preview',
      },
    })

    // Log out the text and sources in a nicely formatted way
    console.log('='.repeat(100))
    console.log('Query\n', query)
    console.log('-'.repeat(100))
    console.log('Result\n', result.text)
    console.log('-'.repeat(100))
    console.log('Sources\n')
    result.sources?.forEach((source) => {
      console.log(`- ${source.title}: ${source.url}`)
    })
    console.log('\n\n')

    return {
      query,
      result: result.text,
      sources: result.sources || [],
    }
  } catch (error: any) {
    console.error(`Error searching for "${query}":`, error)
    return {
      query,
      result: `Error: ${error.message}`,
      sources: [],
    }
  }
}

/**
 * Processes search results to extract relevant links
 */
async function processSearchResults(
  searchResults: {
    query: string
    result: string
    sources: any[]
  }[],
  transcript: string,
  numLinks: number
): Promise<RelevantLink[]> {
  // Collect all sources from search results
  const allSources = searchResults.flatMap(
    (result) => result.sources || []
  )

  // Use AI to filter and rank the most relevant sources
  // First sort by URL to group by hostname
  const sourcesText = allSources
    .sort((a, b) => a.url.localeCompare(b.url))
    .map(
      (s) =>
        `- ${s.title || 'Untitled'}: ${cleanUrl(s.url)}`
    )
    .join('\n')

  const rankedLinks = await generateText({
    model: openai('gpt-4.1'),
    prompt: `
      <transcript>
      ${transcript}
      </transcript>

      <sources>
      ${sourcesText}
      </sources>

      <output_format>
      [
        {
          "description": "Description",
          "url": "URL"
        }
      ]
      </output_format>

      I have a <transcript> and a list of <sources> found through searches related to the <transcript>.
      Please analyze these sources and identify the most relevant ones that directly relate to
      people, tools, projects, or concepts mentioned in the <transcript>.

      For each relevant link, provide a short description or title following the format in <output_format>.

      For example:
      - "Michael Thiessen: https://michaelnthiessen.com"
      - "useRuntimeConfig in Nuxt: https://nuxt.com/docs/guide/directory-structure/runtime-config"
      - "SvelteKit: https://svelte.dev/kit"

      When choosing links:
      - Prefer official documentation or websites over blogs or articles
      - Aim to provide ${numLinks} links without duplicates or too much overlap
      - URLs should not include query parameters
    `,
  })

  // Clean the response text by removing markdown code block markers
  const cleanedText = rankedLinks.text
    .replace(/```json\s*|\s*```/g, '')
    .trim()

  const links = JSON.parse(cleanedText)

  // Clean URLs in the final results
  return links.map((link: RelevantLink) => ({
    ...link,
    url: cleanUrl(link.url),
  }))
}

// Example usage
if (require.main === module) {
  async function main() {
    const transcriptPath = process.argv[2]
    if (!transcriptPath) {
      console.error('Please provide a transcript file path')
      process.exit(1)
    }

    const transcriptFiles = await findMatchingFiles(
      transcriptPath,
      {
        fileFilter: ['.vtt', '.txt'],
      }
    )

    if (transcriptFiles.length > 0) {
      const transcriptContent = await safeReadFile(
        transcriptFiles[0],
        false,
        'utf-8'
      )
      const links = await extractRelevantLinks(
        transcriptContent.toString()
      )

      // Save links to file
      const outputPath = transcriptFiles[0].replace(
        /\.[^/.]+$/,
        '_links.txt'
      )
      const output = links
        .map((link) => `${link.description}: ${link.url}`)
        .join('\n')
      await safeWriteFile(outputPath, output, 'utf-8')
      console.log(`Links saved to ${outputPath}`)
    }
  }

  main().catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })
}
