async function createVisualization(
  opts: CliOpts,
  silenceEnds: number[]
): Promise<void> {
  // Create a visualization of the audio waveform
  const args = [
    '-i',
    opts.inFile,
    '-filter_complex',
    [
      // Create the waveform visualization
      'showwaves=s=1920x200:mode=line:colors=0x00ff00',
      // Add silence markers
      ...silenceEnds
        .map(
          (end, i) =>
            `drawtext=text='|':fontsize=30:fontcolor=red:x='${end}*w/t':y=0:enable='between(t,${
              end - 0.1
            },${end + 0.1})'`
        )
        .join(','),
    ].join(','),
    '-frames:v',
    '1',
    'visualization.png',
  ]

  await runFFmpeg(args)
  console.log(
    '📊 Created visualization at visualization.png'
  )
}

async function main() {
  const opts = parseArgs()
  const ends = await detectSilenceEnds(opts)
  if (!ends.length) {
    console.log(
      'No silences >= duration found — nothing to do.'
    )
    return
  }

  // Create visualization first
  await createVisualization(opts, ends)

  // Ask for confirmation before proceeding
  console.log(
    `\nFound ${ends.length} silence points. Would you like to proceed with adding chapters? (y/n)`
  )
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  readline.question('', async (answer: string) => {
    readline.close()
    if (answer.toLowerCase() !== 'y') {
      console.log('Operation cancelled.')
      return
    }

    const metaTxt = buildMetadataFile(ends)
    const metaPath = join(
      tmpdir(),
      `chapters-${Date.now()}.ffmeta`
    )
    await fs.writeFile(metaPath, metaTxt)

    const args = [
      '-i',
      opts.inFile,
      '-i',
      metaPath,
      '-map_metadata',
      '1',
      '-codec',
      'copy',
      opts.outFile,
    ]
    await runFFmpeg(args)
    await fs.unlink(metaPath)

    console.log(
      `✅ Chapters added at ${ends.length} silence points → ${opts.outFile}`
    )
  })
}
