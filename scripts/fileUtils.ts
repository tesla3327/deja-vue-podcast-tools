import * as fs from 'fs'
import * as path from 'path'

// Core processing interface
export interface ContentProcessor<T> {
  process(
    content: Buffer | string,
    metadata: {
      filename: string
      inputPath: string
      outputPath: string
    }
  ): Promise<T>
}

// Natural sort comparison function
export function naturalSort(a: string, b: string): number {
  // Split paths into segments
  const aSegments = a.split(path.sep)
  const bSegments = b.split(path.sep)

  // Compare each segment
  for (
    let i = 0;
    i < Math.min(aSegments.length, bSegments.length);
    i++
  ) {
    const aSegment = aSegments[i]
    const bSegment = bSegments[i]

    // Extract numbers from segment
    const aNumbers = aSegment.match(/\d+/g) || []
    const bNumbers = bSegment.match(/\d+/g) || []

    // Compare numbers first
    for (
      let j = 0;
      j < Math.min(aNumbers.length, bNumbers.length);
      j++
    ) {
      const aNum = parseInt(aNumbers[j], 10)
      const bNum = parseInt(bNumbers[j], 10)
      if (aNum !== bNum) return aNum - bNum
    }

    // If one segment has more numbers, it comes after
    if (aNumbers.length !== bNumbers.length) {
      return aNumbers.length - bNumbers.length
    }

    // If numbers are equal, compare the full segment
    const segmentCompare = aSegment.localeCompare(bSegment)
    if (segmentCompare !== 0) return segmentCompare
  }

  // If all segments are equal up to the length of the shorter path,
  // the shorter path comes first
  return aSegments.length - bSegments.length
}

// Main processing function
export async function processFiles<T>(
  input: string | string[],
  options: {
    outputDir: string
    processor: ContentProcessor<T>
    fileFilter: string[] | ((filename: string) => boolean)
    readAsBuffer?: boolean
    outputWriter?: (
      result: T,
      outputPath: string
    ) => Promise<void>
    recursive?: boolean
    processExisting?: boolean
    outputExtension?: string
    encoding?: BufferEncoding
    skipContent?: boolean
  }
): Promise<T[]> {
  const {
    outputDir,
    processor,
    fileFilter,
    readAsBuffer = false,
    outputWriter,
    recursive = false,
    processExisting = false,
    outputExtension,
    encoding = 'utf-8',
    skipContent = false,
  } = options

  // Ensure output directory exists
  await ensureDirectoryExists(outputDir)

  // Get all matching files
  const inputPaths = Array.isArray(input) ? input : [input]
  const files = await findMatchingFiles(inputPaths, {
    fileFilter,
    recursive,
  })

  const results: T[] = []

  // Process each file
  for (const inputPath of files) {
    // Get the relative path from the input directory to the file
    const relativePath = path.relative(
      inputPaths[0],
      inputPath
    )
    const outputPath = path.join(
      outputDir,
      path.dirname(relativePath),
      path.basename(
        relativePath,
        path.extname(relativePath)
      ) + (outputExtension || '')
    )

    // Skip if output exists and processExisting is false
    if (
      !processExisting &&
      (await fileExists(outputPath))
    ) {
      console.log(
        `Skipping: ${inputPath} - output already exists at ${outputPath}`
      )
      continue
    }

    try {
      // Ensure output directory exists
      await ensureDirectoryExists(path.dirname(outputPath))

      // Read file content only if needed
      const content = skipContent
        ? null
        : await safeReadFile(
            inputPath,
            readAsBuffer,
            encoding
          )

      // Process content
      const result = await processor.process(
        content || Buffer.alloc(0),
        {
          filename: path.basename(inputPath),
          inputPath,
          outputPath,
        }
      )

      // Write output if writer provided
      if (result) {
        if (outputWriter) {
          await outputWriter(result, outputPath)
        } else {
          await safeWriteFile(outputPath, result, encoding)
        }
      }

      results.push(result)
      console.log(
        `Successfully processed: ${inputPath} -> ${outputPath}`
      )
    } catch (error) {
      console.error(`Error processing ${inputPath}:`, error)
    }
  }

  return results
}

// File search utility
export async function findMatchingFiles(
  input: string | string[],
  options: {
    fileFilter: string[] | ((filename: string) => boolean)
    recursive?: boolean
  }
): Promise<string[]> {
  const { fileFilter, recursive = false } = options
  const inputPaths = Array.isArray(input) ? input : [input]
  const files: string[] = []

  for (const inputPath of inputPaths) {
    const stat = await fs.promises.stat(inputPath)

    if (stat.isFile()) {
      if (matchesFilter(inputPath, fileFilter)) {
        files.push(inputPath)
      }
    } else if (recursive) {
      const subFiles = await getAllFiles(
        inputPath,
        fileFilter
      )
      files.push(...subFiles)
    }
  }

  // Sort files naturally as we collect them
  files.sort(naturalSort)

  return files
}

export async function ensureDirectoryExists(
  dirPath: string
): Promise<void> {
  try {
    await fs.promises.stat(dirPath)
  } catch {
    await fs.promises.mkdir(dirPath, { recursive: true })
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path)
    return true
  } catch {
    return false
  }
}

export async function safeReadFile(
  path: string,
  asBuffer: boolean,
  encoding: BufferEncoding
): Promise<string | Buffer> {
  try {
    return await fs.promises.readFile(
      path,
      asBuffer ? undefined : encoding
    )
  } catch (error) {
    throw new Error(`Failed to read file ${path}: ${error}`)
  }
}

export async function safeWriteFile(
  path: string,
  data: any,
  encoding: BufferEncoding
): Promise<void> {
  try {
    await fs.promises.writeFile(path, data, encoding)
  } catch (error) {
    throw new Error(
      `Failed to write file ${path}: ${error}`
    )
  }
}

async function getAllFiles(
  dir: string,
  fileFilter: string[] | ((filename: string) => boolean)
): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.promises.readdir(dir, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(
        fullPath,
        fileFilter
      )
      files.push(...subFiles)
    } else if (matchesFilter(fullPath, fileFilter)) {
      files.push(fullPath)
    }
  }

  return files
}

function matchesFilter(
  filepath: string,
  filter: string[] | ((filename: string) => boolean)
): boolean {
  if (typeof filter === 'function') {
    return filter(path.basename(filepath))
  }
  return filter.includes(
    path.extname(filepath).toLowerCase()
  )
}
