import fs from 'fs'
import https from 'https'
import {Readable} from 'stream'
import unzipper from 'unzipper'
import {spawn} from 'child_process'
import {delimiter} from 'path'

const gitForWindowsUsrBinPath = 'C:/Program Files/Git/usr/bin'
const gitForWindowsMINGW64BinPath = 'C:/Program Files/Git/mingw64/bin'

async function fetchJSONFromURL<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    https
      .request(url, {}, res => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              `Got code ${res.statusCode}, URL: ${url}, message: ${res.statusMessage}`
            )
          )
          return
        }
        const data: Uint8Array[] = []
        res
          .on('data', (chunk: Uint8Array) => data.push(chunk))
          .on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(data).toString('utf-8')))
            } catch (e) {
              reject(e)
            }
          })
          .on('error', e => reject(e))
      })
      .on('error', e => reject(e))
      .end()
  })
}

function mkdirp(directoryPath: string): void {
  try {
    const stat = fs.statSync(directoryPath)
    if (stat.isDirectory()) {
      return
    }
    throw new Error(`${directoryPath} exists, but is not a directory`)
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      throw e
    }
  }
  fs.mkdirSync(directoryPath, {recursive: true})
}

async function unzip(
  url: string,
  stripPrefix: string,
  outputDirectory: string,
  verbose: boolean | number,
  downloader?: (
    _url: string,
    directory: string,
    _verbose: boolean | number
  ) => Promise<void>
): Promise<void> {
  let progress =
    verbose === false
      ? (): void => {}
      : (path: string): void => {
          path === undefined || process.stderr.write(`${path}\n`)
        }
  if (typeof verbose === 'number') {
    let counter = 0
    progress = (path?: string): void => {
      if (path === undefined || ++counter % verbose === 0) {
        process.stderr.write(`${counter} items extracted\n`)
      }
    }
  }
  mkdirp(outputDirectory)

  if (downloader) {
    // `https.get()` seems to have performance problems that cause frequent
    // ECONNRESET problems with larger payloads. Let's (ab-)use Git for Windows'
    // `curl.exe` to do the downloading for us in that case.
    return await downloader(url, outputDirectory, verbose)
  }

  return new Promise<void>((resolve, reject) => {
    https.get(url, (res: Readable): void => {
      res
        .pipe(unzipper.Parse())
        .on('entry', entry => {
          if (!entry.path.startsWith(stripPrefix)) {
            process.stderr.write(
              `warning: skipping ${entry.path} because it does not start with ${stripPrefix}\n`
            )
          }
          const entryPath = `${outputDirectory}/${entry.path.substring(
            stripPrefix.length
          )}`
          progress(entryPath)
          if (entryPath.endsWith('/')) {
            mkdirp(entryPath.replace(/\/$/, ''))
            entry.autodrain()
          } else {
            entry.pipe(fs.createWriteStream(`${entryPath}`))
          }
        })
        .on('error', reject)
        .on('finish', progress)
        .on('finish', resolve)
    })
  })
}

/* We're (ab-)using Git for Windows' `tar.exe` and `xz.exe` to do the job */
async function unpackTarXZInZipFromURL(
  url: string,
  outputDirectory: string,
  verbose: boolean | number = false
): Promise<void> {
  const tmp = await fs.promises.mkdtemp(`${outputDirectory}/tmp`)
  const zipPath = `${tmp}/artifacts.zip`
  const curl = spawn(
    `${gitForWindowsMINGW64BinPath}/curl.exe`,
    ['-o', zipPath, url],
    {stdio: [undefined, 'inherit', 'inherit']}
  )
  await new Promise<void>((resolve, reject) => {
    curl
      .on('close', code =>
        code === 0 ? resolve() : reject(new Error(`${code}`))
      )
      .on('error', e => reject(new Error(`${e}`)))
  })

  const zipContents = (await unzipper.Open.file(zipPath)).files.filter(
    e => !e.path.endsWith('/')
  )
  if (zipContents.length !== 1) {
    throw new Error(
      `${zipPath} does not contain exactly one file (${zipContents.map(
        e => e.path
      )})`
    )
  }

  // eslint-disable-next-line no-console
  console.log(`unzipping ${zipPath}\n`)
  const tarXZ = spawn(
    `${gitForWindowsUsrBinPath}/bash.exe`,
    [
      '-lc',
      `unzip -p "${zipPath}" ${zipContents[0].path} | tar ${
        verbose === true ? 'xJvf' : 'xJf'
      } -`
    ],
    {
      cwd: outputDirectory,
      env: {
        CHERE_INVOKING: '1',
        MSYSTEM: 'MINGW64',
        PATH: `${gitForWindowsUsrBinPath}${delimiter}${process.env.PATH}`
      },
      stdio: [undefined, 'inherit', 'inherit']
    }
  )
  await new Promise<void>((resolve, reject) => {
    tarXZ.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar: exited with code ${code}`))
      }
    })
  })
  await fs.promises.rmdir(tmp, {recursive: true})
}

export async function get(
  flavor: string,
  architecture: string
): Promise<{
  artifactName: string
  id: string
  download: (
    outputDirectory: string,
    verbose?: number | boolean
  ) => Promise<void>
}> {
  if (!['x86_64', 'i686'].includes(architecture)) {
    throw new Error(`Unsupported architecture: ${architecture}`)
  }

  let definitionId: number
  let artifactName: string
  switch (flavor) {
    case 'minimal':
      if (architecture === 'i686') {
        throw new Error(`Flavor "minimal" is only available for x86_64`)
      }
      definitionId = 22
      artifactName = 'git-sdk-64-minimal'
      break
    case 'makepkg-git':
      if (architecture === 'i686') {
        throw new Error(`Flavor "makepkg-git" is only available for x86_64`)
      }
      definitionId = 29
      artifactName = 'git-sdk-64-makepkg-git'
      break
    case 'build-installers':
    case 'full':
      definitionId = architecture === 'i686' ? 30 : 29
      artifactName = `git-sdk-${architecture === 'i686' ? 32 : 64}-${
        flavor === 'full' ? 'full-sdk' : flavor
      }`
      break
    default:
      throw new Error(`Unknown flavor: '${flavor}`)
  }

  const baseURL = 'https://dev.azure.com/git-for-windows/git/_apis/build/builds'
  const data = await fetchJSONFromURL<{
    count: number
    value: [{id: string; downloadURL: string}]
  }>(
    `${baseURL}?definitions=${definitionId}&statusFilter=completed&resultFilter=succeeded&$top=1`
  )
  if (data.count !== 1) {
    throw new Error(`Unexpected number of builds: ${data.count}`)
  }
  const id = `${artifactName}-${data.value[0].id}`
  const download = async (
    outputDirectory: string,
    verbose: number | boolean = false
  ): Promise<void> => {
    const data2 = await fetchJSONFromURL<{
      count: number
      value: [{name: string; resource: {downloadUrl: string}}]
    }>(`${baseURL}/${data.value[0].id}/artifacts`)
    const filtered = data2.value.filter(e => e.name === artifactName)
    if (filtered.length !== 1) {
      throw new Error(
        `Could not find ${artifactName} in ${JSON.stringify(data2, null, 4)}`
      )
    }
    const url = filtered[0].resource.downloadUrl
    await unzip(
      url,
      `${artifactName}/`,
      outputDirectory,
      verbose,
      flavor === 'full' ? unpackTarXZInZipFromURL : undefined
    )
  }
  return {artifactName, download, id}
}
