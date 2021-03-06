import * as core from '@actions/core'
import process from 'process'
import {get} from './src/downloader'

async function run(): Promise<void> {
  try {
    if (process.platform !== 'win32') {
      core.warning(
        `Skipping this Action because it only works on Windows, not on ${process.platform}`
      )
      return
    }
    const flavor = core.getInput('flavor')
    const architecture = core.getInput('architecture')
    const verbose = core.getInput('verbose')

    const {artifactName, download} = await get(flavor, architecture)
    const outputDirectory = core.getInput('path') || `C:/${artifactName}`

    core.info(`Downloading ${artifactName}`)
    await download(
      outputDirectory,
      verbose.match(/^\d+$/) ? parseInt(verbose) : verbose === 'true'
    )

    // Set up PATH so that Git for Windows' SDK's `bash.exe` is found
    core.addPath(`${outputDirectory}/usr/bin`)
    core.exportVariable(
      'MSYSTEM',
      architecture === 'i686' ? 'MING32' : 'MINGW64'
    )
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
