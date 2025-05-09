import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

interface SearchResult {
  title: string
  url: string
  relevance: number
}

export async function searchRelevantLinks(
  transcript: string,
  maxResults: number = 3
): Promise<SearchResult[]> {
  const prompt = `Given the following lesson transcript, find the most relevant documentation links that would be helpful for learners. Focus on official documentation and high-quality resources.

Transcript:
${transcript}

Return the results in JSON format with the following structure:
[
  {
    "title": "string",
    "url": "string",
    "relevance": number (0-1)
  }
]

Only include links that are highly relevant to the lesson content. The relevance score should reflect how directly the link relates to the lesson's main topics.`

  const { text } = await generateText({
    model: openai.responses('gpt-4.1'),
    prompt,
    temperature: 0.7,
    maxTokens: 500,
  })

  // Extract JSON from the response if it's wrapped in code blocks
  const jsonMatch = text.match(
    /```(?:json)?\s*(\[[\s\S]*?\])\s*```/
  )
  const jsonString = jsonMatch ? jsonMatch[1] : text

  try {
    const results = JSON.parse(jsonString)
    // Sort by relevance and limit to maxResults
    return results
      .sort(
        (a: SearchResult, b: SearchResult) =>
          b.relevance - a.relevance
      )
      .slice(0, maxResults)
  } catch (error) {
    console.error('Failed to parse search results:', error)
    console.error('Response text:', text)
    return []
  }
}
